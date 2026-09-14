#!/usr/bin/env node
// post-launch — verify the cutover the moment DNS moves, then watch the site for thirty days.
//
// Two modes, one script, and the same posture as the auditor: it reads, it reports, it exits 0.
// Nothing here edits a site, submits a form, flips a setting or touches DNS. The only thing it
// writes outside its own report bundle is `watch.json`, the operator's record of which days of the
// watch were actually run.
//
//   --mode cutover   the twelve questions of cutover day, in the order the day depends on them
//   --mode watch     one day of the thirty: the cutover checks again, the four audit dimensions
//                    that drift after a launch, and what is due today
//
// The two rules this file enforces that the libraries cannot:
//
// - **Blockers are read first and announced last.** The terminal summary leads with the bolded
//   blockers, whatever order the day puts them in, and the human items end with "announce only
//   after this report is clean". A launch announced over a live noindex cannot be un-announced.
// - **"Not covered" ships verbatim.** Every line, every run, including the two things no crawl can
//   ever see. A cutover report that implies it checked the baseline it was never given is worse
//   than no report.
//
// Exit codes: 0 always, however bad the cutover is — this reports, it does not gate. 2 for a usage
// error, for `--browser on` with no browser, and for an unexpected failure such as a bad `--out`.

import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

import { defineArgs } from '../../launch-audit/scripts/lib/args.mjs'
import { createNet } from '../../launch-audit/scripts/lib/net.mjs'
import { createDns } from '../../launch-audit/scripts/lib/dns.mjs'
import { createBrowser } from '../../launch-audit/scripts/lib/browser.mjs'
import { recordedNetFromPath, offlineDnsResolvers } from '../../launch-audit/scripts/lib/recorded-net.mjs'
import { SEVERITIES } from '../../launch-audit/scripts/lib/findings.mjs'
import { cutoverOutDir, parseExpectDns, runCutover, messageOf } from './lib/cutover.mjs'
import { HUMAN_ITEMS } from './lib/checks/cutover.mjs'
import { runWatch, watchOutDir } from './lib/watch.mjs'
import { WATCH_DAYS } from './lib/plan.mjs'

const MODES = ['cutover', 'watch']
const BROWSER_MODES = ['auto', 'on', 'off']
const WORST_LIMIT = 10

export const args = defineArgs({
  name: 'post-launch',
  description: 'Verify a cutover the moment DNS moves, diff production against the pre-launch baseline, and run the thirty-day watch. Read-only: it never edits a site, submits a form or touches DNS.',
  flags: {
    mode: { type: 'string', required: true, help: `cutover (the day itself) or watch (one day of the ${WATCH_DAYS})` },
    url: { type: 'string', required: true, help: 'the production url, now that DNS has moved' },
    baseline: { type: 'string', help: 'baseline.json from pre-launch or from a staging launch-audit run' },
    'old-url': { type: 'string', help: 'the site being replaced, to confirm it now redirects' },
    redirects: { type: 'string', help: "redirects.csv from the audit, re-requested row by row" },
    'expect-analytics': { type: 'string', help: 'the measurement id that must be present (used when there is no baseline)' },
    'staging-url': { type: 'string', help: 'the staging copy, to confirm it is now sealed' },
    'expect-dns': { type: 'string', help: 'the records DNS should now answer, as apex=1.2.3.4,www=cname.host' },
    day: { type: 'number', help: `which day of the ${WATCH_DAYS}-day watch this is (watch mode; default: counted from the first run)` },
    'dev-host': { type: 'list', help: 'a staging or dev hostname that must not appear on the live site (repeatable)' },
    browser: { type: 'string', default: 'auto', help: 'browser tier: auto, on (fail if unavailable) or off' },
    out: { type: 'string', help: 'write the bundle here instead of ./website-launch/<slug>-post-launch[-<date>]' },
  },
})

const EXTRA_HELP = [
  '',
  'Modes:',
  '  --mode cutover   run this the moment DNS has moved. It checks DNS propagation, the',
  '                   certificate, http and www redirects, that the noindex is gone, robots and',
  '                   sitemap on the live host, every row of redirects.csv, the baseline diff,',
  '                   analytics, form endpoints, the staging copy, the old host and the security',
  '                   headers — then prints the six things a person still has to do.',
  `  --mode watch     run this once a day for ${WATCH_DAYS} days. It prints what is due today and`,
  '                   re-runs the automated part.',
  '',
  'Output: a bundle directory holding report.md, findings.json, crawl.json, baseline.json,',
  'manifest.json, baseline-diff.json (with --baseline), and in watch mode plan.json and watch.json.',
  'Cutover mode writes a dated directory; the watch writes one stable directory it reuses.',
  '',
  'Exit codes: 0 always, however bad the cutover is — this reports, it does not gate.',
  '            2 for a usage error, for --browser on with no browser available, and for an',
  '            unexpected failure (a bad --out path, say).',
  '',
  "Testing hooks, used by this repo's tests; a normal run sets none of them:",
  '  WEBSITE_LAUNCH_RECORDED_FIXTURE=<path to a recorded-responses JSON file>',
  '            run against those recordings instead of the network.',
  '  WEBSITE_LAUNCH_RESOLVERS_FIXTURE=<path to a JSON file of resolver answers>',
  '            answer the public-resolver sample from that file instead of asking 8.8.8.8,',
  '            1.1.1.1, 9.9.9.9 and 208.67.222.222. Shape: {"<resolver ip>": {"<host>":',
  '            {"a": [], "aaaa": [], "cname": null}}}.',
  '  WEBSITE_LAUNCH_BROWSER_LOADER=fail',
  "            make the browser tier's playwright loader throw, as a machine without it would.",
  '  WEBSITE_LAUNCH_DEBUG=1',
  '            print the stack trace of an unexpected failure, not only its message.',
].join('\n')

// ---------------------------------------------------------------------------- the testing hooks

// A `makeResolver` that answers from a file instead of from the network, so the propagation sample
// can be exercised without asking four public resolvers about a host that does not exist.
function fixtureMakeResolver(path) {
  const table = JSON.parse(readFileSync(path, 'utf8'))
  return async (ip) => {
    const perHost = table[ip]
    if (perHost === undefined) {
      const error = new Error(`${ip} did not answer (recorded run)`)
      error.code = 'ECONNREFUSED'
      throw error
    }
    const answerFor = (host) => perHost[host] ?? {}
    return {
      resolve4: async (host) => answerFor(host).a ?? [],
      resolve6: async (host) => answerFor(host).aaaa ?? [],
      resolveCname: async (host) => {
        const cname = answerFor(host).cname
        return cname ? [cname] : []
      },
    }
  }
}

// A resolver that refuses, for a recorded run that was given no resolver fixture: a recording has
// no DNS in it, and reaching the real network from a test would be worse than saying so.
const offlineMakeResolver = async (ip) => {
  const error = new Error(`${ip} was not asked (recorded run with no resolver fixture)`)
  error.code = 'ECONNREFUSED'
  throw error
}

function adapters() {
  const fixture = process.env.WEBSITE_LAUNCH_RECORDED_FIXTURE
  const resolversFixture = process.env.WEBSITE_LAUNCH_RESOLVERS_FIXTURE
  const net = fixture ? recordedNetFromPath(fixture) : createNet()
  let dns
  if (resolversFixture) {
    dns = createDns({ ...(fixture ? offlineDnsResolvers() : {}), makeResolver: fixtureMakeResolver(resolversFixture) })
  } else if (fixture) {
    dns = createDns({ ...offlineDnsResolvers(), makeResolver: offlineMakeResolver })
  } else {
    dns = createDns()
  }
  return { net, dns }
}

// ------------------------------------------------------------------------------ the terminal

const severityLine = (summary) => SEVERITIES
  .map((severity) => `${severity} ${summary[severity === 'blocker' ? 'blockers' : severity]}`)
  .join('   ')

// Blockers first, bolded, whatever order the day put them in; then the highs. This is the one
// ordering that never follows the report's day order, because a blocker found at step six still
// has to be the first thing anybody reads.
function worstFirst(findings) {
  const out = []
  const blockers = findings.filter((f) => f.severity === 'blocker')
  for (const finding of blockers) out.push(`**BLOCKER** ${finding.title} — ${finding.page ?? 'site-wide'}`)
  const high = findings.filter((f) => f.severity === 'high')
  for (const finding of high.slice(0, WORST_LIMIT)) out.push(`[high] ${finding.title} — ${finding.page ?? 'site-wide'}`)
  if (high.length > WORST_LIMIT) out.push(`[high] ... and ${high.length - WORST_LIMIT} more, in report.md`)
  return out
}

function printPlan(day, plan) {
  const out = [`Day ${day} of ${WATCH_DAYS}`, '']
  const section = (label, due) => {
    const entries = plan.filter((entry) => entry.due === due)
    if (entries.length === 0) return
    out.push(`${label}:`)
    for (const entry of entries) {
      out.push(`  - day ${entry.day}: ${entry.task}${entry.automated ? '' : '  [human]'}`)
      if (entry.automated && entry.command !== null) out.push(`      ${entry.command}`)
    }
    out.push('')
  }
  section('Overdue', 'overdue')
  section('Due today', 'today')
  section('Coming up', 'upcoming')
  process.stdout.write(`${out.join('\n')}\n`)
}

function printSummary(result, { mode }) {
  const out = []
  out.push(`Bundle: ${result.bundleDir}`)
  out.push(`Pages crawled: ${result.summary.pages}`)
  out.push(severityLine(result.summary))

  const worst = worstFirst(result.findings)
  if (worst.length > 0) {
    out.push('')
    out.push('Read these first:')
    for (const line of worst) out.push(`  ${line}`)
  }

  out.push('')
  // On cutover day these gate the announcement. On a watch day the announcement has happened and
  // they are standing rules — most of all the one about keeping the old host up.
  out.push(mode === 'cutover' ? 'Before you announce:' : 'Standing human items:')
  for (const item of HUMAN_ITEMS) out.push(`  - ${item}`)

  out.push('')
  out.push('Not covered:')
  for (const line of result.notCovered) out.push(`  - ${line}`)

  out.push('')
  out.push(result.summary.blockers > 0
    ? 'There is a blocker. Fix it, re-run this, and do not announce the launch until the report is clean.'
    : mode === 'cutover'
      ? 'Read report.md end to end, work the human items, then announce. Repeat Not covered verbatim to whoever asked.'
      : 'Read report.md, then work whatever is still overdue above. Repeat Not covered verbatim.')
  process.stdout.write(`${out.join('\n')}\n`)
}

// ------------------------------------------------------------------------------------- the CLI

function usageError(errors, help) {
  process.stderr.write(`${errors.map((e) => `error: ${e}`).join('\n')}\n\n${help}\n${EXTRA_HELP}\n`)
  process.exitCode = 2
}

async function runCli(argv, { cwd, now }) {
  const { values, errors, help } = args.parse(argv)

  if (values.help) {
    process.stdout.write(`${help}\n${EXTRA_HELP}\n`)
    process.exitCode = 0
    return
  }

  if (values.mode !== undefined && !MODES.includes(values.mode)) {
    errors.push(`--mode must be one of ${MODES.join(', ')}`)
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
  if (values.day !== undefined) {
    if (!Number.isInteger(values.day) || values.day < 1 || values.day > WATCH_DAYS) {
      errors.push(`--day must be a whole number from 1 to ${WATCH_DAYS}`)
    }
    // Cutover day is one day and it is today. Accepting --day there would look like it scoped the
    // run to a day of the watch, and it would silently do nothing at all.
    if (values.mode === 'cutover') errors.push('--day applies to --mode watch')
  }

  let expectDns = null
  try {
    expectDns = parseExpectDns(values['expect-dns'])
  } catch (error) {
    errors.push(messageOf(error))
  }

  if (errors.length > 0) {
    usageError(errors, help)
    return
  }

  const options = {
    url: values.url,
    baseline: values.baseline,
    oldUrl: values['old-url'],
    redirectsCsv: values.redirects,
    expectAnalytics: values['expect-analytics'],
    stagingUrl: values['staging-url'],
    expectDns,
    devHosts: values['dev-host'],
    day: values.day,
    out: values.out,
  }

  const { net, dns } = adapters()

  // The browser writes its screenshots inside the bundle, so the bundle path is settled first.
  // Both resolvers are pure over these inputs, so this is the directory the run will write to.
  const outDir = values.mode === 'watch' ? watchOutDir({ options, cwd }) : cutoverOutDir({ options, now, cwd })
  const browser = createBrowser({
    mode: values.browser,
    outDir,
    ...(process.env.WEBSITE_LAUNCH_BROWSER_LOADER === 'fail'
      ? { loader: () => { throw new Error('playwright not installed (test hook)') } }
      : {}),
  })

  // `--browser on` is a person saying "I want the rendered tier". Quietly falling back to HTTP
  // would hand them a report that looks complete and is not.
  if (values.browser === 'on' && (await browser.open()) !== true) {
    process.stderr.write(`error: --browser on, but the browser tier could not start: ${browser.reason}\n`)
    process.exitCode = 2
    return
  }

  const result = values.mode === 'watch'
    ? await runWatch({ net, dns, browser, options, now, cwd })
    : await runCutover({ net, dns, browser, options, now, cwd })

  if (values.json) {
    process.stdout.write(`${JSON.stringify({
      bundle: result.bundleDir,
      files: result.files,
      summary: result.summary,
      notCovered: result.notCovered,
      ...(values.mode === 'watch' ? { plan: result.plan } : {}),
    }, null, 2)}\n`)
  } else {
    // The due list comes first on a watch day: it is the reason somebody ran the command.
    if (values.mode === 'watch') printPlan(result.day, result.plan)
    printSummary(result, { mode: values.mode })
  }

  process.exitCode = 0
}

// A stack trace is not a report, so the boundary turns an unexpected failure into the same shape a
// usage error has: one line on stderr and exit 2.
export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), now = new Date() } = {}) {
  try {
    await runCli(argv, { cwd, now })
  } catch (error) {
    process.stderr.write(`error: ${messageOf(error)}\n`)
    if (process.env.WEBSITE_LAUNCH_DEBUG === '1' && error?.stack) process.stderr.write(`${error.stack}\n`)
    process.exitCode = 2
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
