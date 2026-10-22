// The gate runner: what a check's return value means, what the verdict is, and what gets written.
//
// Four outcomes, and the mapping is the whole contract:
//
//   throws SkipCheck(reason)      skip      — named in "Not covered", never a pass
//   returns []                    pass
//   returns blocker findings      fail      — the verdict
//   returns only softer findings  advisory  — reported, does not block
//   throws anything else          fail      — "check crashed"
//
// A check may return `Finding[]` or `{ findings, notCovered }`. The second form exists for the
// bound a check applies to itself and the runner cannot see: an og:image on another origin whose
// bytes were never fetched, files a secret scan skipped for size, redirect destinations that are
// templates rather than paths. Those are silent caps unless the check says so, and "no silent
// caps" is one of this repository's four honesty rules — so every such line is routed into
// `results.notCovered` and into the report's Not covered section, by name.
//
// That last one is the one place in this repository where a crash is a failure rather than a
// coverage gap. `launch-audit` reports, so a check that throws there costs that check and says so.
// This is the gate: a check that cannot answer has not cleared the launch, and a gate that shrugs
// off its own bugs is a gate that passes the day it breaks.
//
// `gate === 'fail'` if and only if some check has `status: 'fail'`. No flag anywhere converts a
// fail into anything else. `--strict` raises one advisory (`placeholders.source-maps`) to blocker,
// and that is the only severity any option may move, in the only direction it may move it.

import { join } from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'

import { createRegistry, SkipCheck } from '../../../launch-audit/scripts/lib/registry.mjs'
import { SEVERITIES, sortFindings, validateFinding } from '../../../launch-audit/scripts/lib/findings.mjs'
import { buildNotCovered, renderReport, resolveOutDir } from '../../../launch-audit/scripts/lib/report.mjs'
import { ensureDir, writeJson } from '../../../launch-audit/scripts/lib/fs-util.mjs'
import { slugify } from '../../../launch-audit/scripts/lib/slug.mjs'

import { buildGateContext, normalizeOptions } from './context.mjs'
import { humanItemsFor, readProgress } from './human.mjs'
import { checks as hygieneChecks } from './hygiene.mjs'
import { checks as placeholderChecks } from './placeholders.mjs'
import { checks as buildChecks } from './build.mjs'
import { checks as outputChecks } from './output.mjs'
import { checks as frameworkChecks } from './framework.mjs'
import { checks as predecessorChecks } from './predecessor.mjs'

export const PHASE = 'pre-launch'

const MANIFEST_NAME = 'manifest.json'

// Execution order is dependency order: the build has to run before anything reads its output, and
// the predecessor comparison is last because it is the only one that touches the network.
export const GROUP_ORDER = ['hygiene', 'placeholders', 'build', 'output', 'framework', 'predecessor']

const CHECK_MODULES = [hygieneChecks, placeholderChecks, buildChecks, outputChecks, frameworkChecks, predecessorChecks]

export const ALL_CHECKS = CHECK_MODULES.flat()

export function buildRegistry() {
  const registry = createRegistry()
  for (const check of ALL_CHECKS) registry.add(check)
  return registry
}

const messageOf = (error) => (error?.message === undefined || error.message === '' ? String(error) : error.message)

const worstSeverity = (findings) => findings
  .map((f) => f.severity)
  .sort((a, b) => SEVERITIES.indexOf(a) - SEVERITIES.indexOf(b))[0]

// Unwraps whichever of the two return shapes a check used, or reports which way it was malformed.
//
// A `notCovered` that is not an array of strings used to be filtered down to `[]`. That deleted
// the one thing this shape exists to carry, silently, in the one runner whose contract is that a
// check which cannot answer has not cleared the launch — so the coverage gap vanished and the
// check passed. A check that tried to declare a bound and got the shape wrong has not declared
// nothing; it has failed to declare something. An omitted `notCovered` is the third case and a
// legitimate one: the check had no bound to report.
const MALFORMED_NOT_COVERED = { malformed: 'malformed notCovered' }
const MALFORMED_SHAPE = { malformed: 'run() returned neither an array of findings nor { findings, notCovered }' }

function unwrap(produced) {
  if (Array.isArray(produced)) return { findings: produced, notCovered: [] }
  if (produced !== null && typeof produced === 'object' && Array.isArray(produced.findings)) {
    const declared = produced.notCovered
    if (declared === undefined || declared === null) return { findings: produced.findings, notCovered: [] }
    if (!Array.isArray(declared) || !declared.every((l) => typeof l === 'string')) return MALFORMED_NOT_COVERED
    return { findings: produced.findings, notCovered: declared.filter((l) => l !== '') }
  }
  return MALFORMED_SHAPE
}

// One check, run and interpreted. `check.run` is called as a method so a check body can use
// `this.mk(...)` to build a finding that already carries its own id, phase and severity.
async function runOne(check, ctx) {
  const base = { id: check.id, group: check.dimension, title: check.title, severity: check.severity }
  let produced
  try {
    produced = await check.run(ctx)
  } catch (error) {
    if (error instanceof SkipCheck) {
      return { ...base, status: 'skip', detail: error.reason, evidence: [], notCovered: [], findings: [] }
    }
    // A gate check that crashes fails closed. It did not clear the launch; it fell over.
    return {
      ...base,
      status: 'fail',
      detail: `check crashed — ${messageOf(error)}`,
      evidence: [{ type: 'text', value: `${check.id} threw: ${messageOf(error)}` }],
      notCovered: [],
      findings: [],
    }
  }

  const unwrapped = unwrap(produced)
  if (unwrapped.malformed !== undefined) {
    return {
      ...base,
      status: 'fail',
      detail: `check crashed — ${unwrapped.malformed}`,
      evidence: [{ type: 'text', value: `${check.id} returned ${typeof produced}` }],
      notCovered: [],
      findings: [],
    }
  }
  const { findings: produced2, notCovered } = unwrapped
  if (produced2.length === 0) return { ...base, status: 'pass', detail: 'no problems found', evidence: [], notCovered, findings: [] }

  // A finding that fails validation never ships — evidence is the promise this tool makes — but
  // in the gate an invalid finding still fails the check, because something was wrong and the only
  // thing lost is the ability to describe it.
  const invalid = []
  const valid = []
  for (const candidate of produced2) {
    const { ok, errors } = validateFinding(candidate)
    if (ok) valid.push(candidate)
    else invalid.push(errors.join('; '))
  }
  if (valid.length === 0) {
    return {
      ...base,
      status: 'fail',
      detail: `check crashed — every finding it produced was invalid: ${invalid.join(' | ')}`,
      evidence: [{ type: 'text', value: `${check.id} produced ${produced2.length} unusable finding(s)` }],
      notCovered,
      findings: [],
    }
  }

  const severity = worstSeverity(valid)
  const evidence = valid.flatMap((f) => f.evidence.map((e) => ({ type: e.type, value: e.value })))
  return {
    ...base,
    status: severity === 'blocker' ? 'fail' : 'advisory',
    severity,
    detail: valid.map((f) => f.detail).join('; '),
    evidence,
    notCovered,
    findings: valid,
  }
}

// buildNotCovered ends with two unconditional lines — copy vs. source and pages vs. scope — that
// have to stay last, because they are the two things no checker can ever see and a reader should
// leave the section on them. Anything a check words for itself goes in just above them.
export function insertBeforeFixed(lines, extra) {
  if (extra.length === 0) return lines
  const at = lines.findIndex((line) => line.startsWith('Copy vs. source documents'))
  // Appending instead would put the checks' own lines after the two things nothing can see, which
  // is the one ordering this section must never lose.
  if (at === -1) throw new Error('Not covered is missing its fixed trailing lines')
  return [...lines.slice(0, at), ...extra, ...lines.slice(at)]
}

export async function runChecks(checks, ctx) {
  const results = []
  for (const check of checks) results.push(await runOne(check, ctx))
  return results
}

// ------------------------------------------------------------------------------------ the report

const tick = (confirmed) => (confirmed ? '✓' : '☐')

// The human checklist, appended to the rendered report. It is a section of the report rather than
// a separate file because the thing a person walks away with has to hold both halves: what the
// machine could check, and what only they can.
function renderHumanChecklist(items) {
  const lines = ['## Human checklist', '']
  lines.push('These are the checks no script can make. Work them in this order; the order is a dependency order.', '')
  for (const [index, item] of items.entries()) {
    lines.push(`### ${index + 1}. ${tick(item.confirmed)} ${item.id} — ${item.title}`, '')
    lines.push(item.instructions, '')
    lines.push(`Confirm with: \`--confirm ${item.id}\``, '')
  }
  return lines
}

export function renderGateReport({ results, target, generatedAt }) {
  const findings = results.checks.flatMap((c) => c.findings ?? [])
  const count = (severity) => findings.filter((f) => f.severity === severity).length
  const report = renderReport({
    phase: PHASE,
    target,
    generatedAt,
    findings: sortFindings(findings),
    notCovered: results.notCovered,
    summary: {
      pages: results.pageCount,
      blockers: count('blocker'),
      high: count('high'),
      medium: count('medium'),
      low: count('low'),
      info: count('info'),
    },
  })
  const verdict = results.gate === 'fail'
    ? `**GATE: FAIL** — ${results.checks.filter((c) => c.status === 'fail').length} failing checks. Nothing below clears this launch.`
    : '**GATE: PASS** — every mechanical check passed. The human checklist below is the rest of the launch.'
  // The verdict goes directly under the title, where a reader cannot scroll past it.
  const withVerdict = report.replace(/\n\n/, `\n\n${verdict}\n\n`)
  return `${withVerdict}\n${renderHumanChecklist(results.human_items).join('\n')}\n`
}

// The gate's bundle: the report a person reads, the findings a tool reads, the full results object,
// and a manifest naming exactly what this run wrote.
export function writeGateBundle(outDir, { report, findings, gate }) {
  ensureDir(outDir)
  // The manifest is the record, not one of the things recorded — which is what the audit's
  // manifest means, and the two have to mean the same thing or neither is readable without
  // knowing which run wrote it. (report.mjs's stale-file sweep skips `manifest.json` by name for
  // the same reason.)
  const files = ['report.md', 'findings.json', 'gate.json']
  writeFileSync(join(outDir, 'report.md'), report)
  writeJson(join(outDir, 'findings.json'), findings.map((f) => ({ ...f, evidence: f.evidence.map((e) => ({ ...e })) })))
  writeJson(join(outDir, 'gate.json'), gate)
  writeJson(join(outDir, MANIFEST_NAME), { generatedAt: new Date().toISOString(), files })
  return [...files, MANIFEST_NAME].map((name) => join(outDir, name))
}

export function gateOutDir({ options, now, cwd }) {
  return resolveOutDir({
    out: options.out,
    slug: slugify(new URL(options.productionUrl).hostname),
    phase: PHASE,
    now,
    cwd,
  })
}

// ------------------------------------------------------------------------------------- the run

export async function runGate({ dir, options: rawOptions, exec, net = null, now = new Date(), cwd = process.cwd(), env = process.env } = {}) {
  const options = normalizeOptions(rawOptions)
  const at = now instanceof Date ? now : new Date(now)
  const ctx = await buildGateContext({ dir, options, exec, net, now: at, env })

  const checks = await runChecks(ALL_CHECKS, ctx)
  const gate = checks.some((c) => c.status === 'fail') ? 'fail' : 'pass'

  const skipped = checks
    .filter((c) => c.status === 'skip')
    .map((c) => ({ check: c.id, reason: c.detail }))
  // A check's own coverage lines go after the skips and before the two fixed trailing lines: the
  // last thing a reader sees in this section must stay the two things no checker can ever reach.
  //
  // Folders the operator excluded with --ignore-dir are a bound on every repository scan at once,
  // so the gate names them itself rather than leaving it to whichever check happened to notice.
  // One that is not there is still named, and marked, so a typo cannot pass for a skip.
  const named = options.ignoreDirs.map((d) => (existsSync(join(dir, d)) ? d : `${d} (not present)`))
  const ignored = named.length > 0 ? [`ignored by request: ${named.join(', ')}`] : []
  const declared = [...new Set([...ignored, ...checks.flatMap((c) => c.notCovered ?? [])])]
  const notCovered = insertBeforeFixed(buildNotCovered({ skipped }), declared)

  const humanItems = humanItemsFor({ pkg: ctx.pkg, config: options, confirmed: readProgress(dir).confirmed })

  const results = {
    gate,
    checks: checks.map(({ findings, ...rest }) => rest),
    human_items: humanItems,
    framework: {
      name: ctx.framework.name,
      configPath: ctx.framework.configPath === null ? null : ctx.framework.configPath.slice(dir.length + 1),
      siteUrl: ctx.framework.siteUrl,
      sitemapIntegration: ctx.framework.sitemapIntegration,
      trailingSlash: ctx.framework.trailingSlash,
    },
    buildDir: ctx.buildDirName,
    pm: ctx.pm,
    productionUrl: ctx.prodUrl,
    pageCount: ctx.html.size,
    notCovered,
    bundleDir: null,
  }

  const bundleDir = gateOutDir({ options, now: at, cwd })
  results.bundleDir = bundleDir
  const findings = sortFindings(checks.flatMap((c) => c.findings ?? []))
  const report = renderGateReport({
    results: { ...results, checks, pageCount: ctx.html.size },
    target: ctx.prodUrl,
    generatedAt: at.toISOString(),
  })
  writeGateBundle(bundleDir, { report, findings, gate: results })

  return results
}
