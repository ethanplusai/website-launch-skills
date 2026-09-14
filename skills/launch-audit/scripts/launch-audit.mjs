#!/usr/bin/env node
// launch-audit — crawl a staging or live site and report what is wrong with it.
//
// This is the orchestrator. It owns the order of the audit and nothing else: every fact comes from
// `lib/checks/_ctx.mjs`, every judgement from a check module, every line of prose from
// `lib/report.mjs`. The whole run is one function, `runAudit`, over injected adapters — a `net`, a
// `dns` and an optional `browser` — so the tests drive it against recorded responses with no
// socket, no browser and no clock.
//
// The shape of a run:
//
//   1. build the audit context (one pass of fetching, all of it capped and every cap recorded)
//   2. run the browser tier, if there is a browser, over a small sample of pages
//   3. run every registered check over that context, catching whatever a check does wrong
//   4. assemble the ops checklist, the baseline, and the mandatory "Not covered" section
//   5. write the bundle, print a summary a person can act on, and exit 0
//
// Exit 0, always, except a usage error (exit 2) and `--browser on` with no browser to run. This is
// the auditor, not the gate: it reports fifty blockers and still exits 0, because the thing that
// blocks a launch is `pre-launch`, and a reporting tool that fails a build teaches people to stop
// running it.
//
// Three rules this file enforces that the rest of the engine cannot:
//
// - **A crash is a coverage gap, not a stack trace.** A check that throws costs that check, not
//   the run, and its absence is written into "Not covered" by name. A report that is silently
//   short one dimension is worse than one that says which dimension is missing.
// - **A finding that fails validation never ships.** It is dropped, and the drop is reported the
//   same way. Evidence is the promise this tool makes; an unvalidated finding breaks it quietly.
// - **Every cap is named.** The page caps, the probe caps, the browser sample, the tools that were
//   not installed. "Not covered" is the section that makes the rest of the report trustworthy.

import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { defineArgs } from './lib/args.mjs'
import { createNet } from './lib/net.mjs'
import { createDns } from './lib/dns.mjs'
import { createBrowser } from './lib/browser.mjs'
import { recordedNetFromFile, offlineDnsResolvers } from './lib/recorded-net.mjs'
import { createRegistry, SkipCheck } from './lib/registry.mjs'
import { validateFinding, sortFindings, SEVERITIES } from './lib/findings.mjs'
import { buildAuditContext } from './lib/checks/_ctx.mjs'
import { buildNotCovered, renderReport, writeBundle, resolveOutDir } from './lib/report.mjs'
import { makeBaseline, diffBaseline } from './lib/baseline.mjs'
import { detectAnalytics } from './lib/detect/analytics.mjs'
import { slugify } from './lib/slug.mjs'
import { OPS_CHECKLIST } from './lib/checks/ops.mjs'
import { redirectsCsv } from './lib/checks/redirects.mjs'

import * as inventory from './lib/checks/inventory.mjs'
import * as indexability from './lib/checks/indexability.mjs'
import * as host from './lib/checks/host.mjs'
import * as head from './lib/checks/head.mjs'
import * as links from './lib/checks/links.mjs'
import * as images from './lib/checks/images.mjs'
import * as forms from './lib/checks/forms.mjs'
import * as a11y from './lib/checks/a11y.mjs'
import * as perf from './lib/checks/perf.mjs'
import * as analytics from './lib/checks/analytics.mjs'
import * as content from './lib/checks/content.mjs'
import * as redirects from './lib/checks/redirects.mjs'
import * as ops from './lib/checks/ops.mjs'
import * as browserTier from './lib/checks/browser-tier.mjs'

const PHASE = 'launch-audit'

// Dimension order is the order a person should read them in, which is roughly "can it be found,
// can it be reached, is it right, is it fast" — and the registry preserves insertion order, so
// this list is also the order `docs/checks.md` comes out in.
const CHECK_MODULES = [
  inventory, indexability, host, head, links, images, forms, a11y, perf, analytics, content,
  redirects, ops, browserTier,
]

// The start page plus five more. Rendering every page of a site is an audit nobody runs twice, and
// five extra pages is enough to cover the templates a small site actually has.
const BROWSER_SAMPLE_EXTRA = 5

// The response headers a baseline records, so a post-launch diff can say "the CSP is gone" rather
// than "something about the headers changed".
const BASELINE_SECURITY_HEADERS = [
  'strict-transport-security', 'content-security-policy', 'x-content-type-options', 'x-frame-options',
  'referrer-policy', 'permissions-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy',
]

// PageSpeed Insights is out of scope for v1 (spec §9). The flag is accepted so a run that carries
// a key in a config file is not a usage error, and the reason says plainly that nothing used it.
const PSI_OUT_OF_SCOPE = 'PageSpeed Insights is out of scope for v1; --psi-key was not used'
const PSI_NO_KEY = 'no --psi-key'

const messageOf = (error) => (error?.message === undefined || error.message === '' ? String(error) : error.message)

// ---------------------------------------------------------------------------------- the registry

export function buildRegistry() {
  const registry = createRegistry()
  for (const module of CHECK_MODULES) for (const check of module.checks) registry.add(check)
  return registry
}

// ----------------------------------------------------------------------------------- the browser

const firstSegment = (url) => {
  try {
    return new URL(url).pathname.split('/').filter(Boolean)[0] ?? ''
  } catch {
    return ''
  }
}

const htmlPages = (crawl) => crawl.pages.filter((p) => p.page !== null && p.status >= 200 && p.status < 300)

// Which pages to render. The start page always, then up to five more chosen for template variety:
// one page per distinct first path segment first (a blog post, a product, a legal page are three
// different templates; three blog posts are one), shallowest first, and only then the shallowest
// remaining pages. Rendering six pages of one template would produce six copies of one finding.
export function sampleForBrowser(ctx) {
  const start = ctx.target.url
  const pages = htmlPages(ctx.crawl)
  const picked = []
  const seen = new Set()
  const take = (url) => {
    if (seen.has(url)) return
    seen.add(url)
    picked.push(url)
  }

  take(start)

  const rest = pages.filter((entry) => !seen.has(entry.url))
  const byDepth = (a, b) => (a.depth ?? 0) - (b.depth ?? 0) || a.url.localeCompare(b.url)

  const perSegment = new Map()
  for (const entry of rest) {
    const segment = firstSegment(entry.url)
    const best = perSegment.get(segment)
    if (best === undefined || byDepth(entry, best) < 0) perSegment.set(segment, entry)
  }

  const limit = BROWSER_SAMPLE_EXTRA + 1
  for (const entry of [...perSegment.values()].sort(byDepth)) {
    if (picked.length >= limit) break
    take(entry.url)
  }
  for (const entry of [...rest].sort(byDepth)) {
    if (picked.length >= limit) break
    take(entry.url)
  }
  return picked
}

const unavailableTier = (reason) => ({
  available: false, reason, renders: new Map(), axe: new Map(), lighthouse: [], sampled: [],
})

// Runs whatever the browser tier can run and returns the `ctx.browser` the check modules read,
// plus the lines "Not covered" needs about the tools that were not there. A tool that reports
// itself unavailable is asked once and then left alone: axe is missing for the whole run or for
// none of it, and re-probing it per page would add nothing but time.
async function runBrowserTier(ctx, browser) {
  if (browser === null || browser === undefined) {
    return { tier: unavailableTier('no browser adapter was supplied to this run'), lines: [] }
  }

  let opened = browser.available === true
  if (!opened && typeof browser.open === 'function') opened = (await browser.open()) === true
  if (!opened) return { tier: unavailableTier(browser.reason ?? 'the browser tier did not open'), lines: [] }

  const sampled = sampleForBrowser(ctx)
  const renders = new Map()
  const axe = new Map()
  // An array of pairs rather than a Map: the start page is measured twice, mobile and desktop, and
  // two results for one url cannot both live in a map keyed by url.
  const lighthouse = []
  let axeReason = null
  let lighthouseReason = null

  for (const url of sampled) {
    if (typeof browser.render === 'function') renders.set(url, await browser.render(url))

    if (axeReason === null && typeof browser.axe === 'function') {
      const result = await browser.axe(url)
      if (result?.available === true) axe.set(url, result)
      else axeReason = result?.reason ?? 'axe did not run'
    }

    if (lighthouseReason === null && typeof browser.lighthouse === 'function') {
      for (const formFactor of url === ctx.target.url ? ['mobile', 'desktop'] : ['mobile']) {
        const result = await browser.lighthouse(url, { formFactor })
        if (result?.available === true) {
          lighthouse.push([url, result])
        } else {
          lighthouseReason = result?.reason ?? 'lighthouse did not run'
          break
        }
      }
    }
  }

  const lines = []
  if (axeReason !== null) lines.push(`axe: not run — ${axeReason}`)
  if (lighthouseReason !== null) lines.push(`lighthouse: not run — ${lighthouseReason}`)
  lines.push(`Browser tier rendered ${renders.size} of ${htmlPages(ctx.crawl).length} pages`)

  return { tier: { available: true, reason: null, renders, axe, lighthouse, sampled }, lines }
}

// ---------------------------------------------------------------------------------- the ops list

// An item is auto-verified when the check that owns it produced nothing worth acting on. `auto` is
// either a check id (`ops.email-auth`) or a whole dimension (`forms`), and info findings do not
// count against it: `forms.inventory` and `analytics.summary` are listings of what exists, not
// failures, and counting them would leave those two items permanently unverifiable.
export function buildOps(findings) {
  const actionable = findings.filter((f) => f.severity !== 'info')
  return OPS_CHECKLIST.map((item) => {
    if (item.auto === null) return { label: item.label, autoVerifiedBy: null }
    const flagged = actionable.some((f) => f.id === item.auto || f.id.startsWith(`${item.auto}.`))
    return { label: item.label, autoVerifiedBy: flagged ? null : item.auto }
  })
}

// ------------------------------------------------------------------------------- "Not covered"

// buildNotCovered ends with two unconditional lines — copy vs. source and pages vs. scope — that
// have to stay last, because they are the two things no crawl can ever see and a reader should
// leave the section on them. Anything this orchestrator words itself goes in just above them.
function insertBeforeFixed(lines, extra) {
  if (extra.length === 0) return lines
  const at = lines.findIndex((line) => line.startsWith('Copy vs. source documents'))
  if (at === -1) return [...lines, ...extra]
  return [...lines.slice(0, at), ...extra, ...lines.slice(at)]
}

// One line per capped probe set that actually dropped something, plus the one cap that is a skip
// rather than a truncation (an --old-url on the origin being audited).
function capLines(caps) {
  const lines = []
  for (const [set, cap] of Object.entries(caps ?? {})) {
    if (typeof cap?.skipped === 'string') lines.push(`${set}: not probed — ${cap.skipped}`)
    const dropped = cap?.dropped ?? 0
    if (dropped > 0) lines.push(`${set}: ${dropped} of ${dropped + cap.cap} not probed (cap ${cap.cap})`)
  }
  return lines
}

// ----------------------------------------------------------------------------------- the baseline

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

// ---------------------------------------------------------------------------------- the audit

export function auditOutDir({ options, now, cwd }) {
  return resolveOutDir({
    out: options.out,
    slug: slugify(new URL(options.url).hostname),
    phase: PHASE,
    now,
    cwd,
  })
}

export async function runAudit({ net, dns, browser = null, options = {}, now = new Date(), cwd = process.cwd() } = {}) {
  const at = now instanceof Date ? now : new Date(now)
  const registry = options.registry ?? buildRegistry()
  const knownIds = registry.ids()

  try {
    const ctx = await buildAuditContext(net, dns, { ...options, now: at })

    // The browser tier runs before the checks, because two http-tier checks (`a11y` and `perf`)
    // read `ctx.browser` to say, once, that the deeper check did not run and why. A check that saw
    // `null` there would report "no browser adapter" on a run where a browser rendered six pages.
    const { tier, lines: browserLines } = await runBrowserTier(ctx, browser)
    ctx.browser = tier

    const findings = []
    const skipped = []
    const ownLines = []

    for (const check of registry.byPhase(PHASE)) {
      let produced
      try {
        produced = await check.run(ctx)
      } catch (error) {
        // A check may skip itself on purpose; anything else is a bug in the check, and it costs
        // that check rather than the run.
        if (error instanceof SkipCheck) skipped.push({ check: check.id, reason: error.reason })
        else ownLines.push(`${check.id}: check crashed — ${messageOf(error)}`)
        continue
      }
      if (!Array.isArray(produced)) {
        ownLines.push(`${check.id}: check crashed — run() did not return an array`)
        continue
      }
      for (const candidate of produced) {
        const { ok, errors } = validateFinding(candidate, knownIds)
        if (!ok) {
          ownLines.push(`${check.id}: finding dropped as invalid — ${errors.join('; ')}`)
          continue
        }
        findings.push(candidate)
      }
    }

    const sorted = sortFindings(findings)

    const unverifiableExternals = sorted
      .filter((f) => f.id === 'links.external-unverifiable')
      .map((f) => f.evidence.find((e) => e.type === 'url')?.value)
      .filter((value) => typeof value === 'string')

    let notCovered = buildNotCovered({
      dropped: ctx.crawl.dropped ?? [],
      browserAvailable: tier.available,
      browserReason: tier.reason,
      skipped,
      unverifiableExternals,
      ignoredRobots: options.ignoreRobots === true,
      psiSkipped: options.psiKey ? PSI_OUT_OF_SCOPE : PSI_NO_KEY,
    })
    notCovered = insertBeforeFixed(notCovered, [...ownLines, ...capLines(ctx.probes.caps), ...browserLines])

    const baseline = makeBaseline(ctx.crawl, {
      now: at,
      securityHeaders: securityHeadersOf(ctx),
      // net.cert reports `validTo`; a baseline records it as `expires`, which is what post-launch
      // reads back.
      cert: ctx.cert === null ? null : { expires: ctx.cert.validTo, daysLeft: ctx.cert.daysLeft },
      robotsHash: ctx.robots.text === null ? null : createHash('sha256').update(ctx.robots.text).digest('hex'),
      sitemapUrls: ctx.sitemaps.urls,
      analyticsByPage: analyticsByPage(ctx.crawl),
    })

    // A prior baseline turns this run into a comparison as well as an audit. An unreadable one is
    // a coverage gap, not a crash: the audit still ran, the comparison did not.
    let baselineDiff = null
    if (typeof options.baseline === 'string' && options.baseline !== '') {
      try {
        baselineDiff = diffBaseline(JSON.parse(readFileSync(options.baseline, 'utf8')), baseline)
      } catch (error) {
        notCovered = insertBeforeFixed(notCovered, [`Baseline comparison: skipped — ${messageOf(error)}`])
      }
    }

    const opsList = buildOps(sorted)
    const count = (severity) => sorted.filter((f) => f.severity === severity).length
    const summary = {
      pages: ctx.crawl.pages.length,
      blockers: count('blocker'),
      high: count('high'),
      medium: count('medium'),
      low: count('low'),
      info: count('info'),
    }

    const report = renderReport({
      phase: PHASE,
      target: ctx.target.url,
      generatedAt: at.toISOString(),
      findings: sorted,
      notCovered,
      ops: opsList,
      summary,
    })

    const bundleDir = auditOutDir({ options, now: at, cwd })
    const csv = options.oldUrl ? redirectsCsv(ctx) : null
    const { files } = writeBundle(bundleDir, {
      report,
      findings: sorted,
      crawl: ctx.crawl,
      baseline,
      redirectsCsv: csv === null ? undefined : csv,
      extra: baselineDiff === null ? [] : [{ name: 'baseline-diff.json', content: `${JSON.stringify(baselineDiff, null, 2)}\n` }],
    })

    return { findings: sorted, crawl: ctx.crawl, baseline, baselineDiff, notCovered, ops: opsList, summary, bundleDir, files }
  } finally {
    if (typeof browser?.close === 'function') await browser.close()
  }
}

// ------------------------------------------------------------------------------------- the CLI

const BROWSER_MODES = ['auto', 'on', 'off']

export const args = defineArgs({
  name: 'launch-audit',
  description: 'Crawl a staging or live site and report what would go wrong at launch. Read-only: it never submits, clicks or edits anything.',
  flags: {
    url: { type: 'string', required: true, help: 'the site to audit, staging or live' },
    'old-url': { type: 'string', help: 'the site being replaced, to build the redirect map' },
    'dev-host': { type: 'list', help: 'a staging or dev hostname that must not appear in the new site (repeatable)' },
    'psi-key': { type: 'string', help: 'PageSpeed Insights API key (accepted; PSI is out of scope for v1)' },
    'max-pages': { type: 'number', default: 200, help: 'stop crawling after this many pages' },
    'max-depth': { type: 'number', default: 4, help: 'stop crawling below this link depth' },
    'ignore-robots': { type: 'boolean', default: false, help: 'crawl urls robots.txt disallows (reported in Not covered)' },
    staging: { type: 'boolean', default: false, help: 'the target is staging, so a site-wide noindex is expected' },
    baseline: { type: 'string', help: 'a baseline.json from an earlier run, to diff this one against' },
    browser: { type: 'string', default: 'auto', help: 'browser tier: auto, on (fail if unavailable) or off' },
    out: { type: 'string', help: 'write the bundle here instead of ./website-launch/<slug>-launch-audit-<date>' },
  },
})

const EXTRA_HELP = [
  '',
  'Output: a bundle directory holding report.md, findings.json, crawl.json, baseline.json,',
  'manifest.json, redirects.csv (with --old-url) and screenshots/ (browser tier).',
  '',
  'Exit codes: 0 always, however many findings there are — this reports, it does not gate.',
  '            2 for a usage error, or --browser on with no browser available.',
  '',
  'Testing hook: WEBSITE_LAUNCH_RECORDED_FIXTURE=<path to a recorded-responses JSON file> runs',
  '            the audit against those recordings instead of the network. Used by this repo\'s',
  '            tests; a normal run never sets it.',
].join('\n')

function severityLine(summary) {
  return SEVERITIES.map((severity) => {
    const key = severity === 'blocker' ? 'blockers' : severity
    return `${severity} ${summary[key]}`
  }).join('   ')
}

// What a person reads in the terminal: where the bundle is, how bad it is, the five findings to
// look at first, and the whole of "Not covered" — verbatim, because a truncated coverage list is
// how a report starts implying it checked things it did not.
function printSummary(result) {
  const out = []
  out.push(`Bundle: ${result.bundleDir}`)
  out.push(`Pages crawled: ${result.summary.pages}`)
  out.push(severityLine(result.summary))

  const worst = result.findings.filter((f) => f.severity === 'blocker' || f.severity === 'high').slice(0, 5)
  if (worst.length > 0) {
    out.push('')
    out.push('Worst first:')
    for (const finding of worst) out.push(`  [${finding.severity}] ${finding.title} — ${finding.page ?? 'site-wide'}`)
  }

  out.push('')
  out.push('Not covered:')
  for (const line of result.notCovered) out.push(`  - ${line}`)
  out.push('')
  out.push('Read report.md, then the screenshots. Repeat Not covered to whoever asked for the audit.')
  process.stdout.write(`${out.join('\n')}\n`)
}

function usageError(errors, help) {
  process.stderr.write(`${errors.map((e) => `error: ${e}`).join('\n')}\n\n${help}\n${EXTRA_HELP}\n`)
  process.exitCode = 2
}

export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), now = new Date() } = {}) {
  const { values, errors, help } = args.parse(argv)

  if (values.help) {
    process.stdout.write(`${help}\n${EXTRA_HELP}\n`)
    process.exitCode = 0
    return
  }

  if (!BROWSER_MODES.includes(values.browser)) {
    errors.push(`--browser must be one of ${BROWSER_MODES.join(', ')}`)
  }
  if (values.url !== undefined) {
    try {
      const parsed = new URL(values.url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') errors.push('--url must be http or https')
    } catch {
      errors.push(`--url is not a url: ${values.url}`)
    }
  }

  if (errors.length > 0) {
    usageError(errors, help)
    return
  }

  const options = {
    url: values.url,
    oldUrl: values['old-url'],
    devHosts: values['dev-host'],
    psiKey: values['psi-key'],
    maxPages: values['max-pages'],
    maxDepth: values['max-depth'],
    ignoreRobots: values['ignore-robots'] === true,
    staging: values.staging === true,
    baseline: values.baseline,
    out: values.out,
  }

  const fixture = process.env.WEBSITE_LAUNCH_RECORDED_FIXTURE
  const net = fixture ? recordedNetFromFile(fixture) : createNet()
  const dns = fixture ? createDns(offlineDnsResolvers()) : createDns()

  // The browser writes its screenshots inside the bundle, so the bundle path is settled first.
  // resolveOutDir is pure over these inputs, so the directory runAudit writes to is this one.
  const outDir = auditOutDir({ options, now, cwd })
  const browser = createBrowser({ mode: values.browser, outDir })

  // `--browser on` is a person saying "I want the rendered tier". Quietly falling back to HTTP
  // would hand them a report that looks complete and is not.
  if (values.browser === 'on' && (await browser.open()) !== true) {
    process.stderr.write(`error: --browser on, but the browser tier could not start: ${browser.reason}\n`)
    process.exitCode = 2
    return
  }

  const result = await runAudit({ net, dns, browser, options, now, cwd })

  if (values.json) {
    process.stdout.write(`${JSON.stringify({
      bundle: result.bundleDir,
      files: result.files,
      summary: result.summary,
      notCovered: result.notCovered,
    }, null, 2)}\n`)
  } else {
    printSummary(result)
  }

  process.exitCode = 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
