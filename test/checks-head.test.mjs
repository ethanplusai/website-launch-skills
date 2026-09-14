import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checks } from '../skills/launch-audit/scripts/lib/checks/head.mjs'
import { findingsFor, has, of, allEvidence, evidenceText } from './checks-helpers.mjs'

const run = (fixture, options) => findingsFor(checks, `recorded/${fixture}`, options)
// A site that gets its head right, the negative case for everything below.
const good = () => run('head-good-site.json', { url: 'https://good-head.test/' })
// Titles, descriptions, headings, language, viewport, icons and stray metas, all wrong.
const bad = () => run('head-bad-site.json', { url: 'https://bad-head.test/' })
const og = () => run('og-site.json', { url: 'https://og.test/' })
const ld = () => run('jsonld-site.json', { url: 'https://ld.test/' })

const pages = (findings) => findings.map((f) => f.page).sort()

test('every check is registrable, http-tier, and in the head dimension', () => {
  assert.ok(checks.length > 0)
  for (const check of checks) {
    assert.equal(check.phase, 'launch-audit')
    assert.equal(check.dimension, 'head')
    assert.ok(check.id.startsWith('head.'))
    assert.equal(check.tier, 'http')
    assert.ok(check.title && check.catches)
  }
  assert.equal(new Set(checks.map((c) => c.id)).size, checks.length)
})

test('a site with a correct head reports nothing but the structured-data summary', async () => {
  assert.deepEqual([...new Set((await good()).map((f) => f.id))], ['head.jsonld-types-summary'])
})

test('head.title-missing fires on a page with no title element', async () => {
  const found = of(await bad(), 'head.title-missing')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'high')
  assert.equal(found[0].page, 'https://bad-head.test/')
  assert.ok(!has(await good(), 'head.title-missing'))
})

test('head.title-duplicate reports one finding per shared title, listing every page', async () => {
  const found = of(await bad(), 'head.title-duplicate')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'high')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /Widgets, Gadgets and Sprockets/)
  assert.match(evidence, /bad-head\.test\/dup-one/)
  assert.match(evidence, /bad-head\.test\/dup-two/)
  assert.ok(!has(await good(), 'head.title-duplicate'))
})

test('head.title-length fires both under ten characters and over sixty', async () => {
  const found = of(await bad(), 'head.title-length')
  assert.deepEqual(pages(found), ['https://bad-head.test/framework', 'https://bad-head.test/home', 'https://bad-head.test/long'])
  assert.equal(found[0].severity, 'low')
  assert.match(allEvidence(found), /5 characters/)
  assert.match(allEvidence(found), /89 characters/)
  assert.ok(!has(await good(), 'head.title-length'))
})

test('head.title-framework-default fires on a starter template title', async () => {
  const found = of(await bad(), 'head.title-framework-default')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'high')
  assert.match(evidenceText(found[0]), /Astro/)
  assert.ok(!has(await good(), 'head.title-framework-default'))
})

test('head.title-framework-default leaves a page genuinely titled Home alone', async () => {
  const found = of(await bad(), 'head.title-framework-default')
  assert.deepEqual(found.map((f) => f.page), ['https://bad-head.test/framework'])
  assert.ok(!found.some((f) => f.page === 'https://bad-head.test/home'))
})

test('head.description-missing fires on a page with no description meta', async () => {
  const found = of(await bad(), 'head.description-missing')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  assert.equal(found[0].page, 'https://bad-head.test/')
  assert.ok(!has(await good(), 'head.description-missing'))
})

test('head.description-duplicate reports one finding per shared description', async () => {
  const found = of(await bad(), 'head.description-duplicate')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  assert.match(evidenceText(found[0]), /bad-head\.test\/dup-one/)
  assert.match(evidenceText(found[0]), /bad-head\.test\/dup-two/)
  // The two pages write that description with different internal whitespace, and it is still one
  // description: the grouping collapses runs of space the way a title already is.
  assert.ok(!has(await good(), 'head.description-duplicate'))
})

test('head.description-length fires under fifty characters and over a hundred and sixty', async () => {
  const found = of(await bad(), 'head.description-length')
  assert.deepEqual(pages(found), ['https://bad-head.test/framework', 'https://bad-head.test/long'])
  assert.equal(found[0].severity, 'low')
  assert.ok(!has(await good(), 'head.description-length'))
})

test('head.h1-missing fires on a page with no first-level heading', async () => {
  const found = of(await bad(), 'head.h1-missing')
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://bad-head.test/')
  assert.equal(found[0].severity, 'medium')
  assert.ok(!has(await good(), 'head.h1-missing'))
})

test('head.h1-multiple fires when a page has two h1 elements', async () => {
  const found = of(await bad(), 'head.h1-multiple')
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://bad-head.test/framework')
  assert.match(evidenceText(found[0]), /2/)
  assert.ok(!has(await good(), 'head.h1-multiple'))
})

test('head.heading-skip fires when a heading level jumps by more than one', async () => {
  const found = of(await bad(), 'head.heading-skip')
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://bad-head.test/framework')
  assert.match(evidenceText(found[0]), /h1 → h3|<h3>/)
  assert.ok(!has(await good(), 'head.heading-skip'))
})

test('head.heading-empty fires on a heading with no text', async () => {
  const found = of(await bad(), 'head.heading-empty')
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://bad-head.test/framework')
  assert.ok(!has(await good(), 'head.heading-empty'))
})

test('head.lang-missing fires when html carries no lang attribute', async () => {
  const found = of(await bad(), 'head.lang-missing')
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://bad-head.test/')
  assert.equal(found[0].severity, 'medium')
  assert.ok(!has(await good(), 'head.lang-missing'))
})

test('head.charset-missing fires when nothing declares the encoding', async () => {
  const found = of(await bad(), 'head.charset-missing')
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://bad-head.test/')
  assert.ok(!has(await good(), 'head.charset-missing'))
})

test('head.viewport-missing fires when there is no viewport meta', async () => {
  const found = of(await bad(), 'head.viewport-missing')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'high')
  assert.equal(found[0].page, 'https://bad-head.test/')
  assert.ok(!has(await good(), 'head.viewport-missing'))
})

test('head.viewport-blocks-zoom fires on user-scalable=no and maximum-scale=1', async () => {
  const found = of(await bad(), 'head.viewport-blocks-zoom')
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://bad-head.test/framework')
  assert.match(evidenceText(found[0]), /user-scalable=no/)
  assert.ok(!has(await good(), 'head.viewport-blocks-zoom'))
})

test('head.favicon-missing fires when no link rel is exactly icon, touch and mask icons included', async () => {
  const found = of(await bad(), 'head.favicon-missing')
  // /touch-only declares an apple-touch-icon and a mask-icon and no favicon: neither rel is the
  // favicon, so the page is still missing one. /shortcut spells it `rel="shortcut icon"`, which is.
  assert.deepEqual(pages(found), ['https://bad-head.test/', 'https://bad-head.test/touch-only'])
  assert.ok(!found.some((f) => f.page === 'https://bad-head.test/shortcut'))
  assert.ok(!has(await good(), 'head.favicon-missing'))
})

test('head.favicon-broken fires on every page declaring the icon that 404s, and on no other', async () => {
  const found = of(await bad(), 'head.favicon-broken')
  // Seven of the nine pages declare /favicon.ico, which answers 404. `/` and `/touch-only` declare
  // no favicon at all, so they are `head.favicon-missing`'s business rather than this one's.
  assert.deepEqual(pages(found), [
    'https://bad-head.test/dup-one', 'https://bad-head.test/dup-two', 'https://bad-head.test/framework',
    'https://bad-head.test/home', 'https://bad-head.test/long', 'https://bad-head.test/minified',
    'https://bad-head.test/shortcut',
  ])
  assert.match(allEvidence(found), /favicon\.ico/)
  assert.match(allEvidence(found), /404/)
  assert.ok(!has(await good(), 'head.favicon-broken'))
})

test('head.apple-touch-icon-missing fires on every page but the one that declares a touch icon', async () => {
  const found = of(await bad(), 'head.apple-touch-icon-missing')
  // Eight of the nine pages. `/touch-only` is the exception: it declares an apple-touch-icon and
  // nothing else, which is the negative case this check needs and the fixture's whole reason for
  // that page. (The old assertion — `found.includes(found.find(…))` — is true of any non-empty
  // array and false of none, so it asserted only that the array was not empty.)
  assert.equal(found.length, 8)
  assert.ok(pages(found).includes('https://bad-head.test/'))
  assert.ok(!pages(found).includes('https://bad-head.test/touch-only'))
  for (const finding of found) assert.equal(finding.severity, 'low')
  assert.ok(!has(await good(), 'head.apple-touch-icon-missing'))
})

test('head.manifest-missing is an info finding on each of the nine pages with no manifest', async () => {
  const found = of(await bad(), 'head.manifest-missing')
  assert.equal(found.length, 9)
  assert.ok(pages(found).includes('https://bad-head.test/touch-only'))
  for (const finding of found) assert.equal(finding.severity, 'info')
  assert.ok(!has(await good(), 'head.manifest-missing'))
})

test('head.theme-color-missing is an info finding on each of the nine pages with no theme colour', async () => {
  const found = of(await bad(), 'head.theme-color-missing')
  assert.equal(found.length, 9)
  assert.ok(pages(found).includes('https://bad-head.test/'))
  for (const finding of found) assert.equal(finding.severity, 'info')
  assert.ok(!has(await good(), 'head.theme-color-missing'))
})

test('head.og-missing reports one finding per absent Open Graph property', async () => {
  const found = of(await og(), 'head.og-missing').filter((f) => f.page === 'https://og.test/plain')
  assert.equal(found.length, 5)
  assert.equal(found[0].severity, 'medium')
  const evidence = allEvidence(found)
  for (const property of ['og:title', 'og:description', 'og:image', 'og:url', 'og:type']) assert.match(evidence, new RegExp(property))
  assert.ok(!has(await good(), 'head.og-missing'))
})

test('head.og-image-broken fires when the card image does not 200', async () => {
  const found = of(await og(), 'head.og-image-broken')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'high')
  assert.equal(found[0].page, 'https://og.test/broken')
  assert.match(evidenceText(found[0]), /404/)
  assert.ok(!has(await good(), 'head.og-image-broken'))
})

test('head.og-image-not-raster fires for an SVG card and for bytes that are no image at all', async () => {
  const found = of(await og(), 'head.og-image-not-raster')
  assert.deepEqual(pages(found), ['https://og.test/junk', 'https://og.test/vector'])
  assert.equal(found[0].severity, 'medium')
  assert.ok(!has(await good(), 'head.og-image-not-raster'))
})

test('head.og-image-small fires under 1200x630 and cites the measured size', async () => {
  const found = of(await og(), 'head.og-image-small')
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://og.test/')
  assert.match(evidenceText(found[0]), /600 ?× ?315|600x315/)
  assert.ok(!has(await good(), 'head.og-image-small'))
})

test('head.og-image-dimensions-missing fires when the card declares no width or height', async () => {
  const found = of(await og(), 'head.og-image-dimensions-missing')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'low')
  assert.equal(found[0].page, 'https://og.test/')
  assert.ok(!has(await good(), 'head.og-image-dimensions-missing'))
})

test('head.og-url-mismatch fires when og:url and the canonical disagree', async () => {
  const found = of(await og(), 'head.og-url-mismatch')
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://og.test/')
  assert.match(evidenceText(found[0]), /somewhere-else/)
  assert.ok(!has(await good(), 'head.og-url-mismatch'))
})

test('head.twitter-card-missing drops to info when Open Graph is already there', async () => {
  const found = of(await og(), 'head.twitter-card-missing')
  const plain = found.find((f) => f.page === 'https://og.test/plain')
  const withOg = found.find((f) => f.page === 'https://og.test/')
  assert.equal(plain.severity, 'low')
  assert.equal(withOg.severity, 'info')
  assert.ok(!has(await good(), 'head.twitter-card-missing'))
})

test('head.jsonld-invalid fires on a block that does not parse', async () => {
  const found = of(await ld(), 'head.jsonld-invalid')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'high')
  assert.equal(found[0].page, 'https://ld.test/')
  assert.ok(!has(await good(), 'head.jsonld-invalid'))
})

test('head.jsonld-missing-required names the properties a rich result needs', async () => {
  const found = of(await ld(), 'head.jsonld-missing-required')
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://ld.test/')
  assert.match(evidenceText(found[0]), /Organization/)
  assert.match(evidenceText(found[0]), /url/)
  assert.ok(!has(await good(), 'head.jsonld-missing-required'))
})

test('head.jsonld-url-broken fires for a same-origin url the crawl found broken, and not for an off-origin one', async () => {
  const found = of(await ld(), 'head.jsonld-url-broken')
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://ld.test/urls')
  assert.match(evidenceText(found[0]), /ld\.test\/gone/)
  assert.doesNotMatch(evidenceText(found[0]), /elsewhere\.test/)
  assert.ok(!has(await good(), 'head.jsonld-url-broken'))
})

test('head.jsonld-on-noindex fires when structured data sits on a noindexed page', async () => {
  const found = of(await ld(), 'head.jsonld-on-noindex')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'low')
  assert.equal(found[0].page, 'https://ld.test/hidden')
  assert.ok(!has(await good(), 'head.jsonld-on-noindex'))
})

test('head.jsonld-types-summary groups the pages that ship the same set of types', async () => {
  const found = of(await ld(), 'head.jsonld-types-summary')
  assert.equal(found.length, 2)
  assert.equal(found[0].severity, 'info')
  const organization = found.find((f) => evidenceText(f).includes('ld.test/urls'))
  assert.match(evidenceText(organization), /ld\.test\/: Organization/)
  assert.match(evidenceText(organization), /ld\.test\/urls: Organization/)
  const graph = found.find((f) => evidenceText(f).includes('ld.test/hidden'))
  assert.match(evidenceText(graph), /BreadcrumbList, WebSite/)
  assert.ok(!has(await bad(), 'head.jsonld-types-summary'))
})

test('head.duplicate-id lists the ids a page repeats', async () => {
  const found = of(await bad(), 'head.duplicate-id')
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://bad-head.test/')
  assert.match(evidenceText(found[0]), /hero/)
  assert.ok(!has(await good(), 'head.duplicate-id'))
})

test('head.meta-outside-head counts the metas a browser will ignore', async () => {
  const found = of(await bad(), 'head.meta-outside-head')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  assert.equal(found[0].page, 'https://bad-head.test/')
  assert.match(evidenceText(found[0]), /1/)
  assert.ok(!has(await good(), 'head.meta-outside-head'))
})

test('a page minified past its head tag has an implied head, not four metas outside one', async () => {
  const findings = await bad()
  assert.ok(!of(findings, 'head.meta-outside-head').some((f) => f.page === 'https://bad-head.test/minified'))
  // The same page writes its description twice, which is only visible because those metas are
  // counted as head content in the first place.
  const duplicate = of(findings, 'head.meta-duplicate').find((f) => f.page === 'https://bad-head.test/minified')
  assert.ok(duplicate)
  assert.match(evidenceText(duplicate), /description/)
})

test('head.meta-duplicate fires per repeated key, and never on a repeatable one', async () => {
  const found = of(await bad(), 'head.meta-duplicate')
  assert.deepEqual(pages(found), ['https://bad-head.test/', 'https://bad-head.test/minified'])
  assert.equal(found[0].severity, 'low')
  assert.match(allEvidence(found), /keywords/)
  // og:image and og:locale:alternate are repeated on og-site by design: both are legitimately
  // repeatable, so neither is a duplicate.
  assert.ok(!has(await og(), 'head.meta-duplicate'))
  assert.ok(!has(await good(), 'head.meta-duplicate'))
})
