// Cutover verification: the twenty questions worth asking the moment DNS has moved.
//
// Every check here is pure over the cutover context built by `../cutover.mjs`, which is the
// launch-audit context plus the six things only cutover day has: the baseline taken before the
// launch, the redirect map the audit wrote, the expected DNS targets, a sample of what the public
// resolvers currently answer, the staging host, and the old host. Nothing below fetches.
//
// `CUTOVER_ORDER` is the order these are read on the day, which is the dependency order of the
// launch itself: if DNS has not moved there is nothing to check, if the certificate is wrong
// nobody reaches the site, if the noindex is still there nothing else matters this week. The
// report renders the section in that order, and the one blocker in the list is bolded inside it —
// but the summary a person reads still sorts by severity, because a blocker is a blocker wherever
// it falls in the day.
//
// Two rules shape the severities. `cutover.noindex-live` and `cutover.https-cert-host` are the
// only blockers, because they are the two states where the launch has not actually happened: a
// site nobody can reach, and a site search engines are told to forget. Everything else is a `high`
// that somebody fixes today, a `medium` that somebody explains, or an `info` that somebody reads.
//
// The three baseline checks (`baseline-missing-page`, `baseline-changed`, `baseline-new-redirect`)
// are silent when no baseline was given rather than reporting a clean diff — "we did not compare"
// and "nothing changed" are different answers, and the run says which in `Not covered`.

import { defineCheck } from '../../../../launch-audit/scripts/lib/registry.mjs'
import { isAllowed } from '../../../../launch-audit/scripts/lib/robots.mjs'
import { detectAnalytics, isCollectorUrl } from '../../../../launch-audit/scripts/lib/detect/analytics.mjs'
import { DEV_HOSTS, hostPattern } from '../../../../launch-audit/scripts/lib/detect/placeholders.mjs'

const PHASE = 'post-launch'
const DIMENSION = 'cutover'
const TIER = 'http'
const EVIDENCE_LIMIT = 10

// Statuses a form endpoint is allowed to answer a GET with. 405 is the healthy answer from an
// endpoint that only accepts POST, which is most of them; nothing here ever submits one.
const FORM_OK_STATUS = (status) => (status >= 200 && status < 400) || status === 405

const url = (value) => ({ type: 'url', value })
const status = (value) => ({ type: 'status', value })
const header = (value) => ({ type: 'header', value })
const html = (value) => ({ type: 'html', value })
const text = (value) => ({ type: 'text', value })
const cert = (value) => ({ type: 'cert', value })
const dnsEvidence = (value) => ({ type: 'dns', value })

const define = (def) => defineCheck({ phase: PHASE, dimension: DIMENSION, tier: TIER, ...def })
const emit = (check, overrides) => check.mk({ title: check.title, ...overrides })

// ------------------------------------------------------------------------------------- helpers

const hostOf = (value) => {
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return null
  }
}

const pathOf = (value) => {
  try {
    const parsed = new URL(value)
    return parsed.pathname + parsed.search
  } catch {
    return null
  }
}

// A url compared the way a redirect target is compared: scheme and host lowercased, a single
// trailing slash on the path ignored, a fragment dropped. `/about` and `/about/` are the same
// destination as far as a redirect map is concerned.
function normalizeTarget(value) {
  try {
    const parsed = new URL(value)
    const path = parsed.pathname.length > 1 && parsed.pathname.endsWith('/')
      ? parsed.pathname.slice(0, -1)
      : parsed.pathname
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`
  } catch {
    return typeof value === 'string' ? value.trim() : ''
  }
}

const samePath = (a, b) => {
  const strip = (p) => (typeof p === 'string' && p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p)
  return strip(a) === strip(b)
}

const isProductionHost = (ctx, host) =>
  host !== null && (host === ctx.target.host || host === ctx.target.apex || host === ctx.target.www)

// A host that is not production, and is recognisably somebody's staging or development copy: the
// `--staging-url` host, a `--dev-host` the operator named, or one of the built-in dev-host
// patterns. A production sitemap that lists one of these is advertising the wrong site.
function nonProductionReason(ctx, host) {
  if (host === null || isProductionHost(ctx, host)) return null
  const staging = ctx.stagingHost
  if (staging !== null && (host === staging || host.endsWith(`.${staging}`))) return `the staging host ${staging}`
  for (const configured of ctx.target.devHosts ?? []) {
    const pattern = hostPattern(configured)
    if (pattern !== null && pattern.test(host)) return `the declared dev host "${configured}"`
  }
  for (const pattern of DEV_HOSTS) if (pattern.test(host)) return 'a development or preview host'
  return null
}

const ABSOLUTE_URL = /https?:\/\/[^\s"'<>)]+/gi

const startPage = (ctx) => ctx.crawl.pages.find((p) => p.url === ctx.target.url) ?? null
const bodyOf = (entry) => (typeof entry?.response?.body === 'string' ? entry.response.body : '')
const directive = (value, name) => new RegExp(`(^|[,\\s])${name}([,\\s]|$)`, 'i').test(String(value ?? ''))
const ok2xx = (response) => !!response && response.status >= 200 && response.status < 300

// Every resolver answer for one host, as one readable line each.
const describeAnswer = (answer) => {
  const parts = []
  if (answer.a.length > 0) parts.push(`A ${answer.a.join(' ')}`)
  if (answer.aaaa.length > 0) parts.push(`AAAA ${answer.aaaa.join(' ')}`)
  if (answer.cname !== null) parts.push(`CNAME ${answer.cname}`)
  if (parts.length === 0) parts.push(answer.error === null ? 'no answer' : `no answer (${answer.error})`)
  return parts.join(', ')
}

const normalizeValue = (value) => String(value).trim().toLowerCase().replace(/\.$/, '')
const answerSet = (answer) => [...answer.a, ...answer.aaaa, ...(answer.cname === null ? [] : [answer.cname])]
  .map(normalizeValue).sort()
const signature = (answer) => answerSet(answer).join(' ')

// A resolver that could not be reached knows nothing, and knowing nothing is not the same as
// answering wrongly. An errored row is excluded from both "does this match what was expected" and
// "do the resolvers agree with each other", and the count of them is reported in Not covered
// instead — otherwise a firewalled resolver would read as a failed cutover.
const answered = (answers) => answers.filter((answer) => answer.error === null)

// Does this resolver's answer contain everything that was expected? Containment, not equality: a
// host on a CNAME answers with the CNAME *and* the A records it resolves to, so a correct
// `www=cname.host` configuration has strictly more in it than was asked for. Extra answers are how
// DNS works; a missing expected value is the finding.
const carries = (answer, expected) => {
  const set = answerSet(answer)
  return expected.every((value) => set.includes(value))
}

// The apex and www hosts this run resolved, paired with the `--expect-dns` key that names each.
const dnsTargets = (ctx) => [
  { key: 'apex', host: ctx.target.apex },
  ...(ctx.target.hasWwwCounterpart ? [{ key: 'www', host: ctx.target.www }] : []),
]

// ----------------------------------------------------------------------------------- 1. DNS

export const dnsUnexpected = define({
  id: 'cutover.dns-unexpected',
  severity: 'high',
  title: 'A resolver answers with something other than the expected target',
  catches: 'DNS that has not moved, or has moved to the wrong record, seen from a public resolver rather than from this machine.',
  run(ctx) {
    if (ctx.expectDns === null || ctx.dnsAcross === null) return []
    const out = []
    for (const { key, host } of dnsTargets(ctx)) {
      const expected = (ctx.expectDns[key] ?? []).map(normalizeValue).filter((v) => v !== '')
      if (expected.length === 0) continue
      const answers = answered(ctx.dnsAcross[host] ?? [])
      if (answers.length === 0) continue
      const wrong = answers.filter((answer) => !carries(answer, expected))
      if (wrong.length === 0) continue
      out.push(emit(dnsUnexpected, {
        page: `https://${host}/`,
        detail: `${wrong.length} of the ${answers.length} public resolvers that answered for ${host} do not carry ${expected.join(', ')}. Until every resolver has it, some share of visitors is still being sent to the old host — and everything else in this report describes whichever host answered here, not necessarily the one they reach.`,
        evidence: [
          text(`expected ${key}: ${expected.join(', ')}`),
          ...wrong.slice(0, EVIDENCE_LIMIT).map((answer) => dnsEvidence(`${answer.resolver} → ${describeAnswer(answer)}`)),
        ],
        fix: `Check the ${key} record at the registrar or DNS provider, and wait out the TTL that was in place before the change. If the record is already right, this is propagation and it resolves itself.`,
      }))
    }
    return out
  },
})

export const dnsPropagation = define({
  id: 'cutover.dns-propagation',
  severity: 'info',
  title: 'What each public resolver currently answers',
  catches: 'The propagation picture: the same question asked of Google, Cloudflare, Quad9 and OpenDNS, and whether their answers agree yet.',
  run(ctx) {
    if (ctx.dnsAcross === null) return []
    const lines = []
    const disagreeing = []
    // Resolvers that could not be reached at all, deduped across the hosts asked: one firewalled
    // resolver is one gap in the sample, not one gap per host.
    const unreachable = new Map()
    for (const { host } of dnsTargets(ctx)) {
      const answers = ctx.dnsAcross[host] ?? []
      if (answers.length === 0) continue
      for (const answer of answers) {
        lines.push(dnsEvidence(`${host} @ ${answer.resolver} → ${describeAnswer(answer)}`))
        if (answer.error !== null) unreachable.set(answer.resolver, answer.error)
      }
      // Only the resolvers that actually answered can disagree with each other.
      const replied = answered(answers)
      if (new Set(replied.map(signature)).size > 1) disagreeing.push(host)
    }
    if (lines.length === 0) return { findings: [], notCovered: [] }

    const asked = new Set()
    for (const { host } of dnsTargets(ctx)) for (const answer of ctx.dnsAcross[host] ?? []) asked.add(answer.resolver)
    const notCovered = unreachable.size === 0 ? [] : [
      `DNS: ${unreachable.size} of ${asked.size} public resolvers could not be reached (${[...unreachable].map(([ip, error]) => `${ip}: ${error}`).join(', ')})`,
    ]

    const split = disagreeing.length > 0
    return { notCovered, findings: [emit(dnsPropagation, {
      severity: split ? 'high' : 'info',
      page: ctx.target.url,
      title: split ? 'Public resolvers still disagree about where this site is' : 'What each public resolver currently answers',
      detail: split
        ? `${disagreeing.join(' and ')} resolves differently depending on which public resolver is asked, so the cutover is part way through. Some visitors are reaching the new host and some are still reaching the old one, which means a form submitted right now may land in either place. Re-run this once the answers agree.`
        : 'Every public resolver asked gives the same answer for this site, which is what a finished propagation looks like. The records below are what a visitor using each of those resolvers is being sent to right now.',
      evidence: lines.slice(0, EVIDENCE_LIMIT * 2),
      fix: split
        ? 'Wait out the TTL that was in place before the change, and keep the old host serving until the answers converge.'
        : 'Nothing to do. Keep the old host up anyway until Search Console stops crawling its urls.',
    })] }
  },
})

// ----------------------------------------------------------------------------- 2. Transport

export const httpsCertHost = define({
  id: 'cutover.https-cert-host',
  severity: 'blocker',
  title: 'The certificate served does not cover the live host',
  catches: 'A certificate that did not validate, or that was issued before the host moved and never covered it — every visitor gets an interstitial warning.',
  run(ctx) {
    const at = `https://${ctx.target.host}/`
    // A run with no certificate reader saw no certificate. Saying nothing here would read exactly
    // like a certificate that checked out, which is the one thing it must not read like.
    if (!ctx.cert) {
      return {
        findings: [],
        notCovered: [`TLS certificate: not read — nothing confirmed the certificate served on ${ctx.target.host} covers it`],
      }
    }
    if (ctx.cert.valid !== true) {
      return [emit(httpsCertHost, {
        page: at,
        detail: 'The certificate served for the production host does not validate, so every visitor sees a full-page browser warning before they see the site. As far as anybody arriving today is concerned, the launch has not happened.',
        evidence: [url(at), cert(`certificate did not validate${ctx.cert.error ? `: ${ctx.cert.error}` : ''}`)],
        fix: 'Issue a certificate for this host from a public CA and install it with its full chain. On a managed host this usually means re-adding the domain so the platform requests one.',
      })]
    }
    const names = (ctx.cert.altNames ?? []).map((name) => String(name).toLowerCase())
    if (names.length === 0) {
      return {
        findings: [],
        notCovered: [`TLS certificate: not read — the certificate for ${ctx.target.host} reported no subject alternative names, so nothing confirmed which hosts it covers`],
      }
    }
    const covers = (host) => names.some((candidate) => {
      if (candidate === host) return true
      if (!candidate.startsWith('*.')) return false
      const suffix = candidate.slice(1)
      return host.endsWith(suffix) && !host.slice(0, -suffix.length).includes('.')
    })
    if (covers(ctx.target.host)) return []
    return [emit(httpsCertHost, {
      page: at,
      detail: `The certificate served on this host lists ${names.join(', ')}, which does not include ${ctx.target.host}. Every visitor gets a name-mismatch warning, which no ordinary person clicks through.`,
      evidence: [url(at), cert(`altNames: ${names.join(', ')}`), text(`not covered: ${ctx.target.host}`)],
      fix: `Reissue the certificate with ${ctx.target.host} in its SAN list — and with the other host variant too, so the redirect between them is also served over a valid certificate.`,
    })]
  },
})

export const httpRedirect = define({
  id: 'cutover.http-redirect',
  severity: 'high',
  title: 'http:// does not permanently redirect to https://',
  catches: 'A plain-http origin still serving the site, or redirecting temporarily, after the cutover.',
  run(ctx) {
    const probe = ctx.probes.httpRoot
    if (!probe || probe.status === 0) return [] // http is not answering at all, which is fine
    const chain = probe.chain ?? []
    const first = chain[0]
    const permanent = first !== undefined && (first.status === 301 || first.status === 308)
    const arrivesOnHttps = String(probe.finalUrl ?? '').startsWith('https://')
    if (permanent && arrivesOnHttps) return []
    return [emit(httpRedirect, {
      page: probe.url,
      detail: chain.length === 0
        ? `${probe.url} answers ${probe.status} without redirecting. Every old link, every printed url and every person who types the bare domain gets an unencrypted page, and search engines see two copies of the site.`
        : `${probe.url} redirects with ${first.status}, which is temporary, and lands on ${probe.finalUrl}. Browsers and search engines keep asking for the http url rather than remembering the move.`,
      evidence: [
        url(probe.url),
        status(chain.length === 0 ? `HTTP ${probe.status} with no redirect` : `HTTP ${first.status} → ${probe.finalUrl}`),
      ],
      fix: 'Return 301 (or 308) from every http:// url to the same path on https://, at the edge rather than in the application.',
    })]
  },
})

export const canonicalHost = define({
  id: 'cutover.canonical-host',
  severity: 'high',
  title: 'www and apex are not one canonical host',
  catches: 'Both host variants serving the site after the cutover, or the other variant failing instead of redirecting.',
  run(ctx) {
    if (!ctx.target.hasWwwCounterpart) return []
    const { wwwRoot, apexRoot } = ctx.probes
    if (!wwwRoot || !apexRoot) return []

    if (ok2xx(wwwRoot) && ok2xx(apexRoot) && hostOf(wwwRoot.finalUrl) !== hostOf(apexRoot.finalUrl)) {
      return [emit(canonicalHost, {
        page: ctx.target.origin,
        detail: 'Both host variants answer 200 on their own, so the site now lives at two addresses. Links, rankings and analytics divide between them, and search engines have to guess which one is the real site.',
        evidence: [
          url(`${wwwRoot.url} → HTTP ${wwwRoot.status} (${wwwRoot.finalUrl})`),
          url(`${apexRoot.url} → HTTP ${apexRoot.status} (${apexRoot.finalUrl})`),
          text('neither variant redirects to the other'),
        ],
        fix: 'Pick one canonical host and 301 every url on the other to the matching url on it. Do it at the edge, and make sure the certificate covers both.',
      })]
    }

    const onWww = ctx.target.host === ctx.target.www
    const other = onWww ? apexRoot : wwwRoot
    if (ok2xx(other) && hostOf(other.finalUrl) === ctx.target.host) return []
    if (ok2xx(other)) return [] // it serves the site under the same host: the split branch above owns that
    if ((other.chain?.length ?? 0) > 0 && hostOf(other.finalUrl) === ctx.target.host) return []
    return [emit(canonicalHost, {
      page: other.url,
      detail: `${other.url} neither serves the site nor redirects to ${ctx.target.host}. Anyone who types that variant, or follows an old link or a printed card carrying it, gets an error on launch day.`,
      evidence: [
        url(other.url),
        status(`HTTP ${other.status}${other.error ? ` (${other.error})` : ''}`),
        text(`the canonical host is ${ctx.target.host}`),
      ],
      fix: `Serve a 301 from ${other.url} to the matching url on ${ctx.target.host}.`,
    })]
  },
})

// -------------------------------------------------------------------------- 3. Noindex gone

export const noindexLive = define({
  id: 'cutover.noindex-live',
  severity: 'blocker',
  title: 'Production still tells search engines not to index it',
  catches: 'The staging noindex — meta, X-Robots-Tag or a blanket robots.txt Disallow — shipped to the live host.',
  run(ctx) {
    const evidence = []
    const home = startPage(ctx)
    if (home !== null) {
      const meta = home.page?.head.robots ?? ''
      if (directive(meta, 'noindex')) evidence.push(html(`<meta name="robots" content="${meta}">`))
      const headerValue = home.response?.headers?.['x-robots-tag']
      if (directive(headerValue, 'noindex')) evidence.push(header(`x-robots-tag: ${headerValue}`))
    }
    if (ctx.robots.parsed && !isAllowed(ctx.robots.parsed, '*', '/')) {
      evidence.push(text(`${ctx.robots.url} blocks every crawler at the site root: "Disallow: /"`))
    }
    if (evidence.length === 0) return []
    return [emit(noindexLive, {
      page: ctx.target.url,
      detail: 'The live site is asking search engines to stay away. This is the setting that made staging invisible, and it has shipped to production — which means the launch is invisible too, and every day it stays is a day of lost crawling that does not come back on its own.',
      evidence: [url(ctx.target.url), ...evidence],
      fix: 'Remove the noindex from the production deployment — the meta tag, the X-Robots-Tag header, or the robots.txt Disallow, whichever this evidence names — redeploy, confirm it is gone, then request indexing for the top pages in Search Console.',
    })]
  },
})

// ------------------------------------------------------------- 4. Robots and sitemap, live

export const robotsLive = define({
  id: 'cutover.robots-live',
  severity: 'high',
  title: 'robots.txt on the live host is missing or points somewhere else',
  catches: 'A robots.txt the production host does not serve, or one still naming the staging host.',
  run(ctx) {
    if (ctx.robots.status !== 200) {
      return [emit(robotsLive, {
        page: ctx.robots.url,
        detail: `${ctx.robots.url} answers ${ctx.robots.status} rather than serving a robots.txt. Crawlers fetch it before anything else, and without it nothing on the live host advertises the sitemap.`,
        evidence: [url(ctx.robots.url), status(`HTTP ${ctx.robots.status}`)],
        fix: 'Serve a robots.txt from the production host with a Sitemap: line pointing at the production sitemap.',
      })]
    }
    const leaks = []
    for (const match of String(ctx.robots.text ?? '').matchAll(ABSOLUTE_URL)) {
      const reason = nonProductionReason(ctx, hostOf(match[0]))
      if (reason !== null) leaks.push({ href: match[0], reason })
    }
    if (leaks.length === 0) return []
    return [emit(robotsLive, {
      page: ctx.robots.url,
      detail: `The live robots.txt points at ${leaks.length} url${leaks.length === 1 ? ' that is' : 's that are'} not on the production host. Whatever it names there is what crawlers go and fetch, so the live site is advertising a copy of itself that nobody meant to publish.`,
      evidence: [url(ctx.robots.url), ...leaks.slice(0, EVIDENCE_LIMIT).map((leak) => text(`${leak.href} — ${leak.reason}`))],
      fix: 'Rewrite robots.txt on the production deployment so every url in it is on the production host, and redeploy.',
    })]
  },
})

export const sitemapLive = define({
  id: 'cutover.sitemap-live',
  severity: 'high',
  title: 'No sitemap answers on the live host',
  catches: 'A sitemap that did not survive the cutover: none discoverable, or the one robots.txt names not answering 200.',
  run(ctx) {
    const found = ctx.sitemaps.found ?? []
    if (found.length > 0 && found[0].status === 200) return []
    const tried = (ctx.sitemaps.candidates ?? []).slice(0, EVIDENCE_LIMIT)
    return [emit(sitemapLive, {
      page: ctx.target.origin,
      detail: found.length === 0
        ? 'Nothing that answers as a sitemap could be found on the live host: not at any conventional path, and not at whatever robots.txt names. Search Console has nothing to process, so the new urls are discovered only by crawling — which is exactly the slow path a launch cannot afford.'
        : `The sitemap at ${found[0].url} answers ${found[0].status}.`,
      evidence: [
        url(ctx.target.origin),
        ...(tried.length === 0 ? [text('no sitemap candidates were probed')] : tried.map((candidate) => url(`tried ${candidate}`))),
      ],
      fix: 'Deploy the sitemap to the production host, name it from robots.txt, confirm it fetches, then submit it in Search Console and Bing Webmaster Tools.',
    })]
  },
})

export const sitemapReferencesStaging = define({
  id: 'cutover.sitemap-references-staging',
  severity: 'high',
  title: 'The live sitemap or robots.txt advertises a non-production host',
  catches: 'Sitemap <loc> entries, or a robots.txt Sitemap: line, still pointing at staging after the cutover — an invitation to index the wrong copy.',
  run(ctx) {
    const leaks = []
    const seen = new Set()
    const consider = (href, where) => {
      const reason = nonProductionReason(ctx, hostOf(href))
      if (reason === null || seen.has(href)) return
      seen.add(href)
      leaks.push({ href, reason, where })
    }
    for (const line of ctx.robots.parsed?.sitemaps ?? []) consider(line, 'robots.txt Sitemap:')
    for (const loc of ctx.sitemaps.urls ?? []) consider(loc, 'sitemap <loc>')
    if (leaks.length === 0) return []
    return [emit(sitemapReferencesStaging, {
      page: ctx.target.origin,
      detail: `${leaks.length} url${leaks.length === 1 ? ' advertised from the live host is' : 's advertised from the live host are'} not on the production host. A sitemap is a request to index exactly these urls, so this is the live site asking search engines to index a staging copy — which is duplicate content competing with the launch.`,
      evidence: [
        url(ctx.target.origin),
        ...leaks.slice(0, EVIDENCE_LIMIT).map((leak) => text(`${leak.where} ${leak.href} — ${leak.reason}`)),
      ],
      fix: 'Regenerate the sitemap with the production site url configured, fix the Sitemap: line in robots.txt, redeploy, and re-submit the sitemap in Search Console.',
    })]
  },
})

// ------------------------------------------------------------------------------ 5. Redirects

// Which rows can be verified at all, and what each one promised. A row the audit could not
// classify (`error`, `unknown`) promised nothing, so nothing here holds it to anything; the run
// counts those into `Not covered` instead.
export const VERIFIABLE = new Set(['same-path-200', 'redirect-200', 'would-404', 'redirect-to-404'])

// What went wrong with one row, or null when it is still doing what the audit said it would.
export function redirectDriftOf(row, response) {
  if (response === undefined) return null
  const oldPath = pathOf(row.old_url)
  if (response.status === 0) return { kind: 'no-answer', detail: `nothing answered (${response.error ?? 'no response'})` }

  const chain = response.chain ?? []
  const hops = chain.length
  const landed = response.finalUrl ?? row.old_url

  if (row.status_on_new === 'same-path-200') {
    if (response.status >= 200 && response.status < 300 && samePath(pathOf(landed), oldPath)) return null
    return {
      kind: 'same-path',
      detail: response.status >= 200 && response.status < 300
        ? `it lands on ${landed}, a different path`
        : `it answers ${response.status}`,
    }
  }

  if (row.status_on_new === 'redirect-200') {
    const first = chain[0]
    if (first === undefined) {
      return { kind: 'no-redirect', detail: `it answers ${response.status} with no redirect at all` }
    }
    if (first.status !== 301 && first.status !== 308) {
      return { kind: 'temporary', detail: `the redirect answers ${first.status}, which is temporary` }
    }
    if (hops > 1) return { kind: 'chain', detail: `it takes ${hops} hops to reach ${landed}` }
    if (normalizeTarget(landed) !== normalizeTarget(row.final_url)) {
      return { kind: 'wrong-target', detail: `it lands on ${landed} rather than ${row.final_url}` }
    }
    return null
  }

  // would-404 / redirect-to-404: the audit flagged these before the launch. The only question now
  // is whether somebody fixed them.
  if (response.status < 400) return null
  return { kind: 'still-missing', detail: `it still answers ${response.status}` }
}

export const redirectDrift = define({
  id: 'cutover.redirect-drift',
  severity: 'high',
  title: 'A redirect no longer does what the redirect map says',
  catches: 'A row of redirects.csv that answers a temporary redirect, takes more than one hop, lands somewhere else, or is still missing.',
  run(ctx) {
    if (ctx.redirectRows === null) return []
    const out = []
    for (const row of ctx.redirectRows) {
      if (!VERIFIABLE.has(row.status_on_new)) continue
      const response = ctx.cutoverRedirects.get(row.old_url)
      const drift = redirectDriftOf(row, response)
      if (drift === null) continue
      // A url that answered nothing at all has not been shown to have drifted — it has not been
      // shown to do anything. That is redirect-unverified's finding, and calling it drift here
      // would send somebody off to rewrite a redirect rule that may be perfectly correct.
      if (drift.kind === 'no-answer') continue
      const chain = response.chain ?? []
      out.push(emit(redirectDrift, {
        page: row.old_url,
        detail: `The redirect map recorded ${row.old_url} as "${row.status_on_new}" pointing at ${row.final_url}. Re-requested now, ${drift.detail}. Every link and bookmark to that url — and the ranking it carried — depends on this one hop being a permanent redirect to the page that replaced it.`,
        evidence: [
          url(row.old_url),
          // Each hop by its own status, because "it answers 200" hides the 302 that got it there,
          // and the hop status is the whole finding on a row that drifted from permanent to
          // temporary.
          ...chain.slice(0, EVIDENCE_LIMIT).map((hop) => status(`${hop.url} → ${hop.status} → ${hop.location}`)),
          status(`HTTP ${response.status}${chain.length > 0 ? ` after ${chain.length} hop${chain.length === 1 ? '' : 's'}` : ''}`),
          url(`landed on ${response.finalUrl ?? row.old_url}`),
          text(`redirects.csv line ${row.line}: ${row.status_on_new} → ${row.final_url}`),
        ],
        fix: `Make ${row.old_url} answer a single 301 (or 308) to ${row.final_url}. One hop, permanent, at the edge — not a chain, not a 302, not a catch-all to the homepage.`,
      }))
    }
    return out
  },
})

export const redirectUnverified = define({
  id: 'cutover.redirect-unverified',
  severity: 'medium',
  title: 'A redirect row could not be checked at all',
  catches: 'An old url that answered nothing when it was re-requested — a DNS failure, a timeout, a refused connection. Unknown, not broken.',
  run(ctx) {
    if (ctx.redirectRows === null) return []
    const out = []
    for (const row of ctx.redirectRows) {
      if (!VERIFIABLE.has(row.status_on_new)) continue
      const response = ctx.cutoverRedirects.get(row.old_url)
      const drift = redirectDriftOf(row, response)
      if (drift === null || drift.kind !== 'no-answer') continue
      out.push(emit(redirectUnverified, {
        page: row.old_url,
        detail: `${row.old_url} did not answer when it was re-requested: ${drift.detail}. That is not the same as a redirect that drifted — nothing here has been shown to be wrong with it, and nothing has been shown to be right either. Mid-cutover the usual cause is that the old host's DNS has not settled yet; after that, it is a host that has already been switched off.`,
        evidence: [
          url(row.old_url),
          text(drift.detail),
          text(`redirects.csv line ${row.line}: ${row.status_on_new} → ${row.final_url}`),
        ],
        fix: 'Re-run this once DNS has settled. If the old host has already been decommissioned, that is the finding — the redirect map only works while something is still answering on it.',
      }))
    }
    return out
  },
})

// -------------------------------------------------------------------------- 6. Baseline diff

export const baselineMissingPage = define({
  id: 'cutover.baseline-missing-page',
  severity: 'high',
  title: 'A page the baseline recorded is no longer served',
  catches: 'A page that existed before the launch and that a crawl of production can no longer reach.',
  run(ctx) {
    if (ctx.baselineDiff === null) return []
    return ctx.baselineDiff.missingPages.map((page) => emit(baselineMissingPage, {
      page,
      detail: `${page} was part of the site the baseline recorded, and a crawl of production no longer reaches it. Either the page was dropped from the build, or nothing links to it and nothing lists it any more — and from a search engine's point of view those are the same thing.`,
      evidence: [url(page), text(`present in the baseline taken ${ctx.baseline.generatedAt}`), text('absent from this crawl of production')],
      fix: 'Restore the page, or — if it was meant to go — redirect its url to whatever replaced it and confirm the old url returns a 301 rather than a 404.',
    }))
  },
})

export const baselineChanged = define({
  id: 'cutover.baseline-changed',
  severity: 'medium',
  title: 'A page changed between the baseline and production',
  catches: 'A title, description, canonical, robots directive, h1 or schema type that is not what it was before the launch.',
  run(ctx) {
    if (ctx.baselineDiff === null) return []
    return ctx.baselineDiff.changed.map((change) => emit(baselineChanged, {
      page: change.url,
      detail: `The ${change.field} of ${change.url} is not what the baseline recorded. Some of these are the launch doing exactly what it was supposed to; the ones that matter are the changes nobody asked for — a canonical that moved, a title that reverted to the framework default, a robots directive that appeared.`,
      evidence: [
        url(change.url),
        text(`${change.field} before: ${change.before === null || change.before === '' ? '(none)' : change.before}`),
        text(`${change.field} now: ${change.after === null || change.after === '' ? '(none)' : change.after}`),
      ],
      fix: 'Confirm the change was intended. If it was not, put the previous value back — a canonical or a title that changes at launch costs the ranking that url had.',
    }))
  },
})

export const baselineNewRedirect = define({
  id: 'cutover.baseline-new-redirect',
  severity: 'medium',
  title: 'A page that used to be served directly now redirects',
  catches: 'A url in the baseline that answered on its own and now takes a hop — a url that other pages and search results still point at.',
  run(ctx) {
    if (ctx.baselineDiff === null) return []
    return ctx.baselineDiff.newRedirects.map((entry) => emit(baselineNewRedirect, {
      page: entry.url,
      detail: `${entry.url} answered directly when the baseline was taken and now redirects. That is fine as a destination change and expensive as an accident: every internal link, sitemap entry and search result pointing at this url now pays a round trip, and a chain forms the moment a second rule lands on it.`,
      evidence: [
        url(entry.url),
        ...entry.after.slice(0, EVIDENCE_LIMIT).map((hop) => status(`${hop.url} → ${hop.status} → ${hop.location}`)),
      ],
      fix: 'If the move was intended, update the internal links and the sitemap to point at the new url directly so nothing relies on the redirect. If it was not, serve the page at its own url again.',
    }))
  },
})

// ------------------------------------------------------------------------- 7. Analytics live

export const analyticsMissing = define({
  id: 'cutover.analytics-missing',
  severity: 'high',
  title: 'An analytics tag that was there before is missing now',
  catches: 'A measurement tag lost in the cutover — the launch runs unmeasured, and the gap in the data is permanent.',
  run(ctx) {
    if (ctx.baselineDiff !== null) {
      return ctx.baselineDiff.analyticsLost.map((entry) => emit(analyticsMissing, {
        page: entry.url,
        detail: `${entry.url} carried ${entry.tags.join(', ')} when the baseline was taken and carries no analytics tag now. Every visit to this page since the cutover is unrecorded, and no analytics product backfills — whatever this page did during launch week is simply gone.`,
        evidence: [url(entry.url), text(`missing: ${entry.tags.join(', ')}`), text(`present in the baseline taken ${ctx.baseline.generatedAt}`)],
        fix: 'Put the tag back in the layout this page uses, redeploy, then watch the real-time report while you load the page yourself.',
      }))
    }

    const expected = ctx.options.expectAnalytics
    if (typeof expected !== 'string' || expected === '') return []
    const home = startPage(ctx)
    if (home === null) return []
    const body = bodyOf(home)
    if (body.includes(expected)) return []
    const found = [...new Set(detectAnalytics(body).map((hit) => hit.name))]
    return [emit(analyticsMissing, {
      page: ctx.target.url,
      detail: `The measurement id ${expected} does not appear anywhere in the source of ${ctx.target.url}. ${found.length === 0 ? 'No analytics tag of any kind was detected on the page.' : `What is installed instead: ${found.join(', ')}.`} There was no baseline to compare against, so this is the id you named on the command line and nothing more — but a launch measuring nothing is a launch nobody can report on.`,
      evidence: [url(ctx.target.url), text(`expected id: ${expected}`), text(found.length === 0 ? 'no analytics tag detected' : `detected instead: ${found.join(', ')}`)],
      fix: 'Add the tag to the site layout with the production measurement id, redeploy, and confirm a hit arrives in the real-time report.',
    })]
  },
})

export const analyticsNotFiring = define({
  id: 'cutover.analytics-not-firing',
  severity: 'high',
  tier: 'browser',
  title: 'The analytics tag is installed and never sends a hit',
  catches: 'A tag present in the markup whose collector is never called when the page actually renders — consent gating, a blocked script, a bad id.',
  run(ctx) {
    if (ctx.browser?.available !== true) return []
    const render = ctx.browser.renders?.get(ctx.target.url)
    if (!render) return []
    const home = startPage(ctx)
    if (home === null) return []
    const tags = [...new Set(detectAnalytics(bodyOf(home)).map((hit) => hit.name))]
    if (tags.length === 0) return []
    const hits = (render.collectorHits ?? []).filter(isCollectorUrl)
    if (hits.length > 0) return []
    return [emit(analyticsNotFiring, {
      page: ctx.target.url,
      detail: `${tags.join(', ')} ${tags.length === 1 ? 'is' : 'are'} in the source of this page, and rendering it in a browser produced no request to any of their collectors. The tag is installed and not measuring: usually a consent banner holding it back, a content-security-policy blocking the script, or a measurement id that does not exist yet.`,
      evidence: [url(ctx.target.url), text(`installed: ${tags.join(', ')}`), text('no collector request observed during the page render')],
      fix: 'Load the page yourself with the network panel open and find where the hit stops — consent, CSP, or the id. Then watch the real-time report until a visit of your own appears in it.',
    })]
  },
})

// ----------------------------------------------------------------------------- 8. Forms live

export const formEndpointDown = define({
  id: 'cutover.form-endpoint-down',
  severity: 'high',
  title: 'A form endpoint does not answer',
  catches: 'A form action or a third-party form embed that stopped resolving at the cutover — the site looks fine and every submission is lost.',
  run(ctx) {
    const out = []
    const consider = (endpoint, response, kind) => {
      if (!response) return
      if (response.status !== 0 && FORM_OK_STATUS(response.status)) return
      out.push(emit(formEndpointDown, {
        page: endpoint,
        detail: `${endpoint} is ${kind === 'embed' ? 'the source of a form embed' : 'the destination of a form'} on this site, and it answers ${response.status === 0 ? `nothing (${response.error ?? 'no response'})` : response.status}. The form still renders, so nothing on the page looks wrong — every submission from launch day onwards is simply lost, and nobody finds out until somebody asks why the enquiries stopped.`,
        evidence: [
          url(endpoint),
          status(response.status === 0 ? `no response (${response.error ?? 'unknown'})` : `HTTP ${response.status}`),
          text(kind === 'embed' ? 'referenced as a form embed by a crawled page' : 'named as a form action by a crawled page'),
        ],
        fix: 'Fix the endpoint, then submit the form yourself and have the person who owns the inbox confirm they received it. A 200 from a script is not a delivered enquiry.',
      }))
    }
    for (const [endpoint, response] of ctx.formEndpoints ?? new Map()) consider(endpoint, response, 'action')
    for (const [endpoint, response] of ctx.probes.embeds ?? new Map()) consider(endpoint, response, 'embed')
    return out
  },
})

// -------------------------------------------------------------------------- 9. Staging sealed

export const stagingStillIndexable = define({
  id: 'cutover.staging-still-indexable',
  severity: 'high',
  title: 'The staging copy is still live and still indexable',
  catches: 'A staging host that answers 200 with no noindex and no redirect — a full duplicate of the new site, competing with it.',
  run(ctx) {
    const probe = ctx.stagingProbe
    if (probe === null || probe.response.status !== 200) return []
    if (isProductionHost(ctx, hostOf(probe.response.finalUrl))) return []

    const body = typeof probe.response.body === 'string' ? probe.response.body : ''
    if (/<meta[^>]+name=["']?robots["']?[^>]*noindex/i.test(body)) return []
    if (directive(probe.response.headers?.['x-robots-tag'], 'noindex')) return []
    if (probe.robots?.parsed && !isAllowed(probe.robots.parsed, '*', '/')) return []

    return [emit(stagingStillIndexable, {
      page: probe.url,
      detail: `${probe.url} answers 200, carries no noindex, is not disallowed by its own robots.txt, and does not redirect to production. It is a complete second copy of the site that search engines may index — and when they have to choose between two identical sites, they do not always choose the one you launched.`,
      evidence: [
        url(probe.url),
        status(`HTTP ${probe.response.status}`),
        text(probe.robots === null || probe.robots.status !== 200 ? 'no robots.txt on the staging host' : 'the staging robots.txt does not disallow crawling'),
      ],
      fix: 'Take the staging host down, put it behind authentication, return 410, or redirect it to production. A noindex meta tag is the weakest of these and the only one that still serves the content.',
    })]
  },
})

// ------------------------------------------------------------------------------- 10. Old host

export const oldHostServingContent = define({
  id: 'cutover.old-host-serving-content',
  severity: 'high',
  title: 'The old host is still serving its own site',
  catches: 'An old domain that answers with its own pages after the cutover instead of redirecting to the new one.',
  run(ctx) {
    const probe = ctx.oldRootProbe
    if (probe === null || probe.status !== 200) return []
    if (isProductionHost(ctx, hostOf(probe.finalUrl))) return []
    return [emit(oldHostServingContent, {
      page: probe.url,
      detail: `${probe.url} still answers with the old site rather than redirecting to ${ctx.target.origin}. Two sites are now live with the same content and the same purpose: search engines split the ranking between them, old links keep people on the old one, and any form on it delivers somewhere nobody is watching.`,
      evidence: [url(probe.url), status(`HTTP ${probe.status}`), url(`landed on ${probe.finalUrl}`)],
      fix: `Put the redirect map in place on the old host so every url 301s to its counterpart on ${ctx.target.host}. Keep the host itself alive — and redirecting — for at least thirty days.`,
    })]
  },
})

// ----------------------------------------------------------------------- 11. Security headers

export const securityHeadersRegressed = define({
  id: 'cutover.security-headers-regressed',
  severity: 'medium',
  title: 'A security header the baseline had is gone',
  catches: 'A response header that was present before the launch and is absent on production — usually a platform default that the new host does not share.',
  run(ctx) {
    const before = ctx.baseline?.securityHeaders
    if (!before || Object.keys(before).length === 0) return []
    const home = startPage(ctx)
    const now = home?.response?.headers ?? {}
    const lost = Object.keys(before).filter((name) => now[name] === undefined)
    return lost.map((name) => emit(securityHeadersRegressed, {
      page: ctx.target.url,
      detail: `${name} was served before the launch and is not served now. Header configuration rarely moves with the content: a rule that lived in the old host's config, a proxy in front of the old site, or a platform default the new host does not set the same way.`,
      evidence: [url(ctx.target.url), header(`${name} before: ${before[name]}`), text(`${name} is absent from the production response`)],
      fix: `Re-add ${name} to the production host's header configuration and confirm it on a live response. Compare the whole set against the baseline rather than this one header.`,
    }))
  },
})

// ------------------------------------------------------------------------------ 12. The human day

// Spec §6.1 step 12, verbatim in intent: the six things on cutover day that no script does.
export const HUMAN_ITEMS = [
  'Submit the sitemap in Google Search Console and in Bing Webmaster Tools.',
  'Request indexing for the top pages — the homepage and the five urls that earn the most.',
  'Confirm Search Console shows the new property, verified, with the production host.',
  'Verify analytics in real time: load a page yourself and watch the hit arrive.',
  'Keep the old host up and redirecting through propagation — at least thirty days.',
  'Announce the launch only after this report is clean. Not before.',
]

export const humanItems = define({
  id: 'cutover.human-items',
  severity: 'info',
  tier: 'human',
  title: 'The six things on cutover day that no script can do',
  catches: 'The human half of the day: submissions, verification and the announcement, in the order they depend on each other.',
  run(ctx) {
    return [emit(humanItems, {
      page: ctx.target.url,
      detail: 'These are not optional and none of them is automated here. The last one is the reason the other eleven checks in this report exist: an announcement is the one step that cannot be taken back, so it comes after the report is clean and never before it.',
      evidence: HUMAN_ITEMS.map((item) => text(item)),
      fix: 'Work through them in this order, with the person who owns each one, and say out loud which are done and which are not.',
    })]
  },
})

// The order these are read on the day, which is the order spec §6.1 puts them in.
export const CUTOVER_ORDER = [
  'cutover.dns-unexpected',
  'cutover.dns-propagation',
  'cutover.https-cert-host',
  'cutover.http-redirect',
  'cutover.canonical-host',
  'cutover.noindex-live',
  'cutover.robots-live',
  'cutover.sitemap-live',
  'cutover.sitemap-references-staging',
  'cutover.redirect-drift',
  'cutover.redirect-unverified',
  'cutover.baseline-missing-page',
  'cutover.baseline-changed',
  'cutover.baseline-new-redirect',
  'cutover.analytics-missing',
  'cutover.analytics-not-firing',
  'cutover.form-endpoint-down',
  'cutover.staging-still-indexable',
  'cutover.old-host-serving-content',
  'cutover.security-headers-regressed',
  'cutover.human-items',
]

export const checks = [
  dnsUnexpected,
  dnsPropagation,
  httpsCertHost,
  httpRedirect,
  canonicalHost,
  noindexLive,
  robotsLive,
  sitemapLive,
  sitemapReferencesStaging,
  redirectDrift,
  redirectUnverified,
  baselineMissingPage,
  baselineChanged,
  baselineNewRedirect,
  analyticsMissing,
  analyticsNotFiring,
  formEndpointDown,
  stagingStillIndexable,
  oldHostServingContent,
  securityHeadersRegressed,
  humanItems,
]
