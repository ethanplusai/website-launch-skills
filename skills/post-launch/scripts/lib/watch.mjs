// The watch: one day of the thirty, run.
//
// A watch day is the cutover checks again, plus the four audit dimensions that catch what drifts in
// the weeks after a launch — what the crawl can still reach (`inventory`), what still links to what
// (`links`), what the pages say about themselves (`head`), and what search engines are still being
// told (`indexability`). The other dimensions are not re-run: images, performance and accessibility
// do not change because DNS moved, and running them daily would bury the four that do.
//
// The bundle directory is **stable** rather than dated — `website-launch/<slug>-post-launch/` — so
// thirty days of runs leave one directory with the latest report in it and one `watch.json`
// recording every run. A dated directory per day would leave thirty bundles nobody opens and no
// single place to look.
//
// `watch.json` is the operator's own record and the only thing this skill writes outside a report
// bundle. It is read before the run (so the plan can say what is overdue) and appended after it.

import { join } from 'node:path'
import { existsSync } from 'node:fs'

import { ensureDir, readJson, writeJson } from '../../../launch-audit/scripts/lib/fs-util.mjs'
import { slugify } from '../../../launch-audit/scripts/lib/slug.mjs'
import { writeBundle, screenshotNames } from '../../../launch-audit/scripts/lib/report.mjs'
import { sortFindings } from '../../../launch-audit/scripts/lib/findings.mjs'

import * as inventory from '../../../launch-audit/scripts/lib/checks/inventory.mjs'
import * as links from '../../../launch-audit/scripts/lib/checks/links.mjs'
import * as head from '../../../launch-audit/scripts/lib/checks/head.mjs'
import * as indexability from '../../../launch-audit/scripts/lib/checks/indexability.mjs'

import {
  buildCutoverContext, cutoverNotCovered, cutoverRegistry, renderCutoverReport, renderStartPage,
  runChecksOver, summaryOf,
} from './cutover.mjs'
import { watchPlan, WATCH_DAYS } from './plan.mjs'

const STATE_FILE = 'watch.json'
const DAY_MS = 86_400_000

// The audit dimensions a watch day re-runs, in reading order.
export const WATCH_MODULES = [inventory, links, head, indexability]

const EMPTY_STATE = () => ({ startedAt: null, url: null, runs: [] })

// The stable directory this watch lives in. Not dated: thirty runs share one bundle and one state
// file, and the newest report is always the one at this path.
export function watchOutDir({ options, cwd }) {
  if (options.out) return options.out
  return join(cwd, 'website-launch', `${slugify(new URL(options.url).hostname)}-post-launch`)
}

// The state, or an empty watch. A missing file is a watch that has not started; an unreadable one
// is treated the same way rather than taking the run down — the day's checks still matter, and the
// next run rewrites the file.
export function readWatchState(dir) {
  const path = join(dir, STATE_FILE)
  if (!existsSync(path)) return EMPTY_STATE()
  let state
  try {
    state = readJson(path)
  } catch {
    return EMPTY_STATE()
  }
  if (!state || typeof state !== 'object' || !Array.isArray(state.runs)) return EMPTY_STATE()
  return { startedAt: state.startedAt ?? null, url: state.url ?? null, runs: state.runs }
}

// Appends one run. `startedAt` is set once, by the first run, and never moved: the watch is thirty
// days from the cutover, not thirty days from the last time somebody remembered to run it.
export function recordRun(dir, { url, day, at, blockers, high, bundle }) {
  ensureDir(dir)
  const previous = readWatchState(dir)
  const state = {
    startedAt: previous.startedAt ?? at,
    url: previous.url ?? url ?? null,
    runs: [...previous.runs, { day, at, blockers, high, bundle }],
  }
  writeJson(join(dir, STATE_FILE), state)
  return state
}

// Which day of the watch this is, when nobody said. Day 1 is the day of the cutover run itself, so
// a watch started this morning is on day 1 and one started a week ago is on day 8.
export function dayFor(state, now) {
  if (state.startedAt === null) return 1
  const started = new Date(state.startedAt).getTime()
  const at = (now instanceof Date ? now : new Date(now)).getTime()
  if (!Number.isFinite(started) || !Number.isFinite(at)) return 1
  const elapsed = Math.floor((at - started) / DAY_MS) + 1
  return Math.min(WATCH_DAYS, Math.max(1, elapsed))
}

export async function runWatch({ net, dns, browser = null, options = {}, now = new Date(), cwd = process.cwd() } = {}) {
  const at = now instanceof Date ? now : new Date(now)
  const bundleDir = watchOutDir({ options, cwd })
  // Read before the run: the plan has to say what was overdue *coming into* today, not what this
  // run has just covered.
  const previous = readWatchState(bundleDir)
  const day = Number.isFinite(Number(options.day)) && options.day !== undefined && options.day !== null
    ? Math.min(WATCH_DAYS, Math.max(1, Number(options.day)))
    : dayFor(previous, at)

  try {
    const ctx = await buildCutoverContext({ net, dns, options, now: at })
    const { tier, lines: browserLines } = await renderStartPage(ctx, browser)
    ctx.browser = tier

    const registry = options.registry ?? cutoverRegistry(WATCH_MODULES)
    const { findings, lines, skipped } = await runChecksOver(ctx, registry)
    const sorted = sortFindings(findings)
    const notCovered = cutoverNotCovered(ctx, { tier, skipped, ownLines: lines, browserLines, registry })
    const summary = summaryOf(sorted, ctx.crawl.pages.length)
    const plan = watchPlan(day, previous)

    const report = renderCutoverReport({
      target: ctx.target.url,
      generatedAt: at.toISOString(),
      findings: sorted,
      notCovered,
      summary,
      plan,
    })

    const extra = [{ name: 'plan.json', content: `${JSON.stringify({ day, of: WATCH_DAYS, plan }, null, 2)}\n` }]
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

    // Written after the bundle, and deliberately not part of it: watch.json outlives any one run,
    // so it must never be a file the next run's manifest can clean away.
    const state = recordRun(bundleDir, {
      url: ctx.target.url,
      day,
      at: at.toISOString(),
      blockers: summary.blockers,
      high: summary.high,
      bundle: bundleDir,
    })

    return {
      ctx, day, plan, state, findings: sorted, diff: ctx.baselineDiff, baseline: ctx.productionBaseline,
      notCovered, summary, bundleDir, files,
    }
  } finally {
    if (typeof browser?.close === 'function') await browser.close()
  }
}
