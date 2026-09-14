// The thirty-day watch: the schedule, what is due on a given day, and the state file that
// remembers which days were actually worked.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpDir } from './helpers.mjs'
import { SCHEDULE, WATCH_DAYS, watchPlan } from '../skills/post-launch/scripts/lib/plan.mjs'
import { readWatchState, recordRun, runWatch, watchOutDir, WATCH_MODULES } from '../skills/post-launch/scripts/lib/watch.mjs'
import { cutoverRegistry } from '../skills/post-launch/scripts/lib/cutover.mjs'
import {
  GOOD, BAD, PRODUCTION, BASELINE_BEFORE, REDIRECTS_BEFORE, PROPAGATED, EXPECT_DNS, NOW, cutoverNet,
} from './post-launch-helpers.mjs'
import { defaultCert, fakeResolvers } from './checks-helpers.mjs'
import { createDns } from '../skills/launch-audit/scripts/lib/dns.mjs'

const EMPTY = { startedAt: null, url: PRODUCTION, runs: [] }

// --------------------------------------------------------------------------------- the schedule

test('every scheduled task lands on an explicit day between 1 and 30', () => {
  assert.ok(SCHEDULE.length > 0)
  for (const row of SCHEDULE) {
    assert.ok(Array.isArray(row.days) && row.days.length > 0, `${row.task} has no days`)
    for (const day of row.days) {
      assert.ok(Number.isInteger(day) && day >= 1 && day <= WATCH_DAYS, `${row.task} is scheduled for day ${day}`)
    }
    assert.equal(typeof row.task, 'string')
    assert.equal(typeof row.automated, 'boolean')
    assert.ok(row.command === null || typeof row.command === 'string')
    if (row.automated) assert.ok(row.command !== null, `${row.task} is automated but names no command`)
  }
})

test('the daily window covers days 1, 2 and 3, and day 30 carries the retrospective and the old host', () => {
  const daily = SCHEDULE.filter((row) => row.days.includes(1))
  assert.ok(daily.length >= 5, 'the first day is the full cutover re-run plus the manual checks')
  for (const row of daily) assert.deepEqual(row.days, [1, 2, 3], `${row.task} is not a daily-1-3 row`)

  const thirty = SCHEDULE.filter((row) => row.days.includes(30)).map((row) => row.task.toLowerCase())
  assert.ok(thirty.some((task) => task.includes('retrospective')), 'day 30 has no retrospective')
  assert.ok(thirty.some((task) => task.includes('decommission')), 'day 30 never mentions the old host')
})

// ---------------------------------------------------------------------------------- watchPlan

test('watchPlan(1) marks the first day due today and nothing overdue', () => {
  const plan = watchPlan(1, EMPTY)
  const today = plan.filter((entry) => entry.due === 'today')
  assert.ok(today.length >= 5)
  for (const entry of today) assert.equal(entry.day, 1)
  assert.equal(plan.filter((entry) => entry.due === 'overdue').length, 0)
  assert.ok(today.some((entry) => entry.automated && entry.command.includes('--mode watch')))
})

test('watchPlan lists only the next seven days as upcoming', () => {
  const plan = watchPlan(1, EMPTY)
  const upcoming = plan.filter((entry) => entry.due === 'upcoming')
  assert.ok(upcoming.length > 0)
  for (const entry of upcoming) {
    assert.ok(entry.day > 1 && entry.day <= 8, `day ${entry.day} is further out than seven days`)
  }
})

test('watchPlan(9) with nothing recorded reports days 1 to 8 overdue', () => {
  const plan = watchPlan(9, EMPTY)
  const overdue = plan.filter((entry) => entry.due === 'overdue')
  assert.ok(overdue.length > 0)
  assert.deepEqual([...new Set(overdue.map((entry) => entry.day))].sort((a, b) => a - b), [1, 2, 3, 7])
  assert.ok(overdue.some((entry) => entry.automated), 'the automated re-runs are overdue too')
  assert.equal(plan.filter((entry) => entry.due === 'today').length, 0, 'nothing is scheduled for day 9')
  assert.ok(plan.filter((entry) => entry.due === 'upcoming').every((entry) => entry.day <= 16))
})

test('a recorded run covers the automated tasks of the days up to it, and never the human ones', () => {
  const state = { ...EMPTY, runs: [{ day: 8, at: NOW, blockers: 0, high: 0, bundle: '/tmp/x' }] }
  const plan = watchPlan(9, state)
  const overdue = plan.filter((entry) => entry.due === 'overdue')
  assert.equal(overdue.some((entry) => entry.automated), false, 'a run covers the automated work below it')
  assert.ok(overdue.length > 0, 'the human items stay overdue: a script never looked at Search Console')
})

test('watchPlan sorts overdue first, then today, then upcoming', () => {
  const rank = { overdue: 0, today: 1, upcoming: 2 }
  const plan = watchPlan(3, EMPTY)
  const ranks = plan.map((entry) => rank[entry.due])
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b))
})

test('watchPlan past the end of the watch has nothing upcoming left', () => {
  const plan = watchPlan(30, EMPTY)
  assert.equal(plan.filter((entry) => entry.due === 'upcoming').length, 0)
  assert.ok(plan.filter((entry) => entry.due === 'today').every((entry) => entry.day === 30))
})

// -------------------------------------------------------------------------------- the state file

test('an absent state file reads as an empty watch rather than a crash', () => {
  const tmp = tmpDir('watch-empty')
  try {
    const state = readWatchState(tmp.dir)
    assert.equal(state.startedAt, null)
    assert.deepEqual(state.runs, [])
  } finally {
    tmp.cleanup()
  }
})

test('a recorded run round-trips through watch.json and keeps the first startedAt', () => {
  const tmp = tmpDir('watch-roundtrip')
  try {
    const first = recordRun(tmp.dir, { url: PRODUCTION, day: 1, at: NOW, blockers: 1, high: 2, bundle: tmp.dir })
    assert.equal(first.startedAt, NOW)
    assert.equal(first.url, PRODUCTION)
    assert.deepEqual(first.runs.map((r) => r.day), [1])

    const later = recordRun(tmp.dir, { url: PRODUCTION, day: 3, at: '2026-09-16T00:00:00.000Z', blockers: 0, high: 0, bundle: tmp.dir })
    assert.equal(later.startedAt, NOW, 'the watch started when it started')
    assert.deepEqual(later.runs.map((r) => r.day), [1, 3])

    const reread = readWatchState(tmp.dir)
    assert.deepEqual(reread, later)
    assert.deepEqual(Object.keys(reread.runs[0]).sort(), ['at', 'blockers', 'bundle', 'day', 'high'])
  } finally {
    tmp.cleanup()
  }
})

test('a corrupt watch.json reads as an empty watch instead of taking the run down', () => {
  const tmp = tmpDir('watch-corrupt')
  try {
    writeFileSync(join(tmp.dir, 'watch.json'), '{ not json')
    assert.deepEqual(readWatchState(tmp.dir).runs, [])
  } finally {
    tmp.cleanup()
  }
})

// ------------------------------------------------------------------------------------- runWatch

function watchNet() {
  const net = cutoverNet(GOOD)
  net.cert = async () => defaultCert('new.test')
  return net
}

const watchDns = () => {
  const dns = createDns(fakeResolvers())
  dns.resolveAcross = async (name) => PROPAGATED[name] ?? []
  return dns
}

const watchOptions = (over = {}) => ({
  url: PRODUCTION,
  random: () => 'deadbeef',
  baseline: BASELINE_BEFORE,
  redirectsCsv: REDIRECTS_BEFORE,
  oldUrl: 'https://old.test/',
  stagingUrl: 'https://staging.new.test/',
  expectAnalytics: 'G-ABC123',
  expectDns: EXPECT_DNS,
  ...over,
})

test('runWatch writes one stable bundle, a plan, and a run in watch.json', async () => {
  const tmp = tmpDir('watch-run')
  try {
    const result = await runWatch({
      net: watchNet(), dns: watchDns(), browser: null, now: NOW, cwd: tmp.dir,
      options: watchOptions({ day: 1 }),
    })
    assert.equal(result.bundleDir, watchOutDir({ options: watchOptions({ day: 1 }), cwd: tmp.dir }))
    assert.ok(result.bundleDir.endsWith('new-test-post-launch'), `not a stable directory: ${result.bundleDir}`)
    for (const name of ['report.md', 'findings.json', 'crawl.json', 'baseline.json', 'plan.json', 'manifest.json']) {
      assert.ok(existsSync(join(result.bundleDir, name)), `${name} is missing from the watch bundle`)
    }
    const state = readWatchState(result.bundleDir)
    assert.deepEqual(state.runs.map((r) => r.day), [1])
    assert.equal(state.runs[0].bundle, result.bundleDir)
    assert.ok(Array.isArray(result.plan) && result.plan.length > 0)
    assert.match(readFileSync(join(result.bundleDir, 'report.md'), 'utf8'), /## Not covered/)
  } finally {
    tmp.cleanup()
  }
})

test('a watch day runs the cutover checks plus the four audit dimensions that drift', () => {
  const registered = new Set(cutoverRegistry(WATCH_MODULES).list().map((check) => check.dimension))
  for (const dimension of ['cutover', 'inventory', 'links', 'head', 'indexability']) {
    assert.ok(registered.has(dimension), `the ${dimension} dimension is not on a watch day`)
  }
  for (const dimension of ['images', 'perf', 'a11y', 'redirects']) {
    assert.equal(registered.has(dimension), false, `${dimension} does not change because DNS moved`)
  }
})

test('runWatch reports findings from the audit dimensions, not only the cutover ones', async () => {
  const tmp = tmpDir('watch-dimensions')
  try {
    const result = await runWatch({
      net: cutoverNet(BAD), dns: watchDns(), browser: null, now: NOW, cwd: tmp.dir,
      options: watchOptions({ day: 2 }),
    })
    const dimensions = new Set(result.findings.map((f) => f.dimension))
    assert.ok(dimensions.has('cutover'), 'the cutover checks did not run')
    assert.ok(
      ['inventory', 'links', 'head', 'indexability'].some((d) => dimensions.has(d)),
      `no audit dimension reported anything: ${[...dimensions].join(', ')}`,
    )
  } finally {
    tmp.cleanup()
  }
})

test('a second watch day appends to the same bundle and the same state', async () => {
  const tmp = tmpDir('watch-second')
  try {
    const first = await runWatch({
      net: watchNet(), dns: watchDns(), browser: null, now: NOW, cwd: tmp.dir, options: watchOptions({ day: 1 }),
    })
    const second = await runWatch({
      net: watchNet(), dns: watchDns(), browser: null, now: '2026-09-15T00:00:00.000Z', cwd: tmp.dir,
      options: watchOptions({ day: 3 }),
    })
    assert.equal(second.bundleDir, first.bundleDir)
    const state = readWatchState(second.bundleDir)
    assert.deepEqual(state.runs.map((r) => r.day), [1, 3])
    assert.equal(state.startedAt, NOW)
    assert.ok(second.plan.some((entry) => entry.due === 'today' && entry.day === 3))
  } finally {
    tmp.cleanup()
  }
})
