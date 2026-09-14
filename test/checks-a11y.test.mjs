import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checks } from '../skills/launch-audit/scripts/lib/checks/a11y.mjs'
import { findingsFor, has, of, allEvidence, evidenceText } from './checks-helpers.mjs'

const run = (fixture, options) => findingsFor(checks, `recorded/${fixture}`, options)
// A site that gets the http-tier basics right: the negative case for everything below.
const good = () => run('a11y-good-site.json', { url: 'https://a11y-good.test/' })
// A front page with a skipped heading level, an unlabelled input, an empty link, a positive
// tabindex, an autofocus, no <main>, an untitled iframe and an undescribed image.
const bad = () => run('a11y-site.json', { url: 'https://a11y.test/' })
// A site with no images at all: nothing to report an alt coverage for.
const noImages = () => run('links-good-site.json', { url: 'https://good-links.test/' })

test('every check is registrable, http-tier, and in the a11y dimension', async () => {
  assert.ok(checks.length > 0)
  for (const check of checks) {
    assert.equal(check.phase, 'launch-audit')
    assert.equal(check.dimension, 'a11y')
    assert.ok(check.id.startsWith('a11y.'))
    assert.equal(check.tier, 'http')
    assert.ok(check.title && check.catches)
  }
  assert.equal(new Set(checks.map((c) => c.id)).size, checks.length)
})

test('the language attribute belongs to the head dimension, and is never re-reported here', () => {
  assert.ok(!checks.some((check) => check.id === 'a11y.lang-missing'))
})

test('a site that gets the basics right reports nothing above info', async () => {
  assert.deepEqual(of(await good(), 'a11y.form-labels'), [])
  assert.deepEqual((await good()).filter((f) => f.severity !== 'info').map((f) => f.id), [])
})

test('a11y.form-labels names every control with no accessible name', async () => {
  const found = of(await bad(), 'a11y.form-labels')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'high')
  assert.equal(found[0].page, 'https://a11y.test/')
  assert.match(evidenceText(found[0]), /email/)
  // The submit button needs no name of its own, and is not counted as a violation.
  assert.ok(!evidenceText(found[0]).includes('type=submit'))
  assert.ok(!has(await good(), 'a11y.form-labels'))
})

test('a11y.heading-order fires on a level the page skips', async () => {
  const found = of(await bad(), 'a11y.heading-order')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'low')
  assert.match(evidenceText(found[0]), /h1.*h3|h3/)
  assert.ok(!has(await good(), 'a11y.heading-order'))
})

test('a11y.link-text-empty fires on a link with nothing to announce', async () => {
  const found = of(await bad(), 'a11y.link-text-empty')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  assert.match(evidenceText(found[0]), /a11y\.test\/about/)
  assert.ok(!has(await good(), 'a11y.link-text-empty'))
})

test('a11y.tabindex-positive counts the elements that jump the tab order', async () => {
  const found = of(await bad(), 'a11y.tabindex-positive')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'low')
  assert.match(evidenceText(found[0]), /1/)
  assert.ok(!has(await good(), 'a11y.tabindex-positive'))
})

test('a11y.autofocus reports a page that steals focus on load', async () => {
  const found = of(await bad(), 'a11y.autofocus')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'low')
  assert.equal(found[0].page, 'https://a11y.test/')
  assert.ok(!has(await good(), 'a11y.autofocus'))
})

test('a11y.main-landmark-missing lists the pages with no main region', async () => {
  const found = of(await bad(), 'a11y.main-landmark-missing')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  assert.match(evidenceText(found[0]), /a11y\.test\//)
  // /about has a <main> and is not named.
  assert.ok(!evidenceText(found[0]).includes('a11y.test/about'))
  assert.ok(!has(await good(), 'a11y.main-landmark-missing'))
})

test('a11y.iframe-title-missing names the untitled frame', async () => {
  const found = of(await bad(), 'a11y.iframe-title-missing')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  assert.match(evidenceText(found[0]), /maps\.test\/embed/)
  assert.ok(!has(await good(), 'a11y.iframe-title-missing'))
})

test('a11y.image-alt-coverage reports the share of images that carry an alt', async () => {
  const found = of(await bad(), 'a11y.image-alt-coverage')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'info')
  assert.match(evidenceText(found[0]), /50%/)
  // A site with no images has no coverage to report.
  assert.ok(!has(await noImages(), 'a11y.image-alt-coverage'))
})

test('a11y.image-alt-coverage still reports a site that describes every image', async () => {
  const found = of(await good(), 'a11y.image-alt-coverage')
  assert.equal(found.length, 1)
  assert.match(evidenceText(found[0]), /100%/)
})

test('a11y.browser-tier-required says axe did not run, and why', async () => {
  const found = of(await bad(), 'a11y.browser-tier-required')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'info')
  assert.match(found[0].detail, /axe/i)
  assert.match(evidenceText(found[0]), /no browser/i)
})

test('a11y.browser-tier-required says nothing when the browser tier did run', async () => {
  const findings = await run('a11y-site.json', {
    url: 'https://a11y.test/',
    browser: { available: true, reason: null },
    cacheTag: 'browser-ran',
  })
  assert.ok(!has(findings, 'a11y.browser-tier-required'))
  // The rest of the dimension is unaffected.
  assert.ok(has(findings, 'a11y.form-labels'))
})

test('a11y.browser-tier-required repeats the reason the browser tier gave', async () => {
  const findings = await run('a11y-site.json', {
    url: 'https://a11y.test/',
    browser: { available: false, reason: 'Playwright is not installed' },
    cacheTag: 'browser-missing',
  })
  assert.match(allEvidence(of(findings, 'a11y.browser-tier-required')), /Playwright is not installed/)
})
