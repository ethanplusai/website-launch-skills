import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeBaseline, diffBaseline } from '../skills/launch-audit/scripts/lib/baseline.mjs'

function fakePage({ title = 'Home', description = 'desc', canonical = 'https://x.test/', robots = null, h1 = 'Welcome', jsonldTypes = ['Organization'], images = 1, links = 2 } = {}) {
  const metaByName = new Map()
  if (description !== null) metaByName.set('description', description)
  return {
    head: { title, metaByName, canonical, robots },
    headings: h1 === null ? [] : [{ level: 1, text: h1 }, { level: 2, text: 'sub' }],
    jsonld: jsonldTypes.map((t) => ({ raw: '', parsed: { '@type': t }, error: null })),
    images: Array.from({ length: images }, () => ({ src: 'https://x.test/a.png' })),
    links: Array.from({ length: links }, () => ({ href: 'https://x.test/b' })),
  }
}

function crawlPage(url, overrides = {}) {
  return {
    url, status: 200, finalUrl: url, depth: 0, source: 'crawl', title: 'Home',
    page: fakePage(overrides.pageOpts),
    response: { chain: overrides.chain ?? [], headers: overrides.headers ?? { 'content-type': 'text/html', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } },
    ...overrides,
  }
}

// --- makeBaseline ---

test('makeBaseline derives host and https from the first page url', () => {
  const b = makeBaseline({ pages: [crawlPage('https://x.test/b'), crawlPage('https://x.test/a')] })
  assert.equal(b.host, 'x.test')
  assert.equal(b.https, true)
})

test('makeBaseline sorts pages by url', () => {
  const b = makeBaseline({ pages: [crawlPage('https://x.test/b'), crawlPage('https://x.test/a')] })
  assert.deepEqual(b.pages.map((p) => p.url), ['https://x.test/a', 'https://x.test/b'])
})

test('makeBaseline captures title, description, canonical, robotsMeta, h1, jsonldTypes, image and link counts', () => {
  const b = makeBaseline({ pages: [crawlPage('https://x.test/', { pageOpts: { title: 'Home', description: 'd', canonical: 'https://x.test/', robots: 'noindex', h1: 'Hi', jsonldTypes: ['Organization', 'WebSite'], images: 3, links: 5 } })] })
  const p = b.pages[0]
  assert.equal(p.title, 'Home')
  assert.equal(p.description, 'd')
  assert.equal(p.canonical, 'https://x.test/')
  assert.equal(p.robotsMeta, 'noindex')
  assert.equal(p.h1, 'Hi')
  assert.deepEqual(p.jsonldTypes, ['Organization', 'WebSite'])
  assert.equal(p.imageCount, 3)
  assert.equal(p.linkCount, 5)
})

test('makeBaseline pulls content-type, cache-control, and x-robots-tag from response headers', () => {
  const b = makeBaseline({ pages: [crawlPage('https://x.test/', { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'max-age=0', 'x-robots-tag': 'noindex', 'other-header': 'ignored' } })] })
  assert.deepEqual(b.pages[0].headers, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'max-age=0', 'x-robots-tag': 'noindex' })
})

test('makeBaseline records the redirect chain from the response', () => {
  const chain = [{ url: 'https://x.test/old', status: 301, location: 'https://x.test/new' }]
  const b = makeBaseline({ pages: [crawlPage('https://x.test/new', { chain })] })
  assert.deepEqual(b.pages[0].redirectChain, chain)
})

test('makeBaseline reads analyticsTags from analyticsByPage, defaulting to empty', () => {
  const analyticsByPage = new Map([['https://x.test/a', ['GA4']]])
  const b = makeBaseline({ pages: [crawlPage('https://x.test/a'), crawlPage('https://x.test/b')] }, { analyticsByPage })
  const byUrl = new Map(b.pages.map((p) => [p.url, p]))
  assert.deepEqual(byUrl.get('https://x.test/a').analyticsTags, ['GA4'])
  assert.deepEqual(byUrl.get('https://x.test/b').analyticsTags, [])
})

test('makeBaseline threads through securityHeaders (as hsts), cert, robotsHash, and sitemapUrls', () => {
  const b = makeBaseline(
    { pages: [crawlPage('https://x.test/')] },
    {
      securityHeaders: { 'strict-transport-security': 'max-age=63072000' },
      cert: { expires: '2027-01-01T00:00:00.000Z', daysLeft: 300, extraField: 'dropped' },
      robotsHash: 'abc123',
      sitemapUrls: ['https://x.test/sitemap.xml'],
    }
  )
  assert.equal(b.hsts, 'max-age=63072000')
  assert.deepEqual(b.cert, { expires: '2027-01-01T00:00:00.000Z', daysLeft: 300 })
  assert.equal(b.robotsTxtHash, 'abc123')
  assert.deepEqual(b.sitemapUrls, ['https://x.test/sitemap.xml'])
  assert.deepEqual(b.securityHeaders, { 'strict-transport-security': 'max-age=63072000' })
})

test('makeBaseline uses a supplied `now` for generatedAt (round-trips)', () => {
  const now = new Date('2026-05-01T12:00:00.000Z')
  const b = makeBaseline({ pages: [crawlPage('https://x.test/')] }, { now })
  assert.equal(b.generatedAt, '2026-05-01T12:00:00.000Z')
})

test('makeBaseline flattens array @type values, dedupes, and ignores non-string entries', () => {
  const page = {
    head: { title: 't', metaByName: new Map(), canonical: null, robots: null },
    headings: [],
    jsonld: [
      { raw: '', parsed: { '@type': ['Organization', 'LocalBusiness'] }, error: null },
      { raw: '', parsed: { '@type': 'Organization' }, error: null }, // duplicate of the first entry's first type
      { raw: '', parsed: { '@type': 42 }, error: null }, // non-string, ignored
      { raw: '', parsed: null, error: 'bad json' }, // no parsed value at all
    ],
    images: [],
    links: [],
  }
  const c = { url: 'https://x.test/', status: 200, finalUrl: 'https://x.test/', page, response: { chain: [], headers: {} } }
  const b = makeBaseline({ pages: [c] })
  assert.deepEqual(b.pages[0].jsonldTypes, ['Organization', 'LocalBusiness'])
})

test('makeBaseline handles a page with no parsed Page (null fields, zero counts)', () => {
  const c = crawlPage('https://x.test/missing')
  c.page = null
  c.status = 404
  const b = makeBaseline({ pages: [c] })
  const p = b.pages[0]
  assert.equal(p.title, null)
  assert.equal(p.description, null)
  assert.equal(p.h1, null)
  assert.deepEqual(p.jsonldTypes, [])
  assert.equal(p.imageCount, 0)
  assert.equal(p.linkCount, 0)
})

// --- diffBaseline ---

function baselineOf(pages) {
  return { generatedAt: '2026-01-01T00:00:00.000Z', host: 'x.test', https: true, hsts: null, cert: null, robotsTxtHash: null, sitemapUrls: [], securityHeaders: {}, pages }
}

function basePage(url, overrides = {}) {
  return {
    url, status: 200, finalUrl: url, redirectChain: [], title: 'Home', description: 'd', canonical: url,
    robotsMeta: null, h1: 'Hi', jsonldTypes: ['Organization'], analyticsTags: ['GA4'],
    headers: { 'content-type': 'text/html', 'cache-control': null, 'x-robots-tag': null }, imageCount: 1, linkCount: 1,
    ...overrides,
  }
}

test('diffBaseline detects a missing page', () => {
  const before = baselineOf([basePage('https://x.test/'), basePage('https://x.test/gone')])
  const after = baselineOf([basePage('https://x.test/')])
  const diff = diffBaseline(before, after)
  assert.deepEqual(diff.missingPages, ['https://x.test/gone'])
  assert.deepEqual(diff.newPages, [])
})

test('diffBaseline detects a new page', () => {
  const before = baselineOf([basePage('https://x.test/')])
  const after = baselineOf([basePage('https://x.test/'), basePage('https://x.test/new')])
  const diff = diffBaseline(before, after)
  assert.deepEqual(diff.newPages, ['https://x.test/new'])
})

test('diffBaseline detects a title change', () => {
  const before = baselineOf([basePage('https://x.test/', { title: 'Old Title' })])
  const after = baselineOf([basePage('https://x.test/', { title: 'New Title' })])
  const diff = diffBaseline(before, after)
  assert.deepEqual(diff.changed, [{ url: 'https://x.test/', field: 'title', before: 'Old Title', after: 'New Title' }])
})

test('diffBaseline does not report jsonldTypes as changed when only the order differs', () => {
  const before = baselineOf([basePage('https://x.test/', { jsonldTypes: ['Organization', 'WebSite'] })])
  const after = baselineOf([basePage('https://x.test/', { jsonldTypes: ['WebSite', 'Organization'] })])
  const diff = diffBaseline(before, after)
  assert.deepEqual(diff.changed, [])
})

test('diffBaseline detects a status change', () => {
  const before = baselineOf([basePage('https://x.test/a', { status: 200 })])
  const after = baselineOf([basePage('https://x.test/a', { status: 404 })])
  const diff = diffBaseline(before, after)
  assert.deepEqual(diff.statusChanges, [{ url: 'https://x.test/a', before: 200, after: 404 }])
})

test('diffBaseline detects a new redirect (empty chain before, non-empty after)', () => {
  const before = baselineOf([basePage('https://x.test/a', { redirectChain: [] })])
  const chain = [{ url: 'https://x.test/old-a', status: 301, location: 'https://x.test/a' }]
  const after = baselineOf([basePage('https://x.test/a', { redirectChain: chain })])
  const diff = diffBaseline(before, after)
  assert.deepEqual(diff.newRedirects, [{ url: 'https://x.test/a', before: [], after: chain }])
})

test('diffBaseline detects a lost analytics tag', () => {
  const before = baselineOf([basePage('https://x.test/', { analyticsTags: ['GA4', 'Meta Pixel'] })])
  const after = baselineOf([basePage('https://x.test/', { analyticsTags: ['GA4'] })])
  const diff = diffBaseline(before, after)
  assert.deepEqual(diff.analyticsLost, [{ url: 'https://x.test/', tags: ['Meta Pixel'] }])
})

test('diffBaseline reports no changes for two identical baselines', () => {
  const before = baselineOf([basePage('https://x.test/')])
  const after = baselineOf([basePage('https://x.test/')])
  const diff = diffBaseline(before, after)
  assert.deepEqual(diff, { missingPages: [], newPages: [], statusChanges: [], newRedirects: [], changed: [], analyticsLost: [] })
})
