#!/usr/bin/env node
// pre-launch — the gate. Inspect a repository and its build, and refuse the launch if anything
// mechanical is wrong.
//
// This is the orchestrator, and it owns three things and nothing else: the command line, the two
// modes that are not a gate run (`--progress`, `--confirm`), and what a person reads in the
// terminal. Every fact comes from `lib/context.mjs`, every judgement from a check module, every
// line of the report from `lib/gate.mjs`.
//
// Exit codes are the interface a CI job actually uses:
//
//   0  the gate passed, or a progress command succeeded
//   1  the gate failed — at least one check has status "fail"
//   2  a usage error, an unreadable directory, or an unexpected failure
//
// Nothing here softens a failure. `--strict` raises one advisory (`placeholders.source-maps`) to
// a blocker, and that is the only severity any flag may move, in the only direction it may move
// it. If a check is wrong, the check gets fixed; it does not get a flag.
//
// Read-only, with two exceptions that are both the operator's own record: `.launch-progress.json`
// in the directory being gated, written only by `--confirm` and `--reset-progress`, and the report
// bundle. The site, its build, its git history and every third-party service are untouched.

import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { defineArgs } from '../../launch-audit/scripts/lib/args.mjs'
import { createNet } from '../../launch-audit/scripts/lib/net.mjs'
import { createExec, normalizeIgnoreDirs, normalizeOptions } from './lib/context.mjs'
import { runGate } from './lib/gate.mjs'
import { HUMAN_ITEM_IDS, confirmItem, humanItemsFor, readProgress, resetProgress } from './lib/human.mjs'

const messageOf = (error) => (error?.message === undefined || error.message === '' ? String(error) : error.message)

// A repository with no readable package.json is one with no declared dependencies, which is the
// same answer the gate's own context reaches.
function readPackageJson(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return {}
  }
}

export const args = defineArgs({
  name: 'pre-launch',
  description: 'Gate a website launch: inspect the repository and its build, and fail if anything mechanical is wrong. Read-only apart from its own report bundle and .launch-progress.json.',
  flags: {
    dir: { type: 'string', default: '.', help: 'the repository to gate' },
    'production-url': { type: 'string', help: 'the url the site will live at (required for a gate run)' },
    'predecessor-url': { type: 'string', help: 'the site being replaced, whose live sitemap is the source of truth for old urls' },
    'build-dir': { type: 'string', help: 'the build output directory (auto-detected: dist, out, build, _site, public)' },
    'required-env': { type: 'list', help: 'an environment variable the production build needs (repeatable)' },
    'dev-host': { type: 'list', help: 'a staging or dev hostname that must not appear in the build (repeatable)' },
    'ignore-dir': { type: 'list', help: 'a folder under --dir, such as captured evidence, that is not the site; the repository scans skip it and Not covered names it (repeatable)' },
    strict: { type: 'boolean', default: false, help: 'raise placeholders.source-maps from advisory to blocker' },
    'skip-build': { type: 'boolean', default: false, help: 'do not run the build; inspect the output already on disk' },
    progress: { type: 'boolean', default: false, help: 'print the human checklist with its confirmations and exit' },
    confirm: { type: 'string', help: 'record a human checklist item as confirmed, by id, and exit' },
    'reset-progress': { type: 'boolean', default: false, help: 'clear every human checklist confirmation and exit' },
    out: { type: 'string', help: 'write the bundle here instead of ./website-launch/<slug>-pre-launch-<date>' },
  },
})

const EXTRA_HELP = [
  '',
  'Output: a bundle directory holding report.md, findings.json, gate.json and manifest.json.',
  'The report ends with Not covered and the human checklist, in that order.',
  '',
  'The gate runs your project\'s own build script ("<package manager> run build") in --dir unless',
  '--skip-build is passed, so the output it inspects is never stale. Whatever that build writes is',
  'written. Apart from the bundle and .launch-progress.json, the gate writes nothing of its own,',
  'and it never edits the site, submits a form, calls a provider API or touches DNS.',
  '',
  'Exit codes: 0 the gate passed (or a progress command succeeded)',
  '            1 the gate failed — at least one check has status "fail"',
  '            2 a usage error, an unreadable --dir, or an unexpected failure',
  '',
  'No flag turns a failure into anything softer. --strict raises placeholders.source-maps from',
  'advisory to blocker, which is the only severity any option may move.',
  '',
  'Progress: --progress, --confirm <id> and --reset-progress read and write .launch-progress.json',
  'in --dir, and do not run the gate. The ids are:',
  `  ${HUMAN_ITEM_IDS.join(', ')}`,
  '',
  'Testing hooks, used by this repo\'s tests; a normal run sets none of them:',
  '  NODE_VERSION_OVERRIDE=v20.11.0',
  '            check engines.node against this version instead of the running Node.',
  '  WEBSITE_LAUNCH_DEBUG=1',
  '            print the stack trace of an unexpected failure, not only its message.',
].join('\n')

// ----------------------------------------------------------------------------- the human summary

const tick = (confirmed) => (confirmed ? '✓' : '☐')

function printProgress(items) {
  const out = ['Human checklist — work these in order; the order is a dependency order.', '']
  for (const item of items) out.push(`  ${tick(item.confirmed)} ${item.id} — ${item.title}`)
  const next = items.find((item) => !item.confirmed)
  out.push('')
  out.push(next === undefined
    ? 'Every item is confirmed.'
    : `Next: ${next.id}. Read references/human-checklist.md, do it, then run --confirm ${next.id}.`)
  process.stdout.write(`${out.join('\n')}\n`)
}

// What a person reads in the terminal. The verdict is the first line, because it is the only line
// somebody scanning a CI log will read; then what failed and why, then what was not covered —
// verbatim, because a truncated coverage list is how a gate starts implying it checked things it
// did not.
function printSummary(results) {
  const failing = results.checks.filter((c) => c.status === 'fail')
  const out = []
  out.push(results.gate === 'fail'
    ? `GATE: FAIL — ${failing.length} failing check${failing.length === 1 ? '' : 's'}`
    : 'GATE: PASS')
  out.push('')
  out.push(`Bundle: ${results.bundleDir}`)
  out.push(`${results.framework.name ?? 'unrecognised framework'} · ${results.pm} · build dir ${results.buildDir ?? '(none found)'} · ${results.pageCount} page${results.pageCount === 1 ? '' : 's'}`)

  if (failing.length > 0) {
    out.push('')
    out.push('Failing:')
    for (const check of failing) {
      out.push(`  ${check.id} — ${check.detail}`)
      for (const evidence of check.evidence.slice(0, 5)) out.push(`      ${evidence.type}: ${evidence.value}`)
      if (check.evidence.length > 5) out.push(`      … and ${check.evidence.length - 5} more, in report.md`)
    }
  }

  const advisory = results.checks.filter((c) => c.status === 'advisory')
  if (advisory.length > 0) {
    out.push('')
    out.push('Advisory (does not block):')
    for (const check of advisory) out.push(`  ${check.id} — ${check.detail}`)
  }

  out.push('')
  out.push('Not covered:')
  for (const line of results.notCovered) out.push(`  - ${line}`)

  const next = results.human_items.find((item) => !item.confirmed)
  out.push('')
  out.push(next === undefined
    ? 'Human checklist: every item is confirmed.'
    : `Next human item: ${next.id} — ${next.title}`)
  if (next !== undefined) out.push(`  ${next.instructions}`)
  out.push('')
  out.push(results.gate === 'fail'
    ? 'Fix every failing check and run the gate again. Nothing here may be waived.'
    : 'The mechanical checks are clear. The human checklist is the rest of the launch.')
  process.stdout.write(`${out.join('\n')}\n`)
}

// ------------------------------------------------------------------------------------- the CLI

function usageError(errors, help) {
  process.stderr.write(`${errors.map((e) => `error: ${e}`).join('\n')}\n\n${help}\n${EXTRA_HELP}\n`)
  process.exitCode = 2
}

async function runCli(argv, { cwd, now, env }) {
  const { values, errors, help } = args.parse(argv)

  if (values.help) {
    process.stdout.write(`${help}\n${EXTRA_HELP}\n`)
    process.exitCode = 0
    return
  }

  const { resolve } = await import('node:path')
  const dir = resolve(cwd, values.dir ?? '.')

  // The three progress commands are not a gate run: they read and write the operator's own record
  // of what a person has confirmed, and they need no production url and no build. They do need the
  // same two inputs the gate uses to decide which items apply — the package manifest (payments)
  // and the predecessor url (gsc-baseline) — or they would offer a shorter list than the gate
  // does, and "every item is confirmed" would be a lie on any repository that takes money.
  const progressInputs = () => ({
    pkg: readPackageJson(dir),
    config: { predecessorUrl: values['predecessor-url'] ?? null },
    confirmed: readProgress(dir).confirmed,
  })

  if (values['reset-progress'] === true) {
    resetProgress(dir, now)
    printProgress(humanItemsFor({ ...progressInputs(), confirmed: [] }))
    process.exitCode = 0
    return
  }
  if (typeof values.confirm === 'string') {
    try {
      confirmItem(dir, values.confirm, HUMAN_ITEM_IDS, now)
    } catch (error) {
      usageError([messageOf(error)], help)
      return
    }
    printProgress(humanItemsFor(progressInputs()))
    process.exitCode = 0
    return
  }
  if (values.progress === true) {
    printProgress(humanItemsFor(progressInputs()))
    process.exitCode = 0
    return
  }

  if (values['production-url'] === undefined || values['production-url'] === null || values['production-url'] === '') {
    errors.push('--production-url is required')
  } else {
    try {
      const parsed = new URL(values['production-url'])
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') errors.push('--production-url must be http or https')
    } catch {
      errors.push(`--production-url is not a url: ${values['production-url']}`)
    }
  }
  if (values['predecessor-url'] !== undefined && values['predecessor-url'] !== null) {
    try {
      new URL(values['predecessor-url'])
    } catch {
      errors.push(`--predecessor-url is not a url: ${values['predecessor-url']}`)
    }
  }

  // An ignored folder is a path inside the repository being gated. One that points outside it, or
  // at the whole of it, is not a folder this flag can mean.
  for (const entry of values['ignore-dir']) {
    const path = String(entry).trim().split('\\').join('/')
    if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..')) {
      errors.push(`--ignore-dir must be a folder inside --dir, relative to it: ${entry}`)
    } else if (normalizeIgnoreDirs([path]).length === 0) {
      errors.push(`--ignore-dir cannot name --dir itself: ${entry}`)
    }
  }

  if (errors.length > 0) {
    usageError(errors, help)
    return
  }

  const options = normalizeOptions({
    productionUrl: values['production-url'],
    predecessorUrl: values['predecessor-url'] ?? null,
    buildDir: values['build-dir'] ?? null,
    requiredEnv: values['required-env'],
    devHosts: values['dev-host'],
    ignoreDirs: values['ignore-dir'],
    strict: values.strict === true,
    skipBuild: values['skip-build'] === true,
    out: values.out ?? null,
  })

  const results = await runGate({
    dir,
    options,
    exec: createExec(),
    // The gate only ever fetches the predecessor's sitemap, and only when asked to.
    net: options.predecessorUrl ? createNet() : null,
    now,
    cwd,
    env,
  })

  if (values.json) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
  else printSummary(results)

  process.exitCode = results.gate === 'fail' ? 1 : 0
}

// A stack trace is not a report. An unreadable --dir, a bundle path that cannot be written, a
// filesystem that is full: each comes out as one line on stderr and exit 2, the same shape a usage
// error has. The stack is one environment variable away when it is actually wanted.
export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), now = new Date(), env = process.env } = {}) {
  try {
    await runCli(argv, { cwd, now, env })
  } catch (error) {
    process.stderr.write(`error: ${messageOf(error)}\n`)
    if (env.WEBSITE_LAUNCH_DEBUG === '1' && error?.stack) process.stderr.write(`${error.stack}\n`)
    process.exitCode = 2
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
