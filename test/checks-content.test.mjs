import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checks } from '../skills/launch-audit/scripts/lib/checks/content.mjs'
import { findingsFor, has, of, allEvidence, evidenceText } from './checks-helpers.mjs'

const run = (fixture, options) => findingsFor(checks, `recorded/${fixture}`, options)
// One phone, one address, one email, one spelling, this year's copyright: the negative case.
const good = () => run('content-good-site.json', { url: 'https://good-content.test/' })
// A stale footer, a sale that ended, two phone numbers, two addresses, two emails, an entity that
// reached the reader, a British spelling next to an American one, and a page of lorem ipsum.
const bad = () => run('content-site.json', { url: 'https://content.test/' })

test('every check is registrable, http-tier, and in the content dimension', () => {
  assert.ok(checks.length > 0)
  for (const check of checks) {
    assert.equal(check.phase, 'launch-audit')
    assert.equal(check.dimension, 'content')
    assert.ok(check.id.startsWith('content.'))
    assert.equal(check.tier, 'http')
    assert.ok(check.title && check.catches)
  }
  assert.equal(new Set(checks.map((c) => c.id)).size, checks.length)
})

test('a site whose copy is finished and consistent reports nothing at all', async () => {
  assert.deepEqual(await good(), [])
})

test('content.placeholder-text fires on lorem ipsum in the body and a TODO in the title', async () => {
  const found = of(await bad(), 'content.placeholder-text')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'high')
  assert.equal(found[0].page, 'https://content.test/placeholder')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /Lorem ipsum/i)
  assert.match(evidence, /TODO/)
  assert.match(evidence, /title/)
  assert.ok(!has(await good(), 'content.placeholder-text'))
})

test('content.copyright-year-stale is one finding per stale year, listing the pages', async () => {
  const found = of(await bad(), 'content.copyright-year-stale')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'low')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /2024/)
  assert.match(evidence, /content\.test\/about/)
  // The good site's footer already says 2026, the pinned "now".
  assert.ok(!has(await good(), 'content.copyright-year-stale'))
})

test('content.past-dated-promo fires on a sale that has ended and leaves a future one alone', async () => {
  const found = of(await bad(), 'content.past-dated-promo')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  assert.equal(found[0].page, 'https://content.test/')
  assert.match(evidenceText(found[0]), /ends Aug 31/i)
  // "open until Dec 15" on /about is still in the future at the pinned now.
  assert.ok(!allEvidence(found).includes('Dec 15'))
  assert.ok(!has(await good(), 'content.past-dated-promo'))
})

test('content.phone-variants fires on two different numbers and not on two spellings of one', async () => {
  const found = of(await bad(), 'content.phone-variants')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /5551234567/)
  assert.match(evidence, /5559876543/)
  // The good site writes one number as "(555) 010-1234" and as tel:+15550101234.
  assert.ok(!has(await good(), 'content.phone-variants'))
})

test('content.email-variants fires on two addresses used site-wide', async () => {
  const found = of(await bad(), 'content.email-variants')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'info')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /hello@content\.test/)
  assert.match(evidence, /info@content\.test/)
  assert.ok(!has(await good(), 'content.email-variants'))
})

test('content.address-variants fires on two postal codes next to a state code', async () => {
  const found = of(await bad(), 'content.address-variants')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'info')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /62704/)
  assert.match(evidence, /62565/)
  assert.ok(!has(await good(), 'content.address-variants'))
})

test('content.broken-entity fires on an entity the reader can see', async () => {
  const found = of(await bad(), 'content.broken-entity')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'low')
  assert.equal(found[0].page, 'https://content.test/')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /&amp;/)
  assert.match(evidence, /&nbsp;/)
  assert.ok(!has(await good(), 'content.broken-entity'))
})

test('content.mixed-spelling fires on color next to colour, and on nothing else', async () => {
  const found = of(await bad(), 'content.mixed-spelling')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'info')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /color/)
  assert.match(evidence, /colour/)
  assert.ok(!evidence.includes('centre'))
  assert.ok(!has(await good(), 'content.mixed-spelling'))
})
