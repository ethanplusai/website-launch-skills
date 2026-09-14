// Host and transport: is the site served once, over TLS, with the headers and the 404 it should
// have?
//
// Pure over the audit context, like every check module: _ctx.mjs has already probed both root
// schemes, both host variants, the trailing-slash variant, a url that cannot exist, and a sample
// of the static assets the crawl saw, so nothing here fetches.
//
// The security-header list is the vendored OWASP Secure Headers project (headers/owasp.json,
// fetched 2026-09-13): `add` drives the "you are missing this" checks, `remove` drives
// `leaky-header-present`. Only five of the `add` list are treated as required — CSP,
// X-Content-Type-Options, X-Frame-Options (satisfied by a CSP frame-ancestors directive),
// Referrer-Policy and Permissions-Policy. The cross-origin isolation pair is reported at info,
// because requiring it breaks embeds on most ordinary sites.
//
// Redirects arrive already followed: net.get() reports the hops it took in `chain` and the url it
// landed on in `finalUrl`, so "does http redirect to https" is a question about the chain, not a
// 3xx status. A chain that revisits a url it already fetched is a loop, and a loop is never also
// reported as a long chain.

import { defineCheck, SkipCheck } from '../registry.mjs'
import { parseHtml } from '../html.mjs'
import owasp from '../headers/owasp.json' with { type: 'json' }

const PHASE = 'launch-audit'
const DIMENSION = 'host'
const TIER = 'http'
const HSTS_MIN_SECONDS = 31_536_000
const CERT_EXPIRY_DAYS = 30
const MIN_404_LINKS = 3
const MIN_404_BODY_BYTES = 300
const MIN_ASSET_MAX_AGE = 86_400

const LEAKY_HEADERS = new Set(owasp.remove.map((name) => name.toLowerCase()))
const REQUIRED_SECURITY_HEADERS = [
  { name: 'content-security-policy', why: 'controls which origins may supply scripts, styles and frames' },
  { name: 'x-content-type-options', why: 'stops browsers guessing a response is a script when it is not' },
  { name: 'x-frame-options', why: 'stops the site being framed for clickjacking', satisfiedByCsp: 'frame-ancestors' },
  { name: 'referrer-policy', why: 'keeps full urls out of the Referer header sent to other sites' },
  { name: 'permissions-policy', why: 'turns off browser features the site never uses' },
]
const ISOLATION_HEADERS = ['cross-origin-opener-policy', 'cross-origin-resource-policy']

const DEFAULT_404_PATTERNS = [
  { label: 'default <title>404 Not Found</title>', re: /<title>\s*404 Not Found\s*<\/title>/i },
  { label: 'nginx default error page', re: /nginx/i, requires: /<center>/i },
  { label: 'Apache default error page', re: /Apache\/[\d.]/ },
  { label: 'Apache "requested URL was not found" body', re: /The requested URL .*was not found on this server/i },
  { label: 'Express default handler ("Cannot GET /")', re: /Cannot GET \// },
  { label: 'Next.js default 404 ("This page could not be found")', re: /This page could not be found/ },
]

const DEV_HOST_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/,
  /\.local$/i,
  /\.ngrok(-free)?\.(io|app|dev)$/i,
]

const url = (value) => ({ type: 'url', value })
const status = (value) => ({ type: 'status', value })
const header = (value) => ({ type: 'header', value })
const html = (value) => ({ type: 'html', value })
const text = (value) => ({ type: 'text', value })
const cert = (value) => ({ type: 'cert', value })

const define = (def) => defineCheck({ phase: PHASE, dimension: DIMENSION, tier: TIER, ...def })
// mk() prebinds id/phase/dimension/severity/tier but not the title; most findings inherit their
// check's, a few (http-version, dev-host-leak on staging) say something more specific.
const emit = (check, overrides) => check.mk({ title: check.title, ...overrides })

const headerOf = (response, name) => (response?.headers ? response.headers[name] : undefined)
const ok2xx = (response) => !!response && response.status >= 200 && response.status < 300
const isHtml = (response) => String(headerOf(response, 'content-type') ?? '').toLowerCase().includes('text/html')
const hostOf = (value) => {
  try {
    return new URL(value).hostname
  } catch {
    return null
  }
}
const htmlPages = (ctx) => ctx.crawl.pages.filter((p) => p.page !== null && p.status >= 200 && p.status < 300)

// The response the site-wide header checks judge: the audited page itself when it answered,
// falling back to whichever root probe did.
function rootResponse(ctx) {
  const start = ctx.crawl.pages.find((p) => p.url === ctx.target.url)
  if (start && start.status >= 200 && start.status < 400) return start.response
  if (ctx.probes.httpsRoot && ctx.probes.httpsRoot.status >= 200 && ctx.probes.httpsRoot.status < 400) return ctx.probes.httpsRoot
  if (ctx.probes.httpRoot && ctx.probes.httpRoot.status >= 200 && ctx.probes.httpRoot.status < 400) return ctx.probes.httpRoot
  return start ? start.response : ctx.probes.httpsRoot
}

function resolveHop(location, base) {
  try {
    return new URL(location, base).href
  } catch {
    return null
  }
}

// A chain that comes back to a url it already fetched. net.get() also names the condition
// outright when it gave up, so both spellings count.
function isLoop(response) {
  if (/redirect loop|too many redirects/i.test(String(response?.error ?? ''))) return true
  const seen = new Set()
  for (const hop of response?.chain ?? []) {
    if (seen.has(hop.url)) return true
    seen.add(hop.url)
    const next = resolveHop(hop.location, hop.url)
    if (next !== null && seen.has(next)) return true
  }
  return false
}

const describeChain = (response) =>
  (response.chain ?? []).map((hop) => text(`${hop.url} → ${hop.status} → ${resolveHop(hop.location, hop.url) ?? hop.location}`))

// Everything the page asks the browser to load, which is what "mixed content" is about.
function subresources(page) {
  const out = []
  for (const image of page.images) if (image.src) out.push({ kind: 'img', href: image.src })
  for (const script of page.scripts) if (script.src) out.push({ kind: 'script', href: script.src })
  for (const frame of page.iframes) if (frame.src) out.push({ kind: 'iframe', href: frame.src })
  for (const form of page.forms) if (form.action) out.push({ kind: 'form', href: form.action })
  for (const link of page.head.links) {
    if (!link.href || link.rel === null) continue
    const rels = link.rel.split(/\s+/)
    if (rels.includes('stylesheet') || rels.includes('preload') || rels.includes('modulepreload')) out.push({ kind: 'link', href: link.href })
  }
  return out
}

const references = (page) => [...subresources(page), ...page.links.filter((l) => l.href).map((l) => ({ kind: 'a', href: l.href }))]

function devHostReason(host, ctx) {
  if (host === null) return null
  const lowered = host.toLowerCase()
  for (const configured of ctx.target.devHosts) {
    const value = String(configured).toLowerCase()
    if (lowered === value || lowered.endsWith(`.${value}`)) return `configured dev host "${configured}"`
  }
  for (const pattern of DEV_HOST_PATTERNS) if (pattern.test(lowered)) return 'a local or tunnel host'
  return null
}

function maxAgeOf(value) {
  const found = /max-age\s*=\s*"?(\d+)/i.exec(String(value ?? ''))
  return found === null ? null : Number(found[1])
}

export const httpNotRedirected = define({
  id: 'host.http-not-redirected',
  severity: 'high',
  title: 'http:// is served instead of redirecting to https://',
  catches: 'A site still answering on plain http after the certificate went up.',
  run(ctx) {
    const probe = ctx.probes.httpRoot
    if (!probe || probe.status === 0) return [] // http is not answering at all, which is fine
    if (String(probe.finalUrl ?? '').startsWith('https://')) return []
    if (probe.status >= 400) return []
    return [emit(httpNotRedirected, {
      page: probe.url,
      detail: 'The http:// origin serves the site rather than redirecting to https://. Anyone who types the bare domain, or follows an old link, gets an unencrypted page.',
      evidence: [url(probe.url), status(`HTTP ${probe.status} with no redirect to https`), text(`landed on ${probe.finalUrl}`)],
      fix: 'Redirect every http:// url to its https:// equivalent with a 301.',
    })]
  },
})

export const httpRedirectNot301 = define({
  id: 'host.http-redirect-not-301',
  severity: 'medium',
  title: 'The http to https redirect is temporary',
  catches: 'A 302 where the permanent move deserves a 301.',
  run(ctx) {
    const probe = ctx.probes.httpRoot
    if (!probe || (probe.chain?.length ?? 0) === 0) return []
    if (!String(probe.finalUrl ?? '').startsWith('https://')) return []
    const first = probe.chain[0]
    if (first.status === 301 || first.status === 308) return []
    return [emit(httpRedirectNot301, {
      page: probe.url,
      detail: `The upgrade to https answers ${first.status}, a temporary redirect. Browsers and search engines keep asking for the http url instead of remembering the move.`,
      evidence: [url(probe.url), status(`HTTP ${first.status} → ${resolveHop(first.location, first.url) ?? first.location}`)],
      fix: 'Return 301 (or 308) from http:// to https://.',
    })]
  },
})

export const hstsMissing = define({
  id: 'host.hsts-missing',
  severity: 'medium',
  title: 'No Strict-Transport-Security header',
  catches: 'An https site that still lets the first request go out in the clear.',
  run(ctx) {
    const probe = ctx.probes.httpsRoot
    if (!ok2xx(probe)) return []
    if (headerOf(probe, 'strict-transport-security') !== undefined) return []
    return [emit(hstsMissing, {
      page: probe.url,
      detail: 'Without HSTS, a browser that has never visited the site will try http first, which is the window an attacker on the network needs.',
      evidence: [url(probe.url), header('strict-transport-security: (absent)')],
      fix: 'Send "Strict-Transport-Security: max-age=31536000; includeSubDomains" from the https origin.',
    })]
  },
})

export const hstsShort = define({
  id: 'host.hsts-short',
  severity: 'low',
  title: 'The HSTS max-age is under a year',
  catches: 'A max-age too short for preload lists and long-lived browser state.',
  run(ctx) {
    const probe = ctx.probes.httpsRoot
    if (!ok2xx(probe)) return []
    const value = headerOf(probe, 'strict-transport-security')
    if (value === undefined) return []
    const maxAge = maxAgeOf(value)
    if (maxAge === null || maxAge >= HSTS_MIN_SECONDS) return []
    return [emit(hstsShort, {
      page: probe.url,
      detail: `HSTS is set to ${maxAge} seconds. A year (${HSTS_MIN_SECONDS}) is the floor browsers' preload list requires, and anything shorter leaves a regular window where the first request is plain http.`,
      evidence: [url(probe.url), header(`strict-transport-security: ${value}`)],
      fix: `Raise max-age to at least ${HSTS_MIN_SECONDS}.`,
    })]
  },
})

export const certInvalid = define({
  id: 'host.cert-invalid',
  severity: 'blocker',
  title: 'The TLS certificate does not validate',
  catches: 'A self-signed, expired, or wrong-host certificate: a full-page browser warning.',
  run(ctx) {
    if (!ctx.cert || ctx.cert.valid === true) return []
    return [emit(certInvalid, {
      page: `https://${ctx.target.host}/`,
      detail: 'The certificate served for this host does not validate, so every visitor gets an interstitial security warning before they see anything.',
      evidence: [
        url(`https://${ctx.target.host}/`),
        cert(`certificate for ${ctx.target.host} did not validate${ctx.cert.error ? `: ${ctx.cert.error}` : ''}`),
      ],
      fix: 'Install a certificate issued for this host by a public CA, with its full chain.',
    })]
  },
})

export const certExpiring = define({
  id: 'host.cert-expiring',
  severity: 'high',
  title: 'The TLS certificate expires soon',
  catches: 'A certificate with days left and no renewal in sight.',
  run(ctx) {
    // A certificate that did not validate is cert-invalid's finding, not this one's. net.cert()
    // connects with rejectUnauthorized:false, so an expired or wrong-host certificate still comes
    // back with daysLeft and altNames filled in — reporting those too would be the same defect
    // told three times.
    if (ctx.cert?.valid !== true) return []
    const days = ctx.cert.daysLeft
    if (days === null || days === undefined || days >= CERT_EXPIRY_DAYS) return []
    return [emit(certExpiring, {
      page: `https://${ctx.target.host}/`,
      detail: `The certificate expires in ${days} day${days === 1 ? '' : 's'}. When it does, the site goes down behind a browser warning.`,
      evidence: [
        url(`https://${ctx.target.host}/`),
        cert(`${days} days left (notAfter ${ctx.cert.validTo ?? 'unknown'})`),
      ],
      fix: 'Renew the certificate and confirm automatic renewal actually runs.',
    })]
  },
})

// Did this host variant answer at all? net.get follows redirects, so a www that 307s to the apex
// still comes back with a status; a host that resolves to nothing comes back with an error.
function variantAnswers(ctx, host) {
  const probe = host === ctx.target.www ? ctx.probes.wwwRoot : (host === ctx.target.apex ? ctx.probes.apexRoot : null)
  return probe !== null && probe !== undefined && typeof probe.status === 'number' && probe.status > 0
}

export const certMissingSan = define({
  id: 'host.cert-missing-san',
  severity: 'high',
  title: 'The certificate does not cover both apex and www',
  catches: 'A certificate issued for one host variant while the other is still reachable.',
  run(ctx) {
    if (ctx.cert?.valid !== true) return [] // see cert-expiring: an invalid certificate is one finding
    const names = ctx.cert.altNames ?? []
    if (names.length === 0) return []
    const coveredBy = (list, host) => list.some((name) => {
      const candidate = String(name).toLowerCase()
      if (candidate === host) return true
      if (!candidate.startsWith('*.')) return false
      const suffix = candidate.slice(1) // ".example.test"
      return host.endsWith(suffix) && host.slice(0, -suffix.length).includes('.') === false
    })
    const expected = ctx.target.hasWwwCounterpart ? [ctx.target.apex, ctx.target.www] : [ctx.target.host]
    // Two things have to be true before a missing name is a warning anybody would ever see. The
    // host has to answer — this check catches "one variant covered while the other is still
    // reachable", and a www that resolves to nothing sends nobody anywhere. And the host has to be
    // relying on *this* certificate: an apex on one provider with a CDN in front of www is two
    // certificates, and the www one routinely names only www. The smoke run found exactly that
    // shape and reported a name mismatch on a host that answers cleanly over TLS.
    const uncovered = expected.filter((host) => {
      if (coveredBy(names, host)) return false
      if (!variantAnswers(ctx, host)) return false
      const own = ctx.certs?.get?.(host)
      if (own === undefined || own === null || own === ctx.cert) return true
      return !(own.valid === true && coveredBy(own.altNames ?? [], host))
    })
    if (uncovered.length === 0) return []
    return [emit(certMissingSan, {
      page: `https://${ctx.target.host}/`,
      detail: `The certificate's subject alternative names do not cover ${uncovered.join(' or ')}. Any visitor who reaches an uncovered host gets a name-mismatch warning.`,
      evidence: [
        url(`https://${ctx.target.host}/`),
        cert(`altNames: ${names.join(', ')}`),
        text(`not covered: ${uncovered.join(', ')}`),
      ],
      fix: 'Reissue the certificate with both the apex and the www host in its SAN list.',
    })]
  },
})

export const wwwApexSplit = define({
  id: 'host.www-apex-split',
  severity: 'high',
  title: 'Both www and apex serve the site',
  catches: 'Two hosts serving one site, splitting links and rankings between them.',
  run(ctx) {
    if (!ctx.target.hasWwwCounterpart) return [] // no www counterpart exists for a subdomain target
    const { wwwRoot, apexRoot } = ctx.probes
    if (!ok2xx(wwwRoot) || !ok2xx(apexRoot)) return []
    if (hostOf(wwwRoot.finalUrl) === hostOf(apexRoot.finalUrl)) return []
    return [emit(wwwApexSplit, {
      page: ctx.target.origin,
      detail: 'Both host variants answer 200 without redirecting to each other, so the same content lives at two addresses. Links, rankings and analytics are divided between them.',
      evidence: [
        url(`${wwwRoot.url} → HTTP ${wwwRoot.status}`),
        url(`${apexRoot.url} → HTTP ${apexRoot.status}`),
        text('neither variant redirects to the other'),
      ],
      fix: 'Pick one canonical host and 301 the other to it.',
    })]
  },
})

export const wwwApexNoRedirect = define({
  id: 'host.www-apex-no-redirect',
  severity: 'medium',
  title: 'The other host variant does not redirect here',
  catches: 'A www (or apex) host that errors instead of redirecting to the canonical one.',
  run(ctx) {
    if (!ctx.target.hasWwwCounterpart) return [] // no www counterpart exists for a subdomain target
    const onWww = ctx.target.host === ctx.target.www
    const other = onWww ? ctx.probes.apexRoot : ctx.probes.wwwRoot
    if (!other) return []
    if (ok2xx(other)) return [] // that is www-apex-split's business, not this one
    const landedHost = hostOf(other.finalUrl)
    if ((other.chain?.length ?? 0) > 0 && landedHost === ctx.target.host) return []
    return [emit(wwwApexNoRedirect, {
      page: other.url,
      detail: `${other.url} neither serves the site nor redirects to ${ctx.target.host}. Anyone who types that variant, or follows an old link to it, gets an error.`,
      evidence: [
        url(other.url),
        status(`HTTP ${other.status}${other.error ? ` (${other.error})` : ''}`),
        // `finalUrl` on a failed request is the url that was asked for, not one anything landed
        // on, so a status-0 probe gets the fact that it never answered instead of a fictional
        // destination.
        ...(other.status === 0
          ? [text(`did not answer (${other.error ?? 'no response'})`)]
          : landedHost === null ? [] : [text(`landed on ${other.finalUrl}`)]),
      ],
      fix: `Serve a 301 from ${other.url} to the matching url on ${ctx.target.host}.`,
    })]
  },
})

export const trailingSlashBoth200 = define({
  id: 'host.trailing-slash-both-200',
  severity: 'medium',
  title: 'Both trailing-slash forms serve 200',
  catches: 'One page reachable at /path and /path/, with no redirect between them.',
  run(ctx) {
    const variant = ctx.probes.slashVariant
    if (!ok2xx(variant) || (variant.chain?.length ?? 0) > 0) return []
    const start = ctx.crawl.pages.find((p) => p.url === ctx.target.url)
    if (!start || !ok2xx(start.response) || (start.response.chain?.length ?? 0) > 0) return []
    return [emit(trailingSlashBoth200, {
      page: ctx.target.url,
      detail: 'The same page answers 200 with and without a trailing slash, so every link to it can be written two ways and search engines see two urls.',
      evidence: [
        url(`${start.url} → HTTP ${start.status}`),
        url(`${variant.url} → HTTP ${variant.status}`),
      ],
      fix: 'Pick one form and 301 the other to it, consistently across the site.',
    })]
  },
})

export const mixedContent = define({
  id: 'host.mixed-content',
  severity: 'high',
  title: 'An https page loads http subresources',
  catches: 'A hardcoded http:// asset that browsers block or flag on a secure page.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      if (!String(entry.finalUrl).startsWith('https://')) continue
      const insecure = subresources(entry.page).filter((resource) => resource.href.startsWith('http://'))
      if (insecure.length === 0) continue
      out.push(emit(mixedContent, {
        page: entry.url,
        detail: `This page is served over https and then asks for ${insecure.length} resource${insecure.length === 1 ? '' : 's'} over plain http. Browsers block active mixed content outright and flag the rest.`,
        evidence: [url(entry.url), ...insecure.slice(0, 10).map((resource) => html(`<${resource.kind}> ${resource.href}`))],
        fix: 'Serve every subresource over https, or use protocol-relative paths resolved by the page origin.',
      }))
    }
    return out
  },
})

export const redirectChain = define({
  id: 'host.redirect-chain',
  severity: 'medium',
  title: 'A url redirects more than once',
  catches: 'Stacked redirects — http to https to www to path — costing a round trip each.',
  run(ctx) {
    const seen = new Set()
    const candidates = [
      ...ctx.crawl.pages.map((p) => ({ url: p.url, response: p.response })),
      ...[ctx.probes.httpRoot, ctx.probes.wwwRoot].filter(Boolean).map((r) => ({ url: r.url, response: r })),
    ]
    const out = []
    for (const { url: from, response } of candidates) {
      if (seen.has(from)) continue
      seen.add(from)
      const hops = response?.chain?.length ?? 0
      if (hops <= 1 || isLoop(response)) continue
      out.push(emit(redirectChain, {
        page: from,
        detail: `Reaching this url takes ${hops} redirects. Every hop is a full round trip before anything renders, and each one leaks a little link equity.`,
        evidence: [url(from), status(`${hops} hops, ending at HTTP ${response.status}`), ...describeChain(response)],
        fix: 'Collapse the redirects so one hop goes straight to the final url.',
      }))
    }
    return out
  },
})

export const redirectLoop = define({
  id: 'host.redirect-loop',
  severity: 'high',
  title: 'A url redirects in a loop',
  catches: 'A redirect rule that sends a url back to itself, so the page never loads.',
  run(ctx) {
    const seen = new Set()
    const candidates = [
      ...ctx.crawl.pages.map((p) => ({ url: p.url, response: p.response })),
      ...[ctx.probes.httpRoot, ctx.probes.wwwRoot, ctx.probes.httpsRoot].filter(Boolean).map((r) => ({ url: r.url, response: r })),
    ]
    const out = []
    for (const { url: from, response } of candidates) {
      if (seen.has(from)) continue
      seen.add(from)
      if (!response || !isLoop(response)) continue
      out.push(emit(redirectLoop, {
        page: from,
        detail: 'The redirects for this url come back to a url already visited, so a browser gives up with ERR_TOO_MANY_REDIRECTS and shows nothing.',
        evidence: [url(from), status(`HTTP ${response.status}${response.error ? ` (${response.error})` : ''}`), ...describeChain(response)],
        fix: 'Find the two rules pointing at each other — usually a host rule and a path rule — and make one of them terminal.',
      }))
    }
    return out
  },
})

export const metaRefresh = define({
  id: 'host.meta-refresh',
  severity: 'medium',
  title: 'A page redirects with a meta refresh',
  catches: 'A client-side refresh standing in for a server redirect.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      const body = entry.response?.body
      if (typeof body !== 'string') continue
      const tag = /<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/i.exec(body)
      if (tag === null) continue
      out.push(emit(metaRefresh, {
        page: entry.url,
        detail: 'The page redirects itself in markup instead of at the server. Browsers cannot cache it, assistive technology announces the jump late, and search engines treat it as a weaker signal than a 301.',
        evidence: [url(entry.url), html(tag[0])],
        fix: 'Replace the meta refresh with a 301 (permanent) or 302 (temporary) at the server.',
      }))
    }
    return out
  },
})

export const securityHeaderMissing = define({
  id: 'host.security-header-missing',
  severity: 'medium',
  title: 'A recommended security header is missing',
  catches: 'A response with none of the headers the OWASP Secure Headers project asks for.',
  run(ctx) {
    const response = rootResponse(ctx)
    if (!ok2xx(response)) return []
    const csp = String(headerOf(response, 'content-security-policy') ?? '')
    const out = []
    for (const required of REQUIRED_SECURITY_HEADERS) {
      if (headerOf(response, required.name) !== undefined) continue
      if (required.satisfiedByCsp && csp.toLowerCase().includes(required.satisfiedByCsp)) continue
      const recommended = owasp.add.find((h) => h.name.toLowerCase() === required.name)
      out.push(emit(securityHeaderMissing, {
        page: response.url,
        title: `Missing security header: ${required.name}`,
        detail: `The response carries no ${required.name} header, which ${required.why}.`,
        evidence: [url(response.url), header(`${required.name}: (absent)`)],
        fix: recommended
          ? `Send "${recommended.name}: ${recommended.value}" (the OWASP Secure Headers recommendation) and adjust it to what the site actually loads.`
          : `Send a ${required.name} header.`,
      }))
    }
    return out
  },
})

export const securityHeaderCoopCorp = define({
  id: 'host.security-header-coop-corp',
  severity: 'info',
  title: 'The cross-origin isolation headers are not set',
  catches: 'COOP/CORP left off — worth knowing, not worth blocking a launch over.',
  run(ctx) {
    const response = rootResponse(ctx)
    if (!ok2xx(response)) return []
    const absent = ISOLATION_HEADERS.filter((name) => headerOf(response, name) === undefined)
    if (absent.length === 0) return []
    return [emit(securityHeaderCoopCorp, {
      page: response.url,
      detail: 'Cross-Origin-Opener-Policy and Cross-Origin-Resource-Policy isolate the page from other browsing contexts. They are worth setting on an app, and they break third-party embeds on an ordinary marketing site, so this is a decision rather than a defect.',
      evidence: [url(response.url), ...absent.map((name) => header(`${name}: (absent)`))],
      fix: 'If the site embeds nothing third-party, add "Cross-Origin-Opener-Policy: same-origin" and "Cross-Origin-Resource-Policy: same-origin".',
    })]
  },
})

export const leakyHeaderPresent = define({
  id: 'host.leaky-header-present',
  severity: 'low',
  title: 'A response header discloses the stack',
  catches: 'Server, X-Powered-By and friends, naming the software and version to attack.',
  run(ctx) {
    const response = rootResponse(ctx)
    if (!response || !response.headers) return []
    const out = []
    for (const [name, value] of Object.entries(response.headers)) {
      if (!LEAKY_HEADERS.has(name.toLowerCase())) continue
      out.push(emit(leakyHeaderPresent, {
        page: response.url,
        title: `Response header discloses the stack: ${name}`,
        detail: `The ${name} header names the software serving this site. It buys an attacker a version number and the site nothing; the OWASP Secure Headers project lists it for removal.`,
        evidence: [header(`${name}: ${value}`), url(response.url)],
        fix: `Stop sending the ${name} header from the server or CDN.`,
      }))
    }
    return out
  },
})

export const noCompression = define({
  id: 'host.no-compression',
  severity: 'medium',
  title: 'HTML is served uncompressed',
  catches: 'A server that never negotiated gzip or brotli.',
  run(ctx) {
    const response = rootResponse(ctx)
    if (!ok2xx(response) || !isHtml(response)) return []
    const encoding = headerOf(response, 'content-encoding')
    if (encoding !== undefined && /gzip|br|deflate|zstd/i.test(String(encoding))) return []
    return [emit(noCompression, {
      page: response.url,
      detail: 'The HTML came back with no content-encoding, so every byte of markup crosses the network uncompressed. Text compresses by roughly three quarters.',
      evidence: [url(response.url), header('content-encoding: (absent)'), { type: 'metric', value: `${response.bytes ?? 0} bytes of HTML` }],
      fix: 'Turn on gzip or brotli at the server or CDN for text/html, text/css, application/javascript and svg.',
    })]
  },
})

export const noCacheStatic = define({
  id: 'host.no-cache-static',
  severity: 'low',
  title: 'A static asset is served without caching',
  catches: 'Fingerprinted assets re-downloaded on every visit.',
  run(ctx) {
    const out = []
    for (const asset of ctx.probes.assets ?? []) {
      if (!ok2xx(asset.response)) continue
      const value = headerOf(asset.response, 'cache-control')
      const maxAge = maxAgeOf(value)
      const forbidden = /no-store|no-cache/i.test(String(value ?? ''))
      if (!forbidden && maxAge !== null && maxAge >= MIN_ASSET_MAX_AGE) continue
      out.push(emit(noCacheStatic, {
        page: asset.url,
        detail: value === undefined
          ? 'This static asset comes back with no cache-control at all, so browsers revalidate it on every page view.'
          : `This static asset is served with "${value}", which keeps browsers from holding on to it.`,
        evidence: [url(asset.url), header(`cache-control: ${value ?? '(absent)'}`), text(`${asset.kind} referenced by the crawl`)],
        fix: 'Serve fingerprinted assets with "Cache-Control: public, max-age=31536000, immutable".',
      }))
    }
    return out
  },
})

export const httpVersion = define({
  id: 'host.http-version',
  severity: 'info',
  title: 'HTTP version',
  catches: 'Whether the origin advertises a protocol newer than HTTP/1.1.',
  run(ctx) {
    const response = rootResponse(ctx)
    // No response means no headers, and "no alt-svc header" would then be a claim about a
    // response nobody received rather than about the origin.
    if (!response || response.status === 0) {
      throw new SkipCheck(`the root probe never answered (${response?.url ?? ctx.target.url}: ${response?.error ?? 'no response'})`)
    }
    const altSvc = headerOf(response, 'alt-svc')
    const advertised = altSvc === undefined ? [] : [...String(altSvc).matchAll(/\b(h3(?:-\d+)?|h2)\b/gi)].map((m) => m[1].toLowerCase())
    const unique = [...new Set(advertised)]
    return [emit(httpVersion, {
      page: response?.url ?? ctx.target.url,
      title: unique.length > 0
        ? `HTTP version: ${unique.join(' and ')} advertised`
        : 'HTTP version: nothing newer than HTTP/1.1 is advertised',
      detail: unique.length > 0
        ? 'The origin advertises a newer protocol through alt-svc, so browsers will upgrade after the first request. Recorded for the report; nothing to fix.'
        : 'No alt-svc header, so this audit saw nothing newer than HTTP/1.1 advertised. The fetch client here only speaks HTTP/1.1, so this is what the origin announced, not proof of what it supports.',
      evidence: [
        url(response?.url ?? ctx.target.url),
        altSvc === undefined ? header('alt-svc: (absent)') : header(`alt-svc: ${altSvc}`),
      ],
      fix: unique.length > 0 ? 'No action required.' : 'If the CDN or server supports HTTP/2 or HTTP/3, enable it — it is usually a switch rather than a change.',
    })]
  },
})

export const soft404 = define({
  id: 'host.soft-404',
  severity: 'high',
  title: 'A missing page answers 200',
  catches: 'A catch-all route turning every typo into an indexable empty page.',
  run(ctx) {
    const { url: probeUrl, response } = ctx.probes.notFound
    if (response.status !== 200) return []
    return [emit(soft404, {
      page: probeUrl,
      detail: 'A url that cannot exist came back 200. Search engines index these as real pages, monitoring never sees a failure, and a broken link looks like a working one.',
      evidence: [url(probeUrl), status('HTTP 200 for a url that should not exist')],
      fix: 'Return a real 404 status for unknown urls, with the friendly page as the body.',
    })]
  },
})

export const default404Body = define({
  id: 'host.default-404-body',
  severity: 'medium',
  title: 'The 404 page is the server default',
  catches: 'A stock nginx, Apache or framework error page on a finished site.',
  run(ctx) {
    const { url: probeUrl, response } = ctx.probes.notFound
    if (response.status !== 404) return []
    const body = typeof response.body === 'string' ? response.body : ''
    const matched = DEFAULT_404_PATTERNS.filter((p) => p.re.test(body) && (!p.requires || p.requires.test(body)))
    const tiny = body.trim().length > 0 && body.trim().length < MIN_404_BODY_BYTES
    if (matched.length === 0 && !tiny) return []
    return [emit(default404Body, {
      page: probeUrl,
      detail: 'The 404 comes back as the server or framework default rather than a page belonging to this site. It names the software, offers no way onward, and looks broken rather than handled.',
      evidence: [
        url(probeUrl),
        status('HTTP 404'),
        ...matched.map((p) => html(`matched ${p.label}`)),
        ...(tiny ? [{ type: 'metric', value: `${body.trim().length} byte body` }] : []),
      ],
      fix: 'Serve a branded 404 page with the site navigation, still under a 404 status.',
    })]
  },
})

export const notFoundNoNavigation = define({
  id: 'host.404-no-navigation',
  severity: 'low',
  title: 'The 404 page offers no way back',
  catches: 'A dead end: an error page with no navigation and nowhere to click.',
  run(ctx) {
    const { url: probeUrl, response } = ctx.probes.notFound
    if (response.status !== 404) return []
    if (typeof response.body !== 'string') return []
    const page = parseHtml(response.body, probeUrl)
    const hasNav = page.landmarks.includes('nav') || page.landmarks.includes('navigation')
    const internal = page.links.filter((link) => link.internal)
    if (hasNav || internal.length >= MIN_404_LINKS) return []
    return [emit(notFoundNoNavigation, {
      page: probeUrl,
      detail: 'The 404 page has no navigation landmark and almost no internal links, so a visitor who lands on it has nowhere to go but the back button.',
      evidence: [
        url(probeUrl),
        html(`landmarks: ${page.landmarks.length > 0 ? page.landmarks.join(', ') : 'none'}`),
        { type: 'metric', value: `${internal.length} internal link${internal.length === 1 ? '' : 's'}` },
      ],
      fix: 'Render the 404 inside the normal site layout, with the header navigation and a link home.',
    })]
  },
})

export const devHostLeak = define({
  id: 'host.dev-host-leak',
  severity: 'blocker',
  title: 'A page references a development host',
  catches: 'localhost, a tunnel url, or the old staging host, shipped to production.',
  run(ctx) {
    const staging = ctx.target.staging
    const out = []
    for (const entry of htmlPages(ctx)) {
      const leaks = []
      for (const reference of references(entry.page)) {
        const reason = devHostReason(hostOf(reference.href), ctx)
        if (reason === null) continue
        leaks.push({ ...reference, reason })
      }
      if (leaks.length === 0) continue
      out.push(emit(devHostLeak, {
        severity: staging ? 'high' : 'blocker',
        page: entry.url,
        title: staging ? 'A staging page references a development host' : 'A page references a development host',
        detail: staging
          ? `This staging page points at ${leaks.length} development url${leaks.length === 1 ? '' : 's'}. Fix it before the same markup reaches production, where the reference simply breaks.`
          : `This page points at ${leaks.length} development url${leaks.length === 1 ? '' : 's'}. Nobody but the developer can load them, so the reference is broken for every visitor.`,
        evidence: [url(entry.url), ...leaks.slice(0, 10).map((leak) => html(`<${leak.kind}> ${leak.href} — ${leak.reason}`))],
        fix: 'Replace the development urls with production ones, and check the build for a hardcoded base url.',
      }))
    }
    return out
  },
})

export const checks = [
  httpNotRedirected,
  httpRedirectNot301,
  hstsMissing,
  hstsShort,
  certInvalid,
  certExpiring,
  certMissingSan,
  wwwApexSplit,
  wwwApexNoRedirect,
  trailingSlashBoth200,
  mixedContent,
  redirectChain,
  redirectLoop,
  metaRefresh,
  securityHeaderMissing,
  securityHeaderCoopCorp,
  leakyHeaderPresent,
  noCompression,
  noCacheStatic,
  httpVersion,
  soft404,
  default404Body,
  notFoundNoNavigation,
  devHostLeak,
]
