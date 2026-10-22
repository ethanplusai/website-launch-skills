import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checks } from '../skills/launch-audit/scripts/lib/checks/content.mjs'
import { findingsFor, has, of, allEvidence, evidenceText } from './checks-helpers.mjs'
import { readFixture } from './helpers.mjs'

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

// A site exactly as a starter leaves it, recorded: the sample blog post, and a canonical and an image
// still on example.com. Its contact page carries `placeholder="you@example.com"` hints and nothing
// else wrong, so it is the page that must stay quiet.
const starter = () => run('content-starter-site.json', { url: 'https://starter.test/' })

test('content.placeholder-text names the starter\'s sample post on the blog index and on the post', async () => {
  const found = of(await starter(), 'content.placeholder-text')
  const byPage = new Map(found.map((f) => [f.page, f]))
  const index = byPage.get('https://starter.test/blog/')
  assert.ok(index, 'the blog index lists the sample post and should be flagged')
  assert.equal(index.severity, 'high')
  assert.match(evidenceText(index), /body text: Sample Post/)
  assert.match(evidenceText(index), /body text: Delete Me/)
  const post = byPage.get('https://starter.test/blog/sample-post/')
  assert.ok(post, 'the sample post itself should be flagged')
  const evidence = evidenceText(post)
  assert.match(evidence, /title: Sample Post/)
  assert.match(evidence, /body text: Sample Post/)
  assert.match(evidence, /body text: Delete Me/)
})

test('content.placeholder-text reads a link to example.com from the markup: a canonical first, then the image', async () => {
  const url = 'https://starter.test/blog/sample-post/'
  const post = of(await starter(), 'content.placeholder-text').find((f) => f.page === url)
  assert.ok(post)
  // One markup hit per pattern, and the first in the document is the canonical in the head.
  assert.match(evidenceText(post), /markup: href="https:\/\/example\.com\/blog\/sample-post\//)
  assert.match(post.detail, /in the markup/)

  // With the canonical put right, the image the sample post ships is what is left to name.
  const record = JSON.parse(readFixture('recorded/content-starter-site.json'))[url]
  const body = record.body.replace('https://example.com/blog/sample-post/', 'https://starter.test/blog/sample-post/')
  const fixed = await run('content-starter-site.json', { url: 'https://starter.test/', records: { [url]: { ...record, body } } })
  const image = of(fixed, 'content.placeholder-text').find((f) => f.page === url)
  assert.match(evidenceText(image), /markup: src="https:\/\/pub-0123456789abcdef\.r2\.dev\/example\.com\//)
  assert.ok(!evidenceText(image).includes('markup: href='))
})

test('content.placeholder-text leaves example.com hints in a form, and finished pages, alone', async () => {
  const pages = of(await starter(), 'content.placeholder-text').map((f) => f.page).sort()
  assert.deepEqual(pages, ['https://starter.test/blog/', 'https://starter.test/blog/sample-post/'])
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
  // &apos; is decoded like any other entity html.mjs knows, so an apostrophe is not a defect.
  assert.ok(!evidence.includes('&apos;'))
  assert.ok(!has(await good(), 'content.broken-entity'))
})

test('a malformed percent escape in a tel: or mailto: href does not throw the dimension', async () => {
  const findings = await bad()
  // /placeholder carries mailto:jo%e@content.test and tel:+1-555-100%; both dimensions that decode
  // an href run over them, and the run completes.
  assert.ok(findings.length > 0)
  assert.match(allEvidence(of(findings, 'content.email-variants')), /jo%e@content\.test/)
  // The broken tel has seven digits, so it is not a phone number and not a second variant.
  assert.ok(!allEvidence(of(findings, 'content.phone-variants')).includes('555-100%'))
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
