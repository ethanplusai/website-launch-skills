import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recordedNet, recordedNetFromFile } from './helpers.mjs'
import { crawlSite, normalizeUrl } from '../skills/launch-audit/scripts/lib/crawl.mjs'
import { expandSitemap } from '../skills/launch-audit/scripts/lib/sitemap.mjs'
import { parseRobots } from '../skills/launch-audit/scripts/lib/robots.mjs'

const START = 'https://small.test/'
const SITEMAP_URL = 'https://small.test/sitemap.xml'
const ROBOTS_URL = 'https://small.test/robots.txt'

async function loadSmallSite() {
  const net = recordedNetFromFile('recorded/small-site.json')
  const expanded = await expandSitemap(net, SITEMAP_URL)
  assert.equal(expanded.failedClosed, false, 'fixture sitemap should expand cleanly')
  const sitemapUrls = expanded.urls.map((u) => u.loc)
  const robotsRes = await net.get(ROBOTS_URL)
  const robots = parseRobots(robotsRes.body)
  return { net, sitemapUrls, robots }
}

// --- normalizeUrl ---

test('normalizeUrl resolves against a base and drops the fragment', () => {
  assert.equal(normalizeUrl('/a#frag', 'https://x.test/'), 'https://x.test/a')
})

test('normalizeUrl drops a default port and lowercases scheme+host', () => {
  assert.equal(normalizeUrl('HTTP://Example.COM:80/a', null), 'http://example.com/a')
})

test('normalizeUrl keeps a non-default port', () => {
  assert.equal(normalizeUrl('https://x.test:8443/a', null), 'https://x.test:8443/a')
})

test('normalizeUrl keeps the query string', () => {
  assert.equal(normalizeUrl('/a?x=1&y=2', 'https://x.test/'), 'https://x.test/a?x=1&y=2')
})

test('normalizeUrl treats /a and /a/ as distinct', () => {
  assert.notEqual(normalizeUrl('/a', 'https://x.test/'), normalizeUrl('/a/', 'https://x.test/'))
})

test('normalizeUrl returns null for non-http(s) schemes', () => {
  assert.equal(normalizeUrl('mailto:hi@x.test', 'https://x.test/'), null)
  assert.equal(normalizeUrl('javascript:void(0)', 'https://x.test/'), null)
  assert.equal(normalizeUrl('tel:+15551234567', 'https://x.test/'), null)
})

test('normalizeUrl returns null for an unresolvable href', () => {
  assert.equal(normalizeUrl('/a', null), null)
})

// --- crawlSite: sitemap union BFS over the small-site fixture ---
//
// The fixture holds 13 HTML pages (the 12 named in the task brief plus /blog/three, added so the
// maxPages=5 scenario below lands on exactly 7 named drops without disturbing the reachability
// depths the brief calls out for /team, /faq and /deep) plus /missing (404), /private (robots-
// disallowed), /robots.txt, /sitemap.xml, and one external page. /blog/three is listed in the
// sitemap alongside /blog/one and /blog/two so it does not read as a second "unlisted" page.

test('crawlSite finds every sitemap page plus what BFS discovers, with correct source', async () => {
  const { net, sitemapUrls, robots } = await loadSmallSite()
  const result = await crawlSite(net, { url: START, robots, sitemapUrls })

  // 13 sitemap-or-linked HTML pages (200, parsed) + /missing (404, not parsed) = 14 fetches.
  assert.equal(result.pages.length, 14)

  const htmlPages = result.pages.filter((p) => p.page !== null)
  assert.equal(htmlPages.length, 13)

  const byUrl = new Map(result.pages.map((p) => [p.url, p]))

  // In the sitemap and linked from a fetched page.
  for (const path of ['/', '/about', '/contact', '/blog/', '/blog/one', '/blog/two', '/blog/three', '/pricing', '/team', '/faq', '/deep']) {
    const p = byUrl.get(new URL(path, START).href)
    assert.ok(p, `expected a page for ${path}`)
    assert.equal(p.source, 'both', `expected source 'both' for ${path}, got ${p.source}`)
    assert.equal(p.status, 200)
    assert.ok(p.page, `expected a parsed Page for ${path}`)
  }

  // In the sitemap, linked from nowhere.
  const orphanPage = byUrl.get('https://small.test/orphan')
  assert.equal(orphanPage.source, 'sitemap')

  // Not in the sitemap, only discovered via a link.
  const unlistedPage = byUrl.get('https://small.test/unlisted')
  assert.equal(unlistedPage.source, 'crawl')

  // Titles come from the parsed page.
  assert.equal(byUrl.get(START).title, 'Small Test Home')
})

test('crawlSite detects the orphan sitemap page and the unlisted crawled page', async () => {
  const { net, sitemapUrls, robots } = await loadSmallSite()
  const result = await crawlSite(net, { url: START, robots, sitemapUrls })

  assert.deepEqual(result.orphans, ['https://small.test/orphan'])
  assert.deepEqual(result.unlisted, ['https://small.test/unlisted'])
})

test('crawlSite collects assets from parsed pages without fetching them', async () => {
  const { net, sitemapUrls, robots } = await loadSmallSite()
  const result = await crawlSite(net, { url: START, robots, sitemapUrls })

  assert.ok(result.assets.images.has('https://small.test/img/a.png'))
  assert.ok(result.assets.scripts.has('https://small.test/app.js'))
  assert.ok(result.assets.styles.has('https://small.test/s.css'))
})

test('crawlSite records the 404 target in pages and in internalLinks with its referrer', async () => {
  const { net, sitemapUrls, robots } = await loadSmallSite()
  const result = await crawlSite(net, { url: START, robots, sitemapUrls })

  const missing = result.pages.find((p) => p.url === 'https://small.test/missing')
  assert.ok(missing)
  assert.equal(missing.status, 404)
  assert.equal(missing.page, null)

  const referrers = result.internalLinks.get('https://small.test/missing')
  assert.deepEqual(referrers, [START])
})

test('crawlSite routes the external link to externalLinks only, never fetching it', async () => {
  const { net, sitemapUrls, robots } = await loadSmallSite()
  const result = await crawlSite(net, { url: START, robots, sitemapUrls })

  const referrers = result.externalLinks.get('https://ext.test/x')
  assert.deepEqual(referrers, [START])
  assert.ok(!result.pages.some((p) => p.url === 'https://ext.test/x'))
  assert.ok(!result.internalLinks.has('https://ext.test/x'))
})

test('crawlSite dedupes a link reached with and without a fragment into one internalLinks entry with both referrers', async () => {
  const { net, sitemapUrls, robots } = await loadSmallSite()
  const result = await crawlSite(net, { url: START, robots, sitemapUrls })

  const referrers = result.internalLinks.get('https://small.test/unlisted')
  assert.deepEqual(
    new Set(referrers),
    new Set(['https://small.test/pricing', 'https://small.test/blog/one']),
  )
  // Only one fetch happened for /unlisted, regardless of two referrers.
  assert.equal(result.pages.filter((p) => p.url === 'https://small.test/unlisted').length, 1)
})

test('robots-disallowed /private is dropped with reason robots, unless ignoreRobots is set', async () => {
  const { net, sitemapUrls, robots } = await loadSmallSite()

  const blocked = await crawlSite(net, { url: START, robots, sitemapUrls })
  assert.ok(!blocked.pages.some((p) => p.url === 'https://small.test/private'))
  assert.deepEqual(
    blocked.dropped.find((d) => d.url === 'https://small.test/private'),
    { url: 'https://small.test/private', reason: 'robots' },
  )

  const allowed = await crawlSite(net, { url: START, robots, sitemapUrls, ignoreRobots: true })
  const privatePage = allowed.pages.find((p) => p.url === 'https://small.test/private')
  assert.ok(privatePage)
  assert.equal(privatePage.status, 200)
  assert.ok(!allowed.dropped.some((d) => d.url === 'https://small.test/private'))
})

test('crawlSite drops exactly 7 named URLs when maxPages is 5 (pure BFS, no sitemap)', async () => {
  const { net, robots } = await loadSmallSite()
  const result = await crawlSite(net, { url: START, robots, sitemapUrls: [], maxPages: 5 })

  assert.equal(result.pages.length, 5)
  assert.equal(result.dropped.length, 7)

  const byUrl = new Map(result.dropped.map((d) => [d.url, d.reason]))
  assert.equal(byUrl.get('https://small.test/missing'), 'max-pages')
  assert.equal(byUrl.get('https://small.test/private'), 'robots')
  assert.equal(byUrl.get('https://small.test/team'), 'max-pages')
  assert.equal(byUrl.get('https://small.test/unlisted'), 'max-pages')
  assert.equal(byUrl.get('https://small.test/blog/one'), 'max-pages')
  assert.equal(byUrl.get('https://small.test/blog/two'), 'max-pages')
  assert.equal(byUrl.get('https://small.test/blog/three'), 'max-pages')

  // Never discovered at all: /faq and /deep sit behind /team, which was never fetched.
  assert.ok(!byUrl.has('https://small.test/faq'))
  assert.ok(!byUrl.has('https://small.test/deep'))
  assert.ok(!result.pages.some((p) => p.url === 'https://small.test/faq'))
})

test('crawlSite names a max-depth drop when maxDepth is capped (pure BFS, no sitemap)', async () => {
  const { net, robots } = await loadSmallSite()
  const result = await crawlSite(net, { url: START, robots, sitemapUrls: [], maxDepth: 3 })

  // /team (depth 2) and /faq (depth 3) are within the cap; /deep (depth 4) is not.
  const team = result.pages.find((p) => p.url === 'https://small.test/team')
  const faq = result.pages.find((p) => p.url === 'https://small.test/faq')
  assert.ok(team && team.depth === 2)
  assert.ok(faq && faq.depth === 3)
  assert.ok(!result.pages.some((p) => p.url === 'https://small.test/deep'))

  assert.deepEqual(
    result.dropped.find((d) => d.url === 'https://small.test/deep'),
    { url: 'https://small.test/deep', reason: 'max-depth' },
  )
})

test('crawlSite returns [] for unlisted when sitemapUrls is empty', async () => {
  const { net, robots } = await loadSmallSite()
  const result = await crawlSite(net, { url: START, robots, sitemapUrls: [] })
  assert.deepEqual(result.unlisted, [])
})

// --- fetch-policy edge cases, via small ad-hoc recorded nets ---

test('crawlSite does not parse a 200 response whose content-type is not text/html', async () => {
  const net = recordedNet({
    'https://x.test/': {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: '<a href="/data.json">data</a>',
    },
    'https://x.test/data.json': {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    },
  })
  const result = await crawlSite(net, { url: 'https://x.test/', sitemapUrls: [] })
  const data = result.pages.find((p) => p.url === 'https://x.test/data.json')
  assert.ok(data)
  assert.equal(data.page, null)
})

test('crawlSite parses a 200 response with no content-type when the body starts with "<"', async () => {
  const net = recordedNet({
    'https://x.test/': { status: 200, headers: {}, body: '<html><body>hi</body></html>' },
  })
  const result = await crawlSite(net, { url: 'https://x.test/', sitemapUrls: [] })
  const home = result.pages.find((p) => p.url === 'https://x.test/')
  assert.ok(home.page !== null)
})

test('crawlSite ignores non-http(s) links entirely (not internal, not external)', async () => {
  const net = recordedNet({
    'https://x.test/': {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: '<a href="mailto:hi@x.test">mail</a><a href="javascript:void(0)">js</a>',
    },
  })
  const result = await crawlSite(net, { url: 'https://x.test/', sitemapUrls: [] })
  assert.equal(result.internalLinks.size, 0)
  assert.equal(result.externalLinks.size, 0)
  assert.equal(result.pages.length, 1)
})

// --- fix round 1 ---

test('off-origin sitemap URLs are never fetched, dropped once as off-origin, and excluded from orphans', async () => {
  const calls = []
  const net = {
    async get(url) {
      calls.push(url)
      if (url === 'https://a.test/') {
        return {
          url, finalUrl: url, status: 200, ok: true, headers: { 'content-type': 'text/html' },
          body: '<html><body>home</body></html>', bodyBytes: null, chain: [], error: null,
          timedOut: false, bytes: 30, truncated: false,
        }
      }
      return {
        url, finalUrl: url, status: 0, ok: false, headers: {}, body: null, bodyBytes: null,
        chain: [], error: 'not recorded', timedOut: false, bytes: 0, truncated: false,
      }
    },
    async map(items, fn) {
      return Promise.all(items.map(fn))
    },
  }

  const result = await crawlSite(net, {
    url: 'https://a.test/',
    sitemapUrls: ['https://other.test/page'],
  })

  assert.ok(!result.pages.some((p) => p.url === 'https://other.test/page'))
  assert.deepEqual(
    result.dropped.find((d) => d.url === 'https://other.test/page'),
    { url: 'https://other.test/page', reason: 'off-origin' },
  )
  assert.deepEqual(result.orphans, [])
  assert.ok(!calls.includes('https://other.test/page'))
})

test('recordedNet honors a fixture-provided finalUrl/chain, and links resolve against finalUrl', async () => {
  const net = recordedNet({
    'https://s.test/old': {
      status: 200,
      finalUrl: 'https://s.test/new',
      chain: [{ url: 'https://s.test/old', status: 301, location: '/new' }],
      headers: { 'content-type': 'text/html' },
      body: '<a href="/x">x</a>',
    },
    'https://s.test/new': {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: '<html><body>new</body></html>',
    },
  })

  const result = await crawlSite(net, { url: 'https://s.test/old', sitemapUrls: [] })

  const redirected = result.pages.filter((p) => p.finalUrl === 'https://s.test/new')
  assert.equal(redirected.length, 1)
  assert.equal(redirected[0].url, 'https://s.test/old')
  assert.deepEqual(redirected[0].response.chain, [
    { url: 'https://s.test/old', status: 301, location: '/new' },
  ])

  // The link on the redirected page was resolved against its finalUrl, not the requested url.
  assert.ok(result.internalLinks.has('https://s.test/x'))
})
