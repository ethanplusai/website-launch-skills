import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checks } from '../skills/launch-audit/scripts/lib/checks/images.mjs'
import { findingsFor, has, of, allEvidence, evidenceText } from './checks-helpers.mjs'

const run = (fixture, options) => findingsFor(checks, `recorded/${fixture}`, options)
// Sized, described, lazily loaded below the fold, and served from a <picture>: the negative case.
const good = () => run('images-good-site.json', { url: 'https://good-images.test/' })
// Unsized, undescribed, eagerly loaded, broken, oversized, duplicated and loudly autoplaying.
const bad = () => run('images-site.json', { url: 'https://images.test/' })

test('every check is registrable, http-tier, and in the images dimension', () => {
  assert.ok(checks.length > 0)
  for (const check of checks) {
    assert.equal(check.phase, 'launch-audit')
    assert.equal(check.dimension, 'images')
    assert.ok(check.id.startsWith('images.'))
    assert.equal(check.tier, 'http')
    assert.ok(check.title && check.catches)
  }
  assert.equal(new Set(checks.map((c) => c.id)).size, checks.length)
})

test('a site whose images are in order reports nothing at all', async () => {
  assert.deepEqual(await good(), [])
})

test('images.alt-missing lists the images on a page with no alt attribute', async () => {
  const found = of(await bad(), 'images.alt-missing')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'high')
  assert.equal(found[0].page, 'https://images.test/')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /three\.png/)
  // An empty alt is a decision, not an omission, and a described image is neither.
  assert.ok(!evidence.includes('two.png'))
  assert.ok(!has(await good(), 'images.alt-missing'))
})

test('images.dimensions-missing lists the images with neither width nor height', async () => {
  const found = of(await bad(), 'images.dimensions-missing')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /two\.png/)
  assert.match(evidence, /three\.png/)
  assert.ok(!evidence.includes('four.png'))
  assert.ok(!has(await good(), 'images.dimensions-missing'))
})

test('images.lazy-on-first-image fires when the first image on a page defers itself', async () => {
  const found = of(await bad(), 'images.lazy-on-first-image')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  assert.equal(found[0].page, 'https://images.test/')
  assert.match(evidenceText(found[0]), /hero\.jpg/)
  assert.ok(!has(await good(), 'images.lazy-on-first-image'))
})

test('images.not-lazy-below-fold lists the images past the third that load eagerly', async () => {
  const found = of(await bad(), 'images.not-lazy-below-fold')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'low')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /four\.png/)
  // The images after it already declare loading="lazy".
  assert.ok(!evidence.includes('big.png'))
  assert.ok(!has(await good(), 'images.not-lazy-below-fold'))
})

test('images.legacy-format fires on a bare jpg and never on one inside a <picture>', async () => {
  const found = of(await bad(), 'images.legacy-format')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'low')
  assert.match(evidenceText(found[0]), /hero\.jpg/)
  // The good site serves the same filename from a <picture> with an avif source.
  assert.ok(!has(await good(), 'images.legacy-format'))
})

test('images.oversized names the image and how much it weighs', async () => {
  const found = of(await bad(), 'images.oversized')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /big\.png/)
  assert.match(evidence, /912345|891|KB/)
  assert.ok(!has(await good(), 'images.oversized'))
})

test('images.broken fires on an image url that does not 200', async () => {
  const found = of(await bad(), 'images.broken')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'high')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /missing\.png/)
  assert.match(evidence, /404/)
  assert.ok(!has(await good(), 'images.broken'))
})

test('images.duplicate-across-pages groups two urls that carry identical bytes', async () => {
  const found = of(await bad(), 'images.duplicate-across-pages')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'low')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /shared\.png/)
  assert.match(evidence, /shared-copy\.png/)
  assert.match(evidence, /images\.test\/two/)
  assert.ok(!has(await good(), 'images.duplicate-across-pages'))
})

test('one image url reused across pages is caching, not duplication', async () => {
  // The good site puts the same /logo.png on both its pages, under one url.
  assert.ok(!has(await good(), 'images.duplicate-across-pages'))
})

test('images.video-autoplay-sound fires on autoplay without muted', async () => {
  const found = of(await bad(), 'images.video-autoplay-sound')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  assert.match(evidenceText(found[0]), /loud\.mp4/)
  // The good site's video is muted, which is the only autoplay a browser will honour.
  assert.ok(!has(await good(), 'images.video-autoplay-sound'))
})

test('images.video-captions-missing fires on a video with no track', async () => {
  const found = of(await bad(), 'images.video-captions-missing')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'info')
  assert.match(allEvidence(found), /loud\.mp4/)
  assert.ok(!has(await good(), 'images.video-captions-missing'))
})

// I6: a response whose declared content-length was over the read cap is never downloaded, so its
// size is the server's word rather than a measurement. Saying "912345 bytes" of bytes nobody
// counted is a claim about a file this audit did not read.
test('images.oversized says "declared" when the body was never read', async () => {
  const found = of(await run('images-site.json', {
    url: 'https://images.test/',
    records: {
      'https://images.test/big.png': {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '9000000' },
        bytes: 9000000,
        truncated: true,
      },
    },
  }), 'images.oversized')
  assert.equal(found.length, 1)
  assert.match(evidenceText(found[0]), /declared 9000000 bytes/)
  // The measured wording is what a fully-read image still gets.
  assert.match(evidenceText(of(await bad(), 'images.oversized')[0]), /912345 bytes/)
  assert.ok(!/declared/.test(evidenceText(of(await bad(), 'images.oversized')[0])))
})
