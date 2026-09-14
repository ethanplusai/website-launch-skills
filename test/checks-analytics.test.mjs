import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checks } from '../skills/launch-audit/scripts/lib/checks/analytics.mjs'
import { findingsFor, has, of, allEvidence, evidenceText } from './checks-helpers.mjs'

const run = (fixture, options) => findingsFor(checks, `recorded/${fixture}`, options)
// One property, installed once, on every page.
const good = () => run('analytics-good-site.json', { url: 'https://good-analytics.test/' })
// Doubled on the home page, a second property on /about, and nothing at all on /contact.
const bad = () => run('analytics-site.json', { url: 'https://analytics.test/' })
// No measurement anywhere.
const none = () => run('analytics-none-site.json', { url: 'https://noanalytics.test/' })

test('every check is registrable, http-tier, and in the analytics dimension', () => {
  assert.ok(checks.length > 0)
  for (const check of checks) {
    assert.equal(check.phase, 'launch-audit')
    assert.equal(check.dimension, 'analytics')
    assert.ok(check.id.startsWith('analytics.'))
    assert.equal(check.tier, 'http')
    assert.ok(check.title && check.catches)
  }
  assert.equal(new Set(checks.map((c) => c.id)).size, checks.length)
})

test('one property installed once on every page reports only the summary', async () => {
  assert.deepEqual([...new Set((await good()).map((f) => f.id))], ['analytics.summary'])
})

test('analytics.none-detected fires on a site with no tag anywhere', async () => {
  const found = of(await none(), 'analytics.none-detected')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'high')
  assert.match(evidenceText(found[0]), /2 pages/)
  assert.ok(!has(await good(), 'analytics.none-detected'))
  assert.ok(!has(await bad(), 'analytics.none-detected'))
})

test('a site with no analytics gets no summary and no missing-on-pages', async () => {
  const findings = await none()
  assert.ok(!has(findings, 'analytics.summary'))
  assert.ok(!has(findings, 'analytics.missing-on-pages'))
})

test('analytics.missing-on-pages lists the pages the tag never reached', async () => {
  const found = of(await bad(), 'analytics.missing-on-pages')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /GA4/)
  assert.match(evidence, /analytics\.test\/contact/)
  assert.ok(!evidence.includes('analytics.test/about'))
  assert.ok(!has(await good(), 'analytics.missing-on-pages'))
})

test('analytics.duplicate-install fires when one page carries the same tool twice', async () => {
  const found = of(await bad(), 'analytics.duplicate-install')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  assert.equal(found[0].page, 'https://analytics.test/')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /GA4/)
  assert.match(evidence, /2/)
  assert.ok(!has(await good(), 'analytics.duplicate-install'))
})

test('analytics.inconsistent-ids fires when two pages report to different properties', async () => {
  const found = of(await bad(), 'analytics.inconsistent-ids')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'high')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /G-AAAA1111/)
  assert.match(evidence, /G-BBBB2222/)
  assert.ok(!has(await good(), 'analytics.inconsistent-ids'))
})

test('analytics.summary lists every tool found and the ids it reports to', async () => {
  const found = of(await good(), 'analytics.summary')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'info')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /GA4/)
  assert.match(evidence, /G-GOOD1234/)
  assert.match(evidence, /2 of 2 pages/)
})

test('a correctly installed tag is never reported as a duplicate of itself', async () => {
  // The good site loads gtag.js and then calls gtag("config") — two script tags, one install.
  assert.ok(!has(await good(), 'analytics.duplicate-install'))
  assert.ok(!has(await good(), 'analytics.inconsistent-ids'))
})
