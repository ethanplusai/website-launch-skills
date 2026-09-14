// Cutover day: build the context, run the checks, write the bundle.
//
// `buildCutoverContext` is the launch-audit context plus the six facts only cutover day has, each
// of them fetched once here so the checks stay pure:
//
//   ctx.baseline / ctx.baselineDiff   the pre-launch baseline, and production diffed against it
//   ctx.redirectRows                  the audit's redirects.csv, parsed
//   ctx.cutoverRedirects              every one of those old urls, re-requested AS IT WAS WRITTEN
//   ctx.expectDns / ctx.dnsAcross     the expected records, and what four public resolvers answer
//   ctx.stagingProbe                  the staging host and its robots.txt
//   ctx.oldRootProbe                  the old host's root
//   ctx.formEndpoints                 every same-origin form action a crawled page names
//
// The redirect rows are re-requested at their original absolute urls rather than rewritten onto
// the production origin, because that is the actual question on the day: after DNS moved, what
// happens to the url somebody has in a bookmark? Rewriting the host would test the new site's
// routing and say nothing about the redirect a visitor actually follows.
//
// An input that cannot be read is a coverage gap, never a crash: an unreadable baseline, a
// malformed csv row, a probe set that hit its cap — each one lands in `Not covered` by name and
// the rest of the run continues. The report must be able to say "we did not compare" rather than
// implying a clean diff nobody performed.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { buildAuditContext } from '../../../launch-audit/scripts/lib/checks/_ctx.mjs'
import { parseRobots } from '../../../launch-audit/scripts/lib/robots.mjs'
import { parseRedirectCsv } from '../../../launch-audit/scripts/lib/csv.mjs'
import { makeBaseline, diffBaseline } from '../../../launch-audit/scripts/lib/baseline.mjs'
import { detectAnalytics } from '../../../launch-audit/scripts/lib/detect/analytics.mjs'
import { createRegistry, SkipCheck } from '../../../launch-audit/scripts/lib/registry.mjs'
import { validateFinding, sortFindings } from '../../../launch-audit/scripts/lib/findings.mjs'
import {
  buildNotCovered, insertBeforeFixed, inline, writeBundle, resolveOutDir, screenshotNames,
} from '../../../launch-audit/scripts/lib/report.mjs'
import { slugify } from '../../../launch-audit/scripts/lib/slug.mjs'
import { checks as cutoverChecks, CUTOVER_ORDER, VERIFIABLE } from './checks/cutover.mjs'

export const PHASE = 'post-launch'

// A site can carry a lot of old urls. Five hundred is more than any hand-written redirect map has
// and small enough to finish while somebody watches; anything past it is named in "Not covered".
const REDIRECT_PROBE_CAP = 500
const FORM_ENDPOINT_CAP = 100

// The response headers a baseline records, and therefore the ones a regression is measured
// against. Same list launch-audit writes, because the two have to be comparable.
const BASELINE_SECURITY_HEADERS = [
  'strict-transport-security', 'content-security-policy', 'x-content-type-options', 'x-frame-options',
  'referrer-policy', 'permissions-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy',
]

const EXPECT_DNS_KEYS = ['apex', 'www']

export const messageOf = (error) => (error?.message === undefined || error.message === '' ? String(error) : error.message)

// ------------------------------------------------------------------------------- the inputs

// `--expect-dns apex=1.2.3.4,www=cname.host` → `{apex: ['1.2.3.4'], www: ['cname.host']}`. A key
// may repeat, because a host with two A records has two expected answers. Anything that is not
// `apex=` or `www=` is a usage error rather than a silently ignored token: a typo here would make
// the check pass by having nothing to compare.
export function parseExpectDns(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const out = { apex: [], www: [] }
  for (const token of value.split(',')) {
    const piece = token.trim()
    if (piece === '') continue
    const eq = piece.indexOf('=')
    if (eq === -1) throw new Error(`--expect-dns expects apex=<value> or www=<value>, got "${piece}"`)
    const key = piece.slice(0, eq).trim().toLowerCase()
    const target = piece.slice(eq + 1).trim()
    if (!EXPECT_DNS_KEYS.includes(key)) throw new Error(`--expect-dns key must be apex or www, got "${key}"`)
    if (target === '') throw new Error(`--expect-dns ${key}= has no value`)
    out[key].push(target)
  }
  if (out.apex.length === 0 && out.www.length === 0) return null
  return out
}

// `options.baseline` is a path, `options.baselineData` an already-parsed baseline (which is what
// a watch run hands back in). Either may be absent; neither is allowed to throw.
function readBaseline(options, gaps) {
  if (options.baselineData !== undefined && options.baselineData !== null) return options.baselineData
  if (typeof options.baseline !== 'string' || options.baseline === '') {
    gaps.push('Baseline comparison: not run — no --baseline was given, so nothing was compared against the site as it was before the launch')
    return null
  }
  try {
    return JSON.parse(readFileSync(options.baseline, 'utf8'))
  } catch (error) {
    gaps.push(`Baseline comparison: skipped — ${messageOf(error)}`)
    return null
  }
}

function readRedirectRows(options, gaps) {
  if (typeof options.redirectsCsv !== 'string' || options.redirectsCsv === '') {
    gaps.push('Redirect drift: not run — no --redirects was given, so no old url was re-requested')
    return null
  }
  let text
  try {
    text = readFileSync(options.redirectsCsv, 'utf8')
  } catch (error) {
    gaps.push(`Redirect drift: skipped — ${messageOf(error)}`)
    return null
  }
  const { rows, errors } = parseRedirectCsv(text)
  for (const error of errors) gaps.push(`Redirect map: ${error}`)
  if (rows.length === 0 && errors.length === 0) gaps.push('Redirect map: the csv has a header and no rows')
  const unverifiable = rows.filter((row) => !VERIFIABLE.has(row.status_on_new))
  if (unverifiable.length > 0) {
    gaps.push(`Redirect drift: ${unverifiable.length} row${unverifiable.length === 1 ? '' : 's'} could not be verified — the audit recorded them as "${[...new Set(unverifiable.map((row) => row.status_on_new))].join('", "')}", which promises no destination to check`)
  }
  return rows
}

// ------------------------------------------------------------------------------- the context

function analyticsByPage(crawl) {
  const byUrl = new Map()
  for (const entry of crawl.pages) {
    const body = typeof entry.response?.body === 'string' ? entry.response.body : ''
    byUrl.set(entry.url, [...new Set(detectAnalytics(body).map((hit) => hit.name))])
  }
  return byUrl
}

function securityHeadersOf(ctx) {
  const home = ctx.crawl.pages.find((p) => p.url === ctx.target.url) ?? ctx.crawl.pages[0]
  const headers = home?.response?.headers ?? {}
  const out = {}
  for (const name of BASELINE_SECURITY_HEADERS) if (headers[name] !== undefined) out[name] = headers[name]
  return out
}

// The baseline this run of production would leave behind, built exactly the way launch-audit
// builds one so the two are comparable field for field.
export function productionBaseline(ctx, at) {
  return makeBaseline(ctx.crawl, {
    now: at,
    securityHeaders: securityHeadersOf(ctx),
    cert: ctx.cert === null ? null : { expires: ctx.cert.validTo, daysLeft: ctx.cert.daysLeft },
    robotsHash: ctx.robots.text === null ? null : createHash('sha256').update(ctx.robots.text).digest('hex'),
    sitemapUrls: ctx.sitemaps.urls,
    analyticsByPage: analyticsByPage(ctx.crawl),
  })
}

// Every same-origin form action a crawled page names, absolute and deduped. An off-origin action
// is a third-party form, which arrives through `probes.embeds` instead.
function formActionUrls(ctx) {
  const out = new Set()
  for (const entry of ctx.crawl.pages) {
    if (entry.page === null) continue
    for (const form of entry.page.forms) {
      const action = form.action
      if (typeof action !== 'string' || action === '' || action === '#') continue
      let parsed
      try {
        parsed = new URL(action)
      } catch {
        continue
      }
      if (parsed.origin !== ctx.target.origin) continue
      out.add(parsed.href)
    }
  }
  return [...out]
}

const capped = (items, cap) => ({ items: items.slice(0, cap), caps: { cap, dropped: Math.max(0, items.length - cap) } })

export async function buildCutoverContext({ net, dns, options = {}, now = new Date() } = {}) {
  const at = now instanceof Date ? now : new Date(now)
  const gaps = []

  const ctx = await buildAuditContext(net, dns, { ...options, url: options.url, oldUrl: options.oldUrl, now: at })

  // The staging host, as a host rather than a url, because every "is this reference production?"
  // question below compares hosts.
  let stagingUrl = null
  let stagingHost = null
  if (typeof options.stagingUrl === 'string' && options.stagingUrl !== '') {
    try {
      const parsed = new URL(options.stagingUrl)
      stagingUrl = parsed.href
      stagingHost = parsed.hostname.toLowerCase()
    } catch {
      gaps.push(`Staging host: skipped — --staging-url is not a url: ${options.stagingUrl}`)
    }
  } else {
    gaps.push('Staging host: not checked — no --staging-url was given, so nothing confirmed the staging copy is sealed')
  }
  ctx.stagingHost = stagingHost

  // 1. the baseline, and production diffed against it
  ctx.baseline = readBaseline(options, gaps)
  ctx.productionBaseline = productionBaseline(ctx, at)
  ctx.baselineDiff = null
  if (ctx.baseline !== null) {
    try {
      ctx.baselineDiff = diffBaseline(ctx.baseline, ctx.productionBaseline)
    } catch (error) {
      gaps.push(`Baseline comparison: skipped — ${messageOf(error)}`)
    }
  }

  // 2. the redirect map, re-requested as written
  ctx.redirectRows = readRedirectRows(options, gaps)
  ctx.cutoverRedirects = new Map()
  const redirectPick = capped(
    (ctx.redirectRows ?? []).filter((row) => VERIFIABLE.has(row.status_on_new)).map((row) => row.old_url),
    REDIRECT_PROBE_CAP,
  )
  if (redirectPick.items.length > 0) {
    const responses = await net.map(redirectPick.items, (oldUrl) => net.get(oldUrl))
    redirectPick.items.forEach((oldUrl, i) => ctx.cutoverRedirects.set(oldUrl, responses[i]))
  }
  ctx.probes.caps.cutoverRedirects = redirectPick.caps

  // 3. DNS: what was expected, and what the public resolvers actually answer
  ctx.expectDns = options.expectDns ?? null
  if (ctx.expectDns === null) {
    gaps.push('DNS targets: not checked — no --expect-dns was given, so nothing compared the live records against the intended ones')
  }
  ctx.dnsAcross = null
  if (typeof dns.resolveAcross === 'function') {
    const hosts = [ctx.target.apex, ...(ctx.target.hasWwwCounterpart ? [ctx.target.www] : [])]
    const answers = await Promise.all(hosts.map((host) => dns.resolveAcross(host)))
    ctx.dnsAcross = Object.fromEntries(hosts.map((host, i) => [host, answers[i]]))
  } else {
    gaps.push('DNS propagation: not sampled — this run has no resolver adapter, so no public resolver was asked')
  }

  // 4. staging, and its own robots.txt
  ctx.stagingProbe = null
  if (stagingUrl !== null) {
    const response = await net.get(stagingUrl)
    const robotsUrl = `${new URL(stagingUrl).origin}/robots.txt`
    const robotsResponse = await net.get(robotsUrl)
    const robotsText = robotsResponse.status === 200 && typeof robotsResponse.body === 'string' ? robotsResponse.body : null
    ctx.stagingProbe = {
      url: stagingUrl,
      response,
      robots: { url: robotsUrl, status: robotsResponse.status, text: robotsText, parsed: robotsText === null ? null : parseRobots(robotsText) },
    }
  }

  // 5. the old host's root
  ctx.oldRootProbe = null
  if (typeof options.oldUrl === 'string' && options.oldUrl !== '') {
    ctx.oldRootProbe = await net.get(options.oldUrl)
  } else {
    gaps.push('Old host: not checked — no --old-url was given, so nothing confirmed the site being replaced now redirects')
  }

  // 6. every same-origin form endpoint. A response the crawl already has is reused rather than
  // fetched twice; the rest are fetched with GET, which is read-only — nothing here submits.
  const byCrawl = new Map()
  for (const entry of ctx.crawl.pages) {
    byCrawl.set(entry.url, entry.response)
    if (entry.finalUrl && !byCrawl.has(entry.finalUrl)) byCrawl.set(entry.finalUrl, entry.response)
  }
  const formPick = capped(formActionUrls(ctx), FORM_ENDPOINT_CAP)
  const toFetch = formPick.items.filter((endpoint) => !byCrawl.has(endpoint))
  const fetched = await net.map(toFetch, (endpoint) => net.get(endpoint))
  const fetchedByUrl = new Map(toFetch.map((endpoint, i) => [endpoint, fetched[i]]))
  ctx.formEndpoints = new Map(formPick.items.map((endpoint) => [endpoint, byCrawl.get(endpoint) ?? fetchedByUrl.get(endpoint)]))
  ctx.probes.caps.formEndpoints = formPick.caps

  ctx.gaps = gaps
  return ctx
}

// -------------------------------------------------------------------------------- the browser

const unavailableTier = (reason) => ({ available: false, reason, renders: new Map() })

// The browser tier a cutover needs, which is one page: the start url. launch-audit renders six for
// template variety; cutover day has one question — does the tag fire on the page people land on.
export async function renderStartPage(ctx, browser) {
  if (browser === null || browser === undefined) {
    return { tier: unavailableTier('no browser adapter was supplied to this run'), lines: [] }
  }
  let opened = false
  try {
    opened = browser.available === true
    if (!opened && typeof browser.open === 'function') opened = (await browser.open()) === true
  } catch (error) {
    return { tier: unavailableTier(`the browser tier failed to open — ${messageOf(error)}`), lines: [] }
  }
  if (!opened) return { tier: unavailableTier(browser.reason ?? 'the browser tier did not open'), lines: [] }
  if (typeof browser.render !== 'function') {
    return { tier: unavailableTier('the browser adapter cannot render a page'), lines: [] }
  }

  const renders = new Map()
  const lines = []
  try {
    renders.set(ctx.target.url, await browser.render(ctx.target.url))
  } catch (error) {
    lines.push(`Browser tier: ${ctx.target.url} — render failed — ${messageOf(error)}`)
  }
  return { tier: { available: true, reason: null, renders }, lines }
}

// --------------------------------------------------------------------------------- the checks

export function cutoverRegistry(extraModules = []) {
  const registry = createRegistry()
  for (const check of cutoverChecks) registry.add(check)
  for (const module of extraModules) for (const check of module.checks) registry.add(check)
  return registry
}

// Unwraps whichever of the two return shapes a check used — the same pair pre-launch's gate runner
// accepts, and for the same reason. A check that looked and found nothing returns `Finding[]`. A
// check that could not look at all returns `{findings, notCovered}`, and those lines go straight
// into the report's Not covered section: "the certificate was never read" and "the certificate is
// fine" are different answers, and only the first one has somewhere honest to go.
// `null` means the check returned neither, which is a bug in the check.
// A `notCovered` that is not an array of strings used to be filtered down to `[]`, which deleted
// the one thing this shape exists to carry and did it without a word. A check that tried to
// declare a coverage gap and got the shape wrong has not declared nothing — it has failed to
// declare something, and those are opposite facts. An omitted `notCovered` is neither: the check
// simply had no bound to report.
const MALFORMED_NOT_COVERED = { malformed: 'malformed notCovered' }
const MALFORMED_SHAPE = { malformed: 'run() returned neither an array of findings nor { findings, notCovered }' }

function unwrap(produced) {
  if (Array.isArray(produced)) return { findings: produced, notCovered: [] }
  if (produced !== null && typeof produced === 'object' && Array.isArray(produced.findings)) {
    const declared = produced.notCovered
    if (declared === undefined || declared === null) return { findings: produced.findings, notCovered: [] }
    if (!Array.isArray(declared) || !declared.every((line) => typeof line === 'string')) return MALFORMED_NOT_COVERED
    return { findings: produced.findings, notCovered: declared.filter((line) => line !== '') }
  }
  return MALFORMED_SHAPE
}

// Runs every check in `registry` over `ctx`. A check that throws costs that check and says so; a
// finding that fails validation is dropped and says so. Same contract as the auditor, for the same
// reason: a report that is quietly short one check is worse than one that names the gap.
export async function runChecksOver(ctx, registry) {
  const knownIds = registry.ids()
  const findings = []
  const lines = []
  const skipped = []
  for (const check of registry.list()) {
    let produced
    try {
      produced = await check.run(ctx)
    } catch (error) {
      if (error instanceof SkipCheck) skipped.push({ check: check.id, reason: error.reason })
      else lines.push(`${check.id}: check crashed — ${messageOf(error)}`)
      continue
    }
    const unwrapped = unwrap(produced)
    if (unwrapped.malformed !== undefined) {
      lines.push(`${check.id}: check crashed — ${unwrapped.malformed}`)
      continue
    }
    lines.push(...unwrapped.notCovered)
    for (const candidate of unwrapped.findings) {
      const { ok, errors } = validateFinding(candidate, knownIds)
      if (!ok) {
        lines.push(`${check.id}: finding dropped as invalid — ${errors.join('; ')}`)
        continue
      }
      findings.push(candidate)
    }
  }
  return { findings, lines, skipped }
}

// One line per capped probe set that actually dropped something.
export function capLines(caps) {
  const lines = []
  for (const [set, cap] of Object.entries(caps ?? {})) {
    if (typeof cap?.skipped === 'string') lines.push(`${set}: not probed — ${cap.skipped}`)
    const dropped = cap?.dropped ?? 0
    if (dropped > 0) lines.push(`${set}: ${dropped} of ${dropped + cap.cap} not probed (cap ${cap.cap})`)
  }
  return lines
}

// ---------------------------------------------------------------------------------- the report

const SEVERITY_RANK = { blocker: 0, high: 1, medium: 2, low: 3, info: 4 }

function formatValue(v) {
  if (v === null || v === undefined) return '(none)'
  if (typeof v === 'string') return inline(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return inline(JSON.stringify(v))
  } catch {
    return '(none)'
  }
}

// A blocker is bolded wherever it lands in the day order, because the day order is a dependency
// order and not a severity order: the one thing that must be read first has to be visible while
// somebody is reading step six.
function renderFinding(f) {
  const heading = f.severity === 'blocker'
    ? `### **BLOCKER** — ${inline(f.title)}`
    : `### [${f.severity}] ${inline(f.title)}`
  const lines = [heading, '']
  lines.push(`- Page: ${inline(f.page || 'site-wide')}`)
  lines.push(`- Detail: ${inline(f.detail)}`)
  lines.push('- Evidence:')
  for (const e of f.evidence) lines.push(`  - ${inline(e.type)}: ${formatValue(e.value)}`)
  lines.push(`- Fix: ${inline(f.fix)}`)
  return lines
}

// The cutover section in the order of the day (spec §6.1), and anything else — the audit
// dimensions a watch day re-runs — after it, grouped by dimension and severity-ranked within.
export function renderCutoverReport({ target, generatedAt, findings = [], notCovered = [], summary, plan = null }) {
  const lines = []
  lines.push(`# Launch post-launch report — ${inline(target)}`, '')
  lines.push(`Generated ${generatedAt}`, '')
  lines.push('| Pages | Blockers | High | Medium | Low | Info |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  lines.push(`| ${summary.pages} | ${summary.blockers} | ${summary.high} | ${summary.medium} | ${summary.low} | ${summary.info} |`, '')

  const order = new Map(CUTOVER_ORDER.map((id, i) => [id, i]))
  const cutover = findings.filter((f) => f.dimension === 'cutover')
    .sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999) || String(a.page).localeCompare(String(b.page)))

  lines.push('## Cutover verification', '')
  if (cutover.length === 0) {
    lines.push('_No cutover findings._', '')
  } else {
    lines.push(
      'In the order the day depends on: DNS, transport, indexability, robots and sitemap, redirects,',
      'the baseline diff, analytics, forms, staging, the old host, headers, people.',
      '',
    )
    for (const finding of cutover) lines.push(...renderFinding(finding), '')
  }

  const rest = findings.filter((f) => f.dimension !== 'cutover')
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.dimension.localeCompare(b.dimension) || String(a.page).localeCompare(String(b.page)))
  const dims = []
  const byDim = new Map()
  for (const f of rest) {
    if (!byDim.has(f.dimension)) {
      byDim.set(f.dimension, [])
      dims.push(f.dimension)
    }
    byDim.get(f.dimension).push(f)
  }
  for (const dim of dims) {
    lines.push(`## ${inline(dim)}`, '')
    for (const f of byDim.get(dim)) lines.push(...renderFinding(f), '')
  }

  if (plan !== null) {
    lines.push('## The watch', '')
    for (const entry of plan) {
      lines.push(`- [${entry.due}] day ${entry.day}: ${inline(entry.task)}${entry.automated ? ' _(automated)_' : ''}`)
    }
    lines.push('')
  }

  lines.push('## Ops & access readiness', '')
  lines.push('- [human] The ops checklist belongs to the launch-audit bundle, which is the run that has the evidence for it. Nothing here re-verifies those items, and nothing here ticks one off.', '')

  lines.push('## Not covered', '')
  for (const line of notCovered) lines.push(`- ${inline(line)}`)

  return lines.join('\n') + '\n'
}

export function summaryOf(findings, pages) {
  const count = (severity) => findings.filter((f) => f.severity === severity).length
  return {
    pages,
    blockers: count('blocker'),
    high: count('high'),
    medium: count('medium'),
    low: count('low'),
    info: count('info'),
  }
}

// The four dimensions a full launch-audit has that cutover day does not re-run. `--mode watch`
// adds exactly these back (watch.mjs WATCH_MODULES), which is why the line below names that mode
// as the way to get them.
const AUDIT_DIMENSIONS_A_WATCH_ADDS = ['links', 'head', 'indexability', 'inventory']

const andList = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`)

// How narrow this run was, in one sentence, computed from the registry that actually ran.
//
// A cutover report is the one a person reads immediately before announcing a launch, and nothing
// in it said that it covers 21 conditions out of a full audit's 176. A clean cutover report
// therefore read like a clean site. The smoke run found this from the other end: day 1 of the
// watch surfaced two high findings the cutover the evening before had not, because the cutover
// never looked. A watch day does re-run those dimensions, so it gets no such line — the sentence
// is about what was left out, and on a watch day nothing was.
export function scopeLine(registry = null) {
  const checks = registry === null ? cutoverChecks : registry.list()
  const conditions = checks.filter((check) => check.dimension === 'cutover').length
  const present = new Set(checks.map((check) => check.dimension))
  const missing = AUDIT_DIMENSIONS_A_WATCH_ADDS.filter((dimension) => !present.has(dimension))
  if (missing.length === 0) return null
  return `This run checked the ${conditions} cutover conditions only; the full audit’s ${andList(missing)} dimensions were not re-run — use --mode watch for those.`
}

// The "Not covered" section for a post-launch run: the engine's standard lines, then everything
// this run could not do, then the two things no crawl can ever see.
export function cutoverNotCovered(ctx, { tier, skipped = [], ownLines = [], browserLines = [], registry = null }) {
  let notCovered = buildNotCovered({
    dropped: ctx.crawl.dropped ?? [],
    browserAvailable: tier.available,
    browserReason: tier.reason,
    skipped,
    ignoredRobots: ctx.options.ignoreRobots === true,
    psiSkipped: null,
  })
  const scope = scopeLine(registry)
  return insertBeforeFixed(notCovered, [
    ...ownLines, ...(ctx.gaps ?? []), ...capLines(ctx.probes.caps), ...browserLines,
    ...(scope === null ? [] : [scope]),
  ])
}

// ------------------------------------------------------------------------------------ the run

export function cutoverOutDir({ options, now, cwd }) {
  return resolveOutDir({
    out: options.out,
    slug: slugify(new URL(options.url).hostname),
    phase: PHASE,
    now,
    cwd,
  })
}

export async function runCutover({ net, dns, browser = null, options = {}, now = new Date(), cwd = process.cwd() } = {}) {
  const at = now instanceof Date ? now : new Date(now)
  try {
    const ctx = await buildCutoverContext({ net, dns, options, now: at })
    const { tier, lines: browserLines } = await renderStartPage(ctx, browser)
    ctx.browser = tier

    const registry = options.registry ?? cutoverRegistry()
    const { findings, lines, skipped } = await runChecksOver(ctx, registry)
    const sorted = sortFindings(findings)
    const notCovered = cutoverNotCovered(ctx, { tier, skipped, ownLines: lines, browserLines, registry })
    const summary = summaryOf(sorted, ctx.crawl.pages.length)

    const report = renderCutoverReport({
      target: ctx.target.url,
      generatedAt: at.toISOString(),
      findings: sorted,
      notCovered,
      summary,
    })

    const bundleDir = cutoverOutDir({ options, now: at, cwd })
    const extra = []
    if (ctx.baselineDiff !== null) {
      extra.push({ name: 'baseline-diff.json', content: `${JSON.stringify(ctx.baselineDiff, null, 2)}\n` })
    }
    const { files } = writeBundle(bundleDir, {
      report,
      findings: sorted,
      crawl: ctx.crawl,
      baseline: ctx.productionBaseline,
      extra,
      alsoWritten: screenshotNames(ctx.browser, bundleDir),
    })

    return {
      ctx,
      findings: sorted,
      diff: ctx.baselineDiff,
      baseline: ctx.productionBaseline,
      notCovered,
      humanItems: sorted.filter((f) => f.id === 'cutover.human-items').flatMap((f) => f.evidence.map((e) => e.value)),
      summary,
      bundleDir,
      files,
    }
  } finally {
    if (typeof browser?.close === 'function') await browser.close()
  }
}
