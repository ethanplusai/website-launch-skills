import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFixture } from './helpers.mjs'
import { parseSitemap, expandSitemap, discoverSitemaps } from '../skills/launch-audit/scripts/lib/sitemap.mjs'
import { parseRobots } from '../skills/launch-audit/scripts/lib/robots.mjs'

const load = (name) => readFixture(`sitemaps/${name}`)

function fakeNet(routes) {
  return {
    get: async (url) => {
      const r = routes[url]
      if (!r) return { url, finalUrl: url, status: 404, ok: false, headers: {}, body: null, error: null }
      return { url, finalUrl: url, status: r.status ?? 200, ok: (r.status ?? 200) === 200, headers: {}, body: r.body ?? null, error: r.error ?? null }
    },
    map: async (items, fn) => Promise.all(items.map(fn)),
  }
}

// --- parseSitemap ---

test('parseSitemap parses a urlset with 3 urls and lastmod', () => {
  const parsed = parseSitemap(load('plain.xml'))
  assert.equal(parsed.kind, 'urlset')
  assert.equal(parsed.entries.length, 3)
  assert.equal(parsed.entries[0].loc, 'https://example.com/')
  assert.equal(parsed.entries[0].lastmod, '2026-01-01')
  assert.equal(parsed.entries[1].lastmod, '2026-01-02')
})

test('parseSitemap decodes XML entities in <loc>', () => {
  const parsed = parseSitemap(load('plain.xml'))
  assert.equal(parsed.entries[2].loc, 'https://example.com/contact?ref=footer&utm=1')
})

test('parseSitemap parses a sitemapindex; lastmod is null when absent', () => {
  const parsed = parseSitemap(load('index.xml'))
  assert.equal(parsed.kind, 'index')
  assert.equal(parsed.entries.length, 2)
  assert.equal(parsed.entries[0].loc, 'https://example.com/child-a.xml')
  assert.equal(parsed.entries[0].lastmod, '2026-01-01')
  assert.equal(parsed.entries[1].loc, 'https://example.com/child-b.xml')
  assert.equal(parsed.entries[1].lastmod, null)
})

test('parseSitemap reports bad.xml as invalid with an error string', () => {
  const parsed = parseSitemap(load('bad.xml'))
  assert.equal(parsed.kind, 'invalid')
  assert.deepEqual(parsed.entries, [])
  assert.equal(typeof parsed.error, 'string')
  assert.ok(parsed.error.length > 0)
})

test('parseSitemap recognizes wp-sitemap.xml as an index', () => {
  const parsed = parseSitemap(load('wp-sitemap.xml'))
  assert.equal(parsed.kind, 'index')
  assert.equal(parsed.entries.length, 1)
})

// --- expandSitemap ---

test('expandSitemap on a plain urlset returns its urls tagged with from', async () => {
  const net = fakeNet({ 'https://example.com/plain.xml': { body: load('plain.xml') } })
  const result = await expandSitemap(net, 'https://example.com/plain.xml')
  assert.equal(result.urls.length, 3)
  assert.ok(result.urls.every((u) => u.from === 'https://example.com/plain.xml'))
  assert.equal(result.failedClosed, false)
  assert.deepEqual(result.errors, [])
})

test('expandSitemap follows an index one level and merges child urls', async () => {
  const net = fakeNet({
    'https://example.com/index.xml': { body: load('index.xml') },
    'https://example.com/child-a.xml': { body: load('child-a.xml') },
    'https://example.com/child-b.xml': { body: load('child-b.xml') },
  })
  const result = await expandSitemap(net, 'https://example.com/index.xml')
  assert.equal(result.urls.length, 3)
  assert.equal(result.failedClosed, false)
  assert.deepEqual(result.errors, [])
  assert.equal(result.children.length, 2)
  assert.ok(result.children.every((c) => c.ok === true))
  const fromA = result.urls.filter((u) => u.from === 'https://example.com/child-a.xml')
  const fromB = result.urls.filter((u) => u.from === 'https://example.com/child-b.xml')
  assert.equal(fromA.length, 2)
  assert.equal(fromB.length, 1)
})

test('expandSitemap fails closed when a child sitemap 500s', async () => {
  const net = fakeNet({
    'https://example.com/index.xml': { body: load('index.xml') },
    'https://example.com/child-a.xml': { body: load('child-a.xml') },
    'https://example.com/child-b.xml': { status: 500 },
  })
  const result = await expandSitemap(net, 'https://example.com/index.xml')
  assert.equal(result.failedClosed, true)
  assert.equal(result.urls.length, 2) // only child-a's urls made it in
  assert.ok(result.errors.some((e) => e.includes('child-b.xml') && e.includes('status 500')))
  const bChild = result.children.find((c) => c.url === 'https://example.com/child-b.xml')
  assert.equal(bChild.ok, false)
})

test('expandSitemap fails closed and reports invalid XML from a child', async () => {
  const net = fakeNet({
    'https://example.com/index.xml': { body: load('index.xml') },
    'https://example.com/child-a.xml': { body: load('bad.xml') },
    'https://example.com/child-b.xml': { body: load('child-b.xml') },
  })
  const result = await expandSitemap(net, 'https://example.com/index.xml')
  assert.equal(result.failedClosed, true)
  assert.ok(result.errors.some((e) => e.startsWith('https://example.com/child-a.xml:')))
  assert.equal(result.urls.length, 1) // only child-b's url
})

test('expandSitemap records a nested index as an error instead of recursing', async () => {
  const net = fakeNet({
    'https://example.com/index.xml': { body: load('index.xml') },
    'https://example.com/child-a.xml': { body: load('wp-sitemap.xml') }, // itself an index
    'https://example.com/child-b.xml': { body: load('child-b.xml') },
  })
  const result = await expandSitemap(net, 'https://example.com/index.xml')
  assert.equal(result.failedClosed, true)
  assert.ok(result.errors.includes('nested index not expanded'))
  assert.equal(result.urls.length, 1) // only child-b's url; child-a's nested index isn't expanded
})

test('expandSitemap fails closed when the top-level sitemap itself is invalid', async () => {
  const net = fakeNet({ 'https://example.com/bad.xml': { body: load('bad.xml') } })
  const result = await expandSitemap(net, 'https://example.com/bad.xml')
  assert.deepEqual(result.urls, [])
  assert.deepEqual(result.children, [])
  assert.equal(result.failedClosed, true)
  assert.equal(result.errors.length, 1)
  assert.ok(result.errors[0].startsWith('https://example.com/bad.xml:'))
})

test('expandSitemap fails closed when the top-level fetch 404s', async () => {
  const net = fakeNet({})
  const result = await expandSitemap(net, 'https://example.com/missing.xml')
  assert.deepEqual(result.urls, [])
  assert.equal(result.failedClosed, true)
  assert.ok(result.errors[0].includes('status 404'))
})

// --- discoverSitemaps ---

test('discoverSitemaps tries robots Sitemap: lines first', async () => {
  const robots = parseRobots('User-agent: *\nDisallow:\nSitemap: https://example.com/plain.xml\n')
  const net = fakeNet({ 'https://example.com/plain.xml': { body: load('plain.xml') } })
  const result = await discoverSitemaps(net, 'https://example.com', robots)
  assert.equal(result.candidates[0], 'https://example.com/plain.xml')
  assert.deepEqual(result.found, [{ url: 'https://example.com/plain.xml', status: 200, kind: 'urlset' }])
})

test('discoverSitemaps dedupes repeated robots Sitemap: lines', async () => {
  const robots = parseRobots(
    'User-agent: *\nDisallow:\nSitemap: https://example.com/plain.xml\nSitemap: https://example.com/plain.xml\n'
  )
  const net = fakeNet({ 'https://example.com/plain.xml': { body: load('plain.xml') } })
  const result = await discoverSitemaps(net, 'https://example.com', robots)
  assert.equal(result.candidates.filter((c) => c === 'https://example.com/plain.xml').length, 1)
})

test('discoverSitemaps falls through conventional paths to find wp-sitemap.xml when sitemap.xml 404s', async () => {
  const robots = parseRobots('User-agent: *\nDisallow:\n')
  const net = fakeNet({
    'https://example.com/wp-sitemap.xml': { body: load('wp-sitemap.xml') },
  })
  const result = await discoverSitemaps(net, 'https://example.com', robots)
  assert.deepEqual(result.candidates, [
    'https://example.com/sitemap.xml',
    'https://example.com/sitemap_index.xml',
    'https://example.com/sitemap-index.xml',
    'https://example.com/wp-sitemap.xml',
  ])
  assert.deepEqual(result.found, [{ url: 'https://example.com/wp-sitemap.xml', status: 200, kind: 'index' }])
})

test('discoverSitemaps stops after the first found conventional path when robots gave none', async () => {
  const robots = parseRobots('User-agent: *\nDisallow:\n')
  const calls = []
  const baseNet = fakeNet({ 'https://example.com/sitemap.xml': { body: load('plain.xml') } })
  const net = { ...baseNet, get: async (url) => { calls.push(url); return baseNet.get(url) } }
  const result = await discoverSitemaps(net, 'https://example.com', robots)
  assert.deepEqual(calls, ['https://example.com/sitemap.xml'])
  assert.deepEqual(result.candidates, ['https://example.com/sitemap.xml'])
  assert.deepEqual(result.found, [{ url: 'https://example.com/sitemap.xml', status: 200, kind: 'urlset' }])
})

test('discoverSitemaps does not stop early when robots already provided a sitemap', async () => {
  const robots = parseRobots('User-agent: *\nDisallow:\nSitemap: https://example.com/plain.xml\n')
  const calls = []
  const baseNet = fakeNet({
    'https://example.com/plain.xml': { body: load('plain.xml') },
    'https://example.com/wp-sitemap.xml': { body: load('wp-sitemap.xml') },
  })
  const net = { ...baseNet, get: async (url) => { calls.push(url); return baseNet.get(url) } }
  const result = await discoverSitemaps(net, 'https://example.com', robots)
  // all 4 conventional candidates are still tried even though robots already gave one
  assert.equal(calls.length, 5)
  assert.equal(result.found.length, 2)
})

test('discoverSitemaps returns no found entries when nothing 200s or parses', async () => {
  const robots = parseRobots('User-agent: *\nDisallow:\n')
  const net = fakeNet({})
  const result = await discoverSitemaps(net, 'https://example.com', robots)
  assert.deepEqual(result.found, [])
  assert.equal(result.candidates.length, 4)
})
