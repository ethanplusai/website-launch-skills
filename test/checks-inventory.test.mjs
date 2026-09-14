import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checks } from '../skills/launch-audit/scripts/lib/checks/inventory.mjs'
import { findingsFor, has, of, allEvidence, evidenceText } from './checks-helpers.mjs'

const run = (fixture, options) => findingsFor(checks, `recorded/${fixture}`, options)
// A site whose sitemap and link graph agree, every page of which answers 200 at depth 1: the
// negative case for everything below.
const good = () => run('inventory-good-site.json', { url: 'https://inv-good.test/' })
// A site with an orphan, an unlisted page, a four-deep chain, a 500, a url that never answers, and
// an off-origin sitemap entry the crawl refused.
const bad = () => run('inventory-site.json', { url: 'https://inv.test/' })

test('every check is registrable, http-tier, and in the inventory dimension', async () => {
  assert.ok(checks.length > 0)
  for (const check of checks) {
    assert.equal(check.phase, 'launch-audit')
    assert.equal(check.dimension, 'inventory')
    assert.ok(check.id.startsWith('inventory.'))
    assert.equal(check.tier, 'http')
    assert.ok(check.title && check.catches)
  }
  assert.equal(new Set(checks.map((c) => c.id)).size, checks.length)
})

test('a site whose sitemap and link graph agree reports nothing at all', async () => {
  assert.deepEqual(await good(), [])
})

test('inventory.orphan-page names the sitemap url nothing links to', async () => {
  const found = of(await bad(), 'inventory.orphan-page')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  assert.equal(found[0].page, 'https://inv.test/orphan')
  assert.match(evidenceText(found[0]), /inv\.test\/orphan/)
  assert.ok(!has(await good(), 'inventory.orphan-page'))
})

test('inventory.unlisted-page names a fetched page the sitemap never mentions', async () => {
  const found = of(await bad(), 'inventory.unlisted-page')
  assert.ok(found.length >= 1)
  for (const finding of found) assert.equal(finding.severity, 'low')
  assert.match(allEvidence(found), /inv\.test\/unlisted/)
  assert.ok(!has(await good(), 'inventory.unlisted-page'))
})

test('inventory.deep-page fires past three clicks from the front page, and not before', async () => {
  const found = of(await bad(), 'inventory.deep-page')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'low')
  assert.equal(found[0].page, 'https://inv.test/deep4')
  assert.match(evidenceText(found[0]), /4 clicks/)
  // /deep3 sits at exactly three clicks, which is the boundary and not a finding.
  assert.ok(!allEvidence(found).includes('inv.test/deep3'))
  assert.ok(!has(await good(), 'inventory.deep-page'))
})

test('inventory.capped lists every url the crawl dropped, with the reason', async () => {
  const found = of(await bad(), 'inventory.capped')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'info')
  assert.match(evidenceText(found[0]), /other\.test\/page/)
  assert.match(evidenceText(found[0]), /off-origin/)
  assert.ok(!has(await good(), 'inventory.capped'))
})

test('inventory.capped also reports a page budget the crawl ran out of', async () => {
  const found = of(await run('inventory-site.json', { url: 'https://inv.test/', maxPages: 3, cacheTag: 'capped' }), 'inventory.capped')
  assert.equal(found.length, 1)
  assert.match(evidenceText(found[0]), /dropped by the page budget/)
})

test('inventory.non-200-page reports a page that answers a server error', async () => {
  const found = of(await bad(), 'inventory.non-200-page')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'high')
  assert.equal(found[0].page, 'https://inv.test/broken')
  assert.match(evidenceText(found[0]), /500/)
  assert.ok(!has(await good(), 'inventory.non-200-page'))
})

test('a url that never answered is unreachable, never a non-200', async () => {
  const findings = await bad()
  const found = of(findings, 'inventory.unreachable-page')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  assert.equal(found[0].page, 'https://inv.test/unreachable')
  assert.match(evidenceText(found[0]), /not recorded/)
  assert.ok(!allEvidence(of(findings, 'inventory.non-200-page')).includes('inv.test/unreachable'))
  assert.ok(!has(await good(), 'inventory.unreachable-page'))
})

// --------------------------------------------------- the audit that has nothing under it

// Nothing recorded at all, so every request answers `status: 0` — an audit of a host that is not
// there. Before `inventory.target-unreachable` existed, this run produced a report with zero
// blockers and almost no findings, which reads exactly like a clean site.
const dead = () => run('unreachable-site.json', { url: 'https://gone.test/' })

test('inventory.target-unreachable is a blocker when the start url never answered', async () => {
  const found = of(await dead(), 'inventory.target-unreachable')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'blocker')
  assert.equal(found[0].page, 'https://gone.test/')
  assert.match(found[0].detail, /never answered/)
  assert.match(found[0].detail, /every HTTP-tier check ran against no content/)
  assert.match(evidenceText(found[0]), /not recorded/)
  assert.ok(!has(await good(), 'inventory.target-unreachable'))
})

test('inventory.unreachable-page leaves the start url to the blocker and keeps its own medium', async () => {
  const found = of(await dead(), 'inventory.unreachable-page')
  assert.ok(!found.some((f) => f.page === 'https://gone.test/'))
  // The other urls a dead host swallows are still reported, one per url, at medium.
  const others = of(await bad(), 'inventory.unreachable-page')
  assert.ok(others.length >= 1)
  for (const finding of others) assert.equal(finding.severity, 'medium')
})

test('inventory.target-unreachable fires when the start url answers but no HTML parsed', async () => {
  const found = of(await run('unreachable-site.json', {
    url: 'https://gone.test/',
    records: { 'https://gone.test/': { status: 200, headers: { 'content-type': 'application/pdf' }, bodyBase64: 'JVBERi0=' } },
  }), 'inventory.target-unreachable')
  assert.equal(found.length, 1)
  assert.match(found[0].detail, /parsed no HTML page at all/)
})
