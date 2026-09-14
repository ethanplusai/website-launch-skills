// Report bundle: renders findings to markdown, always documenting what wasn't covered, and
// writes the full audit bundle (report, findings, crawl snapshot, baseline, extras) to disk.
//
// Every export here is pure except `writeBundle`, which is the one function in this module that
// touches the filesystem.

import { join, dirname, isAbsolute, normalize } from 'node:path'
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { ensureDir, writeJson, readJson } from './fs-util.mjs'
import { sortFindings } from './findings.mjs'

const MANIFEST_NAME = 'manifest.json'

// Content interpolated into the markdown report comes from crawled pages (titles, meta, JSON-LD)
// and is not trusted. `inline(v)` makes any string safe to splice into a single markdown line:
// collapse all whitespace (including embedded newlines, which is what stops a `<title>` of
// `"\n## Fake Section"` from ever producing a real heading line) to one space and trim, then
// escape a leading `#`/`-`/`*`/`>`/`|` (each starts a block construct only at the very start of a
// line) and any run of backticks anywhere in the string (a backtick can open an inline code span
// from the middle of a line, not just the start).
function inline(v) {
  let s = String(v ?? '')
  s = s.replace(/\s+/g, ' ').trim()
  s = s.replace(/`+/g, (run) => '\\' + run)
  s = s.replace(/^([#\-*>|])/, '\\$1')
  return s
}

// Evidence values arrive as whatever the check collected: a plain string, a number/boolean metric,
// a structured object (rendered as single-line JSON), or nothing at all.
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

const NOT_COVERED_FIXED = [
  'Copy vs. source documents: not run (no source of truth reachable)',
  'Pages vs. agreed scope: not run (no scope source reachable)',
]

const DROP_LABEL = {
  'max-pages': 'Dropped by max-pages',
  'max-depth': 'Dropped by max-depth',
  robots: 'Dropped by robots',
}

// Builds the `## Not covered` lines. This section always ships, even when nothing was skipped,
// because the two fixed lines at the end are unconditional — a launch-audit report never implies
// copy or scope were checked unless they actually were.
export function buildNotCovered({
  dropped = [],
  browserAvailable = true,
  browserReason = null,
  skipped = [],
  unverifiableExternals = [],
  ignoredRobots = false,
  psiSkipped = null,
} = {}) {
  const lines = []

  const byReason = new Map()
  for (const d of dropped) {
    if (!byReason.has(d.reason)) byReason.set(d.reason, [])
    byReason.get(d.reason).push(d.url)
  }
  for (const [reason, urls] of byReason) {
    for (const url of urls) {
      if (reason === 'off-origin') lines.push(`Off-origin sitemap entry not fetched: ${url}`)
      else lines.push(`${DROP_LABEL[reason] ?? `Dropped by ${reason}`}: ${url}`)
    }
  }

  if (!browserAvailable) lines.push(`Browser tier not run: ${browserReason}`)

  for (const s of skipped) lines.push(`${s.check}: skipped — ${s.reason}`)

  for (const url of unverifiableExternals) lines.push(`External link could not be verified (not a failure): ${url}`)

  if (ignoredRobots) lines.push('robots.txt was ignored for crawl scope (--ignore-robots)')

  if (psiSkipped) lines.push(`PageSpeed Insights: skipped — ${psiSkipped}`)

  lines.push(...NOT_COVERED_FIXED)
  return lines
}

function renderOps(ops) {
  const lines = ['## Ops & access readiness', '']
  for (const op of ops) {
    const tag = op.autoVerifiedBy ? `[auto-verified by ${op.autoVerifiedBy}]` : '[human]'
    lines.push(`- ${tag} ${inline(op.label)}`)
  }
  return lines
}

function renderFinding(f) {
  const lines = [`### [${f.severity}] ${inline(f.title)}`, '']
  lines.push(`- Page: ${inline(f.page || 'site-wide')}`)
  lines.push(`- Detail: ${inline(f.detail)}`)
  lines.push('- Evidence:')
  for (const e of f.evidence) lines.push(`  - ${inline(e.type)}: ${formatValue(e.value)}`)
  lines.push(`- Fix: ${inline(f.fix)}`)
  return lines
}

// Renders the full markdown report. Dimensions appear in the order they first show up once
// `findings` is severity-sorted, so severity order is preserved within each dimension's section
// even though the sort key ranks severity ahead of dimension.
export function renderReport({ phase, target, generatedAt, findings = [], notCovered = [], ops, summary }) {
  const lines = []
  lines.push(`# Launch ${phase} report — ${inline(target)}`, '')
  lines.push(`Generated ${generatedAt}`, '')
  lines.push('| Pages | Blockers | High | Medium | Low | Info |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  lines.push(`| ${summary.pages} | ${summary.blockers} | ${summary.high} | ${summary.medium} | ${summary.low} | ${summary.info} |`, '')

  const sorted = sortFindings(findings)
  if (sorted.length === 0) {
    lines.push('## Findings', '', '_No findings._', '')
  } else {
    const dims = []
    const byDim = new Map()
    for (const f of sorted) {
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
  }

  if (ops !== undefined) lines.push(...renderOps(ops), '')

  lines.push('## Not covered', '')
  for (const line of notCovered) lines.push(`- ${inline(line)}`)

  return lines.join('\n') + '\n'
}

function projectCrawl(crawl) {
  return {
    pages: crawl.pages.map((p) => ({
      url: p.url, status: p.status, finalUrl: p.finalUrl, depth: p.depth, source: p.source, title: p.title,
    })),
    dropped: crawl.dropped,
    orphans: crawl.orphans,
    unlisted: crawl.unlisted,
    assets: {
      images: [...crawl.assets.images],
      scripts: [...crawl.assets.scripts],
      styles: [...crawl.assets.styles],
    },
    externalLinks: Object.fromEntries(crawl.externalLinks),
    internalLinks: Object.fromEntries(crawl.internalLinks),
  }
}

// Reads a prior run's manifest (if any) and deletes whichever of its files this run is not about
// to rewrite. `thisRunNames` (basenames only) must be computed before this runs, from the same
// inputs that decide what gets written below, so the two never drift apart. A file this bundle
// never wrote — the manifest doesn't name it — is never touched, no matter what it's called.
function cleanStale(outDir, thisRunNames) {
  const manifestPath = join(outDir, MANIFEST_NAME)
  if (!existsSync(manifestPath)) return
  let prev = null
  try {
    prev = readJson(manifestPath)
  } catch {
    return
  }
  if (!prev || !Array.isArray(prev.files)) return
  for (const name of prev.files) {
    if (name === MANIFEST_NAME || thisRunNames.includes(name)) continue
    try {
      unlinkSync(bundlePath(outDir, name))
    } catch {
      // already gone
    }
  }
}

// An `extra` item's name may hold forward slashes, so a run can file its artefacts into a
// subdirectory of the bundle (`lighthouse/home-mobile.json`). The name is still a name and never a
// path out of the bundle: an absolute name, or one that climbs above `outDir`, is refused rather
// than written somewhere surprising.
function bundlePath(outDir, name) {
  if (typeof name !== 'string' || name === '') throw new Error('writeBundle: an extra needs a name')
  if (isAbsolute(name) || normalize(name).split(/[\\/]/).includes('..')) {
    throw new Error(`writeBundle: "${name}" is not a name inside the bundle`)
  }
  return join(outDir, ...name.split('/'))
}

// Writes the audit bundle into `outDir` (created recursively) and returns the absolute paths of
// every file written, in write order. Before writing, any file left over from a prior run into
// the same `outDir` that this run won't rewrite — an old `redirects.csv` or `extra` file that a
// rerun no longer produces — is removed, per the manifest that run left behind, so a rerun never
// leaves a stale artifact for a fresher one to hide behind. `manifest.json` itself is written
// last, listing exactly the basenames this run produced.
export function writeBundle(outDir, { report, findings, crawl, baseline, redirectsCsv, extra = [] } = {}) {
  ensureDir(outDir)

  const thisRunNames = ['report.md', 'findings.json', 'crawl.json', 'baseline.json']
  if (redirectsCsv !== undefined) thisRunNames.push('redirects.csv')
  // Validate every extra name before anything is written, so a bad one fails the whole bundle
  // rather than half of it.
  for (const item of extra) {
    bundlePath(outDir, item.name)
    thisRunNames.push(item.name)
  }

  cleanStale(outDir, thisRunNames)

  const files = []

  const reportPath = join(outDir, 'report.md')
  writeFileSync(reportPath, report)
  files.push(reportPath)

  const findingsPath = join(outDir, 'findings.json')
  writeJson(findingsPath, findings.map((f) => ({ ...f, evidence: f.evidence.map((e) => ({ ...e })) })))
  files.push(findingsPath)

  const crawlPath = join(outDir, 'crawl.json')
  writeJson(crawlPath, projectCrawl(crawl))
  files.push(crawlPath)

  const baselinePath = join(outDir, 'baseline.json')
  writeJson(baselinePath, baseline)
  files.push(baselinePath)

  if (redirectsCsv !== undefined) {
    const redirectsPath = join(outDir, 'redirects.csv')
    writeFileSync(redirectsPath, redirectsCsv)
    files.push(redirectsPath)
  }

  for (const item of extra) {
    const extraPath = bundlePath(outDir, item.name)
    mkdirSync(dirname(extraPath), { recursive: true })
    writeFileSync(extraPath, item.content)
    files.push(extraPath)
  }

  const manifestPath = join(outDir, MANIFEST_NAME)
  writeJson(manifestPath, { generatedAt: new Date().toISOString(), files: thisRunNames })
  files.push(manifestPath)

  return { files }
}

// out ?? join(cwd, 'website-launch', `${slug}-${phase}-${yyyy-mm-dd}`), with the date taken from
// `now` in UTC so the result never depends on the machine's local timezone.
export function resolveOutDir({ out, slug, phase, now, cwd }) {
  if (out) return out
  const d = now instanceof Date ? now : new Date(now)
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return join(cwd, 'website-launch', `${slug}-${phase}-${yyyy}-${mm}-${dd}`)
}
