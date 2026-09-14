import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpDir } from './helpers.mjs'
import { finding } from '../skills/launch-audit/scripts/lib/findings.mjs'
import { buildNotCovered, renderReport, writeBundle, resolveOutDir } from '../skills/launch-audit/scripts/lib/report.mjs'

const summary = { pages: 3, blockers: 1, high: 1, medium: 0, low: 0, info: 0 }

function f(overrides) {
  return finding({
    id: 'head.title-missing', phase: 'launch-audit', dimension: 'head', severity: 'high', tier: 'http',
    title: 'Missing <title>', detail: 'No title element', page: 'https://x.test/',
    evidence: [{ type: 'url', value: 'https://x.test/' }], fix: 'Add a <title>',
    ...overrides,
  })
}

// --- buildNotCovered ---

test('buildNotCovered always ends with the two fixed lines', () => {
  const lines = buildNotCovered({})
  assert.deepEqual(lines.slice(-2), [
    'Copy vs. source documents: not run (no source of truth reachable)',
    'Pages vs. agreed scope: not run (no scope source reachable)',
  ])
})

test('buildNotCovered groups dropped urls by reason with the right labels', () => {
  const lines = buildNotCovered({
    dropped: [
      { url: 'https://x.test/a', reason: 'max-pages' },
      { url: 'https://x.test/b', reason: 'robots' },
      { url: 'https://x.test/c', reason: 'max-pages' },
      { url: 'https://other.test/d', reason: 'off-origin' },
    ],
  })
  assert.deepEqual(lines.slice(0, 4), [
    'Dropped by max-pages: https://x.test/a',
    'Dropped by max-pages: https://x.test/c',
    'Dropped by robots: https://x.test/b',
    'Off-origin sitemap entry not fetched: https://other.test/d',
  ])
})

test('buildNotCovered reports browser tier, skipped checks, unverifiable externals, ignored robots, and PSI in order', () => {
  const lines = buildNotCovered({
    browserAvailable: false,
    browserReason: 'no chrome binary found',
    skipped: [{ check: 'perf.lcp', reason: 'browser tier unavailable' }],
    unverifiableExternals: ['https://ext.test/'],
    ignoredRobots: true,
    psiSkipped: 'no API key',
  })
  assert.deepEqual(lines, [
    'Browser tier not run: no chrome binary found',
    'perf.lcp: skipped — browser tier unavailable',
    'External link could not be verified (not a failure): https://ext.test/',
    'robots.txt was ignored for crawl scope (--ignore-robots)',
    'PageSpeed Insights: skipped — no API key',
    'Copy vs. source documents: not run (no source of truth reachable)',
    'Pages vs. agreed scope: not run (no scope source reachable)',
  ])
})

// --- renderReport ---

test('renderReport contains ## Not covered with the fixed lines even with zero findings', () => {
  const notCovered = buildNotCovered({})
  const md = renderReport({ phase: 'audit', target: 'https://x.test/', generatedAt: '2026-01-01T00:00:00.000Z', findings: [], notCovered, summary })
  assert.match(md, /## Not covered/)
  assert.match(md, /Copy vs\. source documents: not run \(no source of truth reachable\)/)
  assert.match(md, /Pages vs\. agreed scope: not run \(no scope source reachable\)/)
  assert.match(md, /## Findings\n\n_No findings\._/)
})

test('renderReport groups findings by dimension in first-seen order, severity order within a dimension', () => {
  const findings = [
    f({ severity: 'high', dimension: 'a', title: 'a-high' }),
    f({ severity: 'blocker', dimension: 'b', title: 'b-blocker' }),
    f({ severity: 'medium', dimension: 'a', title: 'a-medium' }),
  ]
  const md = renderReport({ phase: 'audit', target: 'https://x.test/', generatedAt: '2026-01-01T00:00:00.000Z', findings, notCovered: [], summary })
  const dimA = md.indexOf('## a')
  const dimB = md.indexOf('## b')
  assert.ok(dimA !== -1 && dimB !== -1)
  assert.ok(dimB < dimA, 'dimension b appears first because its only finding is a blocker, ranked before a\'s high')
  const highIdx = md.indexOf('a-high')
  const mediumIdx = md.indexOf('a-medium')
  assert.ok(highIdx < mediumIdx, 'within dimension a, high must render before medium')
})

test('renderReport renders page, detail, evidence lines, and fix for a finding', () => {
  const findings = [f({ evidence: [{ type: 'url', value: 'https://x.test/' }, { type: 'html', value: '<title></title>' }] })]
  const md = renderReport({ phase: 'audit', target: 'https://x.test/', generatedAt: '2026-01-01T00:00:00.000Z', findings, notCovered: [], summary })
  assert.match(md, /### \[high\] Missing <title>/)
  assert.match(md, /- Page: https:\/\/x\.test\//)
  assert.match(md, /- Detail: No title element/)
  assert.match(md, /- Evidence:\n {2}- url: https:\/\/x\.test\/\n {2}- html: <title><\/title>/)
  assert.match(md, /- Fix: Add a <title>/)
})

test('renderReport prints site-wide for a finding with no page', () => {
  const findings = [f({ page: null })]
  const md = renderReport({ phase: 'audit', target: 'https://x.test/', generatedAt: '2026-01-01T00:00:00.000Z', findings, notCovered: [], summary })
  assert.match(md, /- Page: site-wide/)
})

test('renderReport renders Ops & access readiness with auto-verified and human tags', () => {
  const ops = [{ label: 'DNS records handed off', autoVerifiedBy: 'dns.records' }, { label: 'Client has admin access', autoVerifiedBy: null }]
  const md = renderReport({ phase: 'audit', target: 'https://x.test/', generatedAt: '2026-01-01T00:00:00.000Z', findings: [], notCovered: [], ops, summary })
  assert.match(md, /## Ops & access readiness/)
  assert.match(md, /- \[auto-verified by dns\.records\] DNS records handed off/)
  assert.match(md, /- \[human\] Client has admin access/)
})

test('renderReport omits Ops & access readiness when ops is not given', () => {
  const md = renderReport({ phase: 'audit', target: 'https://x.test/', generatedAt: '2026-01-01T00:00:00.000Z', findings: [], notCovered: [], summary })
  assert.doesNotMatch(md, /Ops & access readiness/)
})

test('renderReport includes the summary table with all six columns', () => {
  const md = renderReport({ phase: 'audit', target: 'https://x.test/', generatedAt: '2026-01-01T00:00:00.000Z', findings: [], notCovered: [], summary })
  assert.match(md, /\| Pages \| Blockers \| High \| Medium \| Low \| Info \|/)
  assert.match(md, /\| 3 \| 1 \| 1 \| 0 \| 0 \| 0 \|/)
})

test('renderReport H1 names phase and target', () => {
  const md = renderReport({ phase: 'pre-launch', target: 'https://x.test/', generatedAt: '2026-01-01T00:00:00.000Z', findings: [], notCovered: [], summary })
  assert.match(md, /^# Launch pre-launch report — https:\/\/x\.test\//)
})

// --- markdown injection safety ---

test('renderReport collapses embedded newlines so a finding title cannot inject a fake heading', () => {
  const findings = [f({ dimension: 'seo', title: 'Evil\n## Fake Section\n### [blocker] Injected' })]
  const md = renderReport({ phase: 'audit', target: 'https://x.test/', generatedAt: '2026-01-01T00:00:00.000Z', findings, notCovered: [], summary })
  const h2Lines = md.split('\n').filter((l) => /^## /.test(l))
  const h3Lines = md.split('\n').filter((l) => /^### /.test(l))
  assert.deepEqual(h2Lines, ['## seo', '## Not covered'], `expected only the dimension and the always-present Not covered heading, got: ${JSON.stringify(h2Lines)}`)
  assert.equal(h3Lines.length, 1, `expected exactly one real ### heading (the finding), got: ${JSON.stringify(h3Lines)}`)
  assert.doesNotMatch(md, /^## Fake Section$/m)
  assert.match(md, /Evil ## Fake Section ### \[blocker\] Injected/)
})

test('renderReport escapes a leading markdown block character in interpolated text', () => {
  const findings = [f({ detail: '- not actually a list item', fix: '> not actually a quote' })]
  const md = renderReport({ phase: 'audit', target: 'https://x.test/', generatedAt: '2026-01-01T00:00:00.000Z', findings, notCovered: [], summary })
  assert.match(md, /- Detail: \\- not actually a list item/)
  assert.match(md, /- Fix: \\> not actually a quote/)
})

test('renderReport escapes backtick runs anywhere in interpolated text', () => {
  const findings = [f({ fix: 'Run `npm test` to verify' })]
  const md = renderReport({ phase: 'audit', target: 'https://x.test/', generatedAt: '2026-01-01T00:00:00.000Z', findings, notCovered: [], summary })
  assert.match(md, /- Fix: Run \\`npm test\\` to verify/)
})

test('renderReport neutralizes a not-covered line and a dimension heading the same way', () => {
  const findings = [f({ dimension: '# hijacked' })]
  const md = renderReport({ phase: 'audit', target: 'https://x.test/', generatedAt: '2026-01-01T00:00:00.000Z', findings, notCovered: ['# also hijacked'], summary })
  assert.match(md, /## \\# hijacked/)
  assert.match(md, /- \\# also hijacked/)
})

// --- evidence value formatting ---

test('renderReport renders a structured evidence value as single-line JSON', () => {
  const findings = [f({ evidence: [{ type: 'metric', value: { lcp: 4200 } }] })]
  const md = renderReport({ phase: 'audit', target: 'https://x.test/', generatedAt: '2026-01-01T00:00:00.000Z', findings, notCovered: [], summary })
  assert.match(md, /- metric: \{"lcp":4200\}/)
})

test('renderReport renders number and boolean evidence values via String()', () => {
  const findings = [f({ evidence: [{ type: 'metric', value: 4200 }, { type: 'text', value: true }] })]
  const md = renderReport({ phase: 'audit', target: 'https://x.test/', generatedAt: '2026-01-01T00:00:00.000Z', findings, notCovered: [], summary })
  assert.match(md, /- metric: 4200/)
  assert.match(md, /- text: true/)
})

test('renderReport renders a null or undefined evidence value as (none)', () => {
  // Built directly rather than via finding() — finding() itself rejects an empty/null evidence
  // value, but renderReport only reads the shape, so this still exercises formatValue's fallback.
  const bare = { id: 'x.y', phase: 'launch-audit', dimension: 'x', severity: 'info', tier: 'http', title: 't', detail: 'd', page: null, evidence: [{ type: 'text', value: null }, { type: 'text', value: undefined }], fix: 'f' }
  const md = renderReport({ phase: 'audit', target: 'https://x.test/', generatedAt: '2026-01-01T00:00:00.000Z', findings: [bare], notCovered: [], summary })
  const noneLines = md.split('\n').filter((l) => l.trim() === '- text: (none)')
  assert.equal(noneLines.length, 2)
})

// --- resolveOutDir ---

test('resolveOutDir returns `out` verbatim when given', () => {
  const p = resolveOutDir({ out: '/explicit/path', slug: 'x-test', phase: 'audit', now: new Date('2026-03-05T00:00:00Z'), cwd: '/cwd' })
  assert.equal(p, '/explicit/path')
})

test('resolveOutDir builds a path under cwd from slug, phase, and the UTC date', () => {
  const p = resolveOutDir({ out: undefined, slug: 'x-test', phase: 'audit', now: new Date('2026-03-05T23:30:00Z'), cwd: '/cwd' })
  assert.equal(p, join('/cwd', 'website-launch', 'x-test-audit-2026-03-05'))
})

test('resolveOutDir depends on cwd', () => {
  const now = new Date('2026-03-05T00:00:00Z')
  const a = resolveOutDir({ slug: 's', phase: 'p', now, cwd: '/one' })
  const b = resolveOutDir({ slug: 's', phase: 'p', now, cwd: '/two' })
  assert.notEqual(a, b)
})

// --- writeBundle ---

test('writeBundle writes the expected files into an output directory it creates', () => {
  const { dir, cleanup } = tmpDir('report-bundle')
  try {
    const outDir = join(dir, 'nested', 'out')
    const crawl = {
      pages: [{ url: 'https://x.test/', status: 200, finalUrl: 'https://x.test/', depth: 0, source: 'crawl', title: 'Home', page: { fake: true }, response: { fake: true } }],
      dropped: [{ url: 'https://x.test/gone', reason: 'max-depth' }],
      orphans: [],
      unlisted: [],
      assets: { images: new Set(['https://x.test/a.png']), scripts: new Set(), styles: new Set() },
      externalLinks: new Map([['https://ext.test/', ['https://x.test/']]]),
      internalLinks: new Map(),
    }
    const findings = [f({})]
    const baseline = { generatedAt: '2026-01-01T00:00:00.000Z', host: 'x.test', pages: [] }
    const { files } = writeBundle(outDir, {
      report: '# report\n', findings, crawl, baseline, redirectsCsv: 'from,to\n', extra: [{ name: 'notes.txt', content: 'hi' }],
    })

    for (const name of ['report.md', 'findings.json', 'crawl.json', 'baseline.json', 'redirects.csv', 'notes.txt']) {
      assert.ok(existsSync(join(outDir, name)), `expected ${name} to exist`)
      assert.ok(files.includes(join(outDir, name)), `expected files[] to include ${name}`)
    }
    assert.ok(files.every((p) => p.startsWith(outDir)))

    const crawlJson = JSON.parse(readFileSync(join(outDir, 'crawl.json'), 'utf8'))
    assert.deepEqual(crawlJson.pages, [{ url: 'https://x.test/', status: 200, finalUrl: 'https://x.test/', depth: 0, source: 'crawl', title: 'Home' }])
    assert.deepEqual(crawlJson.assets.images, ['https://x.test/a.png'])
    assert.deepEqual(crawlJson.externalLinks, { 'https://ext.test/': ['https://x.test/'] })
    assert.deepEqual(crawlJson.dropped, [{ url: 'https://x.test/gone', reason: 'max-depth' }])

    const findingsJson = JSON.parse(readFileSync(join(outDir, 'findings.json'), 'utf8'))
    assert.equal(findingsJson.length, 1)
    assert.equal(findingsJson[0].id, 'head.title-missing')

    assert.equal(readFileSync(join(outDir, 'report.md'), 'utf8'), '# report\n')
  } finally {
    cleanup()
  }
})

test('writeBundle omits redirects.csv when not given', () => {
  const { dir, cleanup } = tmpDir('report-bundle-no-redirects')
  try {
    const outDir = join(dir, 'out')
    const crawl = { pages: [], dropped: [], orphans: [], unlisted: [], assets: { images: new Set(), scripts: new Set(), styles: new Set() }, externalLinks: new Map(), internalLinks: new Map() }
    const { files } = writeBundle(outDir, { report: '# r\n', findings: [], crawl, baseline: {} })
    assert.ok(!files.some((p) => p.endsWith('redirects.csv')))
    assert.ok(!existsSync(join(outDir, 'redirects.csv')))
  } finally {
    cleanup()
  }
})

test('writeBundle writes a manifest.json listing exactly this run\'s files, as its last file', () => {
  const { dir, cleanup } = tmpDir('report-bundle-manifest')
  try {
    const outDir = join(dir, 'out')
    const { files } = writeBundle(outDir, { report: '# r\n', findings: [], crawl: emptyCrawl(), baseline: {}, redirectsCsv: 'a,b\n' })
    assert.equal(files[files.length - 1], join(outDir, 'manifest.json'))
    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
    assert.deepEqual([...manifest.files].sort(), ['baseline.json', 'crawl.json', 'findings.json', 'redirects.csv', 'report.md'])
    assert.equal(typeof manifest.generatedAt, 'string')
  } finally {
    cleanup()
  }
})

// --- writeBundle: stale-artifact cleanup on rerun ---

function emptyCrawl() {
  return { pages: [], dropped: [], orphans: [], unlisted: [], assets: { images: new Set(), scripts: new Set(), styles: new Set() }, externalLinks: new Map(), internalLinks: new Map() }
}

test('writeBundle deletes files a prior run into the same outDir produced but this run does not rewrite', () => {
  const { dir, cleanup } = tmpDir('report-bundle-stale')
  try {
    const outDir = join(dir, 'out')
    writeBundle(outDir, {
      report: '# run1\n', findings: [], crawl: emptyCrawl(), baseline: {},
      redirectsCsv: 'from,to\n', extra: [{ name: 'notes.txt', content: 'hi' }],
    })
    assert.ok(existsSync(join(outDir, 'redirects.csv')))
    assert.ok(existsSync(join(outDir, 'notes.txt')))

    const { files } = writeBundle(outDir, { report: '# run2\n', findings: [], crawl: emptyCrawl(), baseline: {} })

    assert.ok(!existsSync(join(outDir, 'redirects.csv')), 'stale redirects.csv from run 1 should be gone')
    assert.ok(!existsSync(join(outDir, 'notes.txt')), 'stale notes.txt from run 1 should be gone')
    assert.equal(readFileSync(join(outDir, 'report.md'), 'utf8'), '# run2\n')
    assert.ok(existsSync(join(outDir, 'findings.json')))
    assert.ok(existsSync(join(outDir, 'crawl.json')))
    assert.ok(existsSync(join(outDir, 'baseline.json')))

    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
    assert.deepEqual([...manifest.files].sort(), ['baseline.json', 'crawl.json', 'findings.json', 'report.md'])
    assert.ok(files.includes(join(outDir, 'manifest.json')))
  } finally {
    cleanup()
  }
})

test('writeBundle never deletes a file that was not named in a prior manifest', () => {
  const { dir, cleanup } = tmpDir('report-bundle-user-file')
  try {
    const outDir = join(dir, 'out')
    writeBundle(outDir, { report: '# run1\n', findings: [], crawl: emptyCrawl(), baseline: {}, redirectsCsv: 'a,b\n' })

    writeFileSync(join(outDir, 'mine.txt'), 'do not delete me')

    writeBundle(outDir, { report: '# run2\n', findings: [], crawl: emptyCrawl(), baseline: {} })

    assert.ok(existsSync(join(outDir, 'mine.txt')))
    assert.equal(readFileSync(join(outDir, 'mine.txt'), 'utf8'), 'do not delete me')
  } finally {
    cleanup()
  }
})
