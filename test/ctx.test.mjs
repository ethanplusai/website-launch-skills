import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFixture, recordedNet } from './helpers.mjs'
import { buildCtxFromFixture, NOW } from './checks-helpers.mjs'
import { buildAuditContext } from '../skills/launch-audit/scripts/lib/checks/_ctx.mjs'
import { createDns } from '../skills/launch-audit/scripts/lib/dns.mjs'

test('buildAuditContext describes the target host, its apex and its www counterpart', async () => {
  const ctx = await buildCtxFromFixture('recorded/https-site.json', { url: 'https://good.test/', devHosts: ['old.internal'] })
  assert.deepEqual(ctx.target, {
    url: 'https://good.test/',
    origin: 'https://good.test',
    host: 'good.test',
    apex: 'good.test',
    www: 'www.good.test',
    staging: false,
    devHosts: ['old.internal'],
  })
  assert.equal(ctx.now.toISOString(), NOW)
  assert.equal(typeof ctx.dns.spf, 'function')
  assert.equal(typeof ctx.net.get, 'function')
  assert.equal(ctx.options.url, 'https://good.test/')
})

test('buildAuditContext treats a www start host as the same site', async () => {
  const ctx = await buildCtxFromFixture('recorded/https-site.json', { url: 'https://www.good.test/' })
  assert.equal(ctx.target.host, 'www.good.test')
  assert.equal(ctx.target.apex, 'good.test')
  assert.equal(ctx.target.www, 'www.good.test')
})

test('buildAuditContext fetches and parses robots.txt', async () => {
  const ctx = await buildCtxFromFixture('recorded/https-site.json', { url: 'https://good.test/' })
  assert.equal(ctx.robots.url, 'https://good.test/robots.txt')
  assert.equal(ctx.robots.status, 200)
  assert.match(ctx.robots.text, /Sitemap:/)
  assert.deepEqual(ctx.robots.parsed.sitemaps, ['https://good.test/sitemap.xml'])
})

test('buildAuditContext leaves robots.parsed null when robots.txt does not 200', async () => {
  const ctx = await buildCtxFromFixture('recorded/http-only-site.json', { url: 'http://plain.test/' })
  assert.equal(ctx.robots.status, 503)
  assert.equal(ctx.robots.text, null)
  assert.equal(ctx.robots.parsed, null)
})

test('buildAuditContext discovers and expands the first sitemap it finds', async () => {
  const ctx = await buildCtxFromFixture('recorded/sitemap-site.json', { url: 'https://sm.test/' })
  assert.ok(ctx.sitemaps.candidates.includes('https://sm.test/sitemap.xml'))
  assert.equal(ctx.sitemaps.found[0].url, 'https://sm.test/sitemap.xml')
  assert.equal(ctx.sitemaps.found[0].kind, 'index')
  assert.equal(ctx.sitemaps.expanded.failedClosed, true)
  assert.ok(ctx.sitemaps.urls.includes('https://sm.test/gone'))
  assert.ok(ctx.sitemaps.urls.includes('https://other.test/page'))
})

test('buildAuditContext reports an empty sitemap set when there is none', async () => {
  const ctx = await buildCtxFromFixture('recorded/noindex-site.json', { url: 'https://noindex.test/' })
  assert.deepEqual(ctx.sitemaps.found, [])
  assert.deepEqual(ctx.sitemaps.urls, [])
  assert.equal(ctx.sitemaps.expanded.failedClosed, false)
})

test('buildAuditContext crawls the site with the sitemap union', async () => {
  const ctx = await buildCtxFromFixture('recorded/https-site.json', { url: 'https://good.test/' })
  const urls = ctx.crawl.pages.map((p) => p.url).sort()
  assert.deepEqual(urls, ['https://good.test/', 'https://good.test/about', 'https://good.test/fr'])
  assert.equal(ctx.crawl.pages[0].page.head.title, 'Good Site')
})

test('buildAuditContext honours maxPages and maxDepth', async () => {
  const ctx = await buildCtxFromFixture('recorded/https-site.json', { url: 'https://good.test/', maxPages: 1, maxDepth: 0 })
  assert.equal(ctx.crawl.pages.length, 1)
  assert.ok(ctx.crawl.dropped.length > 0)
})

test('buildAuditContext probes both root schemes and both host variants', async () => {
  const ctx = await buildCtxFromFixture('recorded/https-site.json', { url: 'https://good.test/' })
  assert.equal(ctx.probes.httpRoot.url, 'http://good.test/')
  assert.equal(ctx.probes.httpsRoot.url, 'https://good.test/')
  assert.equal(ctx.probes.wwwRoot.url, 'https://www.good.test/')
  assert.equal(ctx.probes.apexRoot.url, 'https://good.test/')
  assert.equal(ctx.probes.wwwRoot.chain.length, 1)
  assert.equal(ctx.probes.slashVariant, null)
})

test('buildAuditContext probes the trailing-slash variant of a non-root start path', async () => {
  const ctx = await buildCtxFromFixture('recorded/split-host-site.json', { url: 'https://split.test/about' })
  assert.equal(ctx.probes.slashVariant.url, 'https://split.test/about/')
  assert.equal(ctx.probes.slashVariant.status, 200)
})

test('buildAuditContext probes a random 404 path and llms.txt', async () => {
  const ctx = await buildCtxFromFixture('recorded/https-site.json', { url: 'https://good.test/' })
  assert.equal(ctx.probes.notFound.url, 'https://good.test/this-page-should-not-exist-deadbeef')
  assert.equal(ctx.probes.notFound.response.status, 404)
  assert.equal(ctx.probes.llmsTxt.url, 'https://good.test/llms.txt')
  assert.equal(ctx.probes.llmsTxt.status, 200)
})

test('buildAuditContext samples static assets found by the crawl', async () => {
  const ctx = await buildCtxFromFixture('recorded/https-site.json', { url: 'https://good.test/' })
  const urls = ctx.probes.assets.map((a) => a.url)
  assert.ok(urls.includes('https://good.test/s.css'))
  assert.ok(urls.includes('https://good.test/app.js'))
  assert.equal(ctx.probes.assets[0].response.status, 200)
})

test('buildAuditContext reads the certificate for the target host', async () => {
  const ctx = await buildCtxFromFixture('recorded/https-site.json', {
    url: 'https://good.test/',
    cert: { valid: false, subject: null, altNames: [], issuer: null, validFrom: null, validTo: null, daysLeft: null, error: 'self signed' },
  })
  assert.equal(ctx.cert.valid, false)
  assert.equal(ctx.cert.error, 'self signed')
})

test('buildAuditContext carries the staging flag through', async () => {
  const ctx = await buildCtxFromFixture('recorded/noindex-site.json', { url: 'https://noindex.test/', staging: true })
  assert.equal(ctx.target.staging, true)
})

test('every probe goes through net, and the 404 path comes from the injected random', async () => {
  const fixture = JSON.parse(readFixture('recorded/https-site.json'))
  const net = recordedNet(fixture)
  const asked = []
  const get = net.get
  net.get = (url) => { asked.push(url); return get(url) }
  net.head = (url) => net.get(url)
  let certHost = null
  net.cert = async (host) => { certHost = host; return { valid: true, altNames: ['good.test'], daysLeft: 90, error: null } }
  const ctx = await buildAuditContext(net, createDns({}), { url: 'https://good.test/', random: () => 'cafe1234' })
  assert.equal(certHost, 'good.test')
  assert.equal(ctx.probes.notFound.url, 'https://good.test/this-page-should-not-exist-cafe1234')
  for (const url of [
    'https://good.test/robots.txt',
    'https://good.test/sitemap.xml',
    'https://good.test/',
    'http://good.test/',
    'https://www.good.test/',
    'https://good.test/this-page-should-not-exist-cafe1234',
    'https://good.test/llms.txt',
  ]) assert.ok(asked.includes(url), `expected a request for ${url}`)
})

test('buildAuditContext defaults the 404 suffix to real randomness', async () => {
  const fixture = JSON.parse(readFixture('recorded/https-site.json'))
  const net = recordedNet(fixture)
  net.head = (url) => net.get(url)
  net.cert = async () => ({ valid: true, altNames: [], daysLeft: 90, error: null })
  const ctx = await buildAuditContext(net, createDns({}), { url: 'https://good.test/' })
  assert.match(ctx.probes.notFound.url, /^https:\/\/good\.test\/this-page-should-not-exist-[0-9a-f]{8,}$/)
})
