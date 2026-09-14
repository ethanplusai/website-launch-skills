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
    hasWwwCounterpart: true,
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

test('buildAuditContext never invents a www counterpart for a subdomain target', async () => {
  const net = recordedNet({
    'https://app.example.test/': { status: 200, headers: { 'content-type': 'text/html' }, body: '<html><head><title>App</title></head><body>app</body></html>' },
  })
  const asked = []
  const get = net.get
  net.get = (url) => { asked.push(url); return get(url) }
  net.head = (url) => net.get(url)
  net.cert = async () => ({ valid: true, altNames: ['app.example.test'], daysLeft: 90, error: null })
  const ctx = await buildAuditContext(net, createDns({}), { url: 'https://app.example.test/', random: () => 'deadbeef' })
  assert.equal(ctx.target.hasWwwCounterpart, false)
  assert.equal(ctx.probes.wwwRoot, null)
  assert.deepEqual(asked.filter((url) => url.includes('www.')), [])
  assert.equal(ctx.probes.apexRoot.url, 'https://app.example.test/')
})

test('buildAuditContext still probes www for a host under a two-label public suffix', async () => {
  const net = recordedNet({
    'https://example.co.uk/': { status: 200, headers: { 'content-type': 'text/html' }, body: '<html><head><title>UK</title></head><body>uk</body></html>' },
  })
  const asked = []
  const get = net.get
  net.get = (url) => { asked.push(url); return get(url) }
  net.head = (url) => net.get(url)
  net.cert = async () => ({ valid: true, altNames: ['example.co.uk'], daysLeft: 90, error: null })
  const ctx = await buildAuditContext(net, createDns({}), { url: 'https://example.co.uk/', random: () => 'deadbeef' })
  assert.equal(ctx.target.hasWwwCounterpart, true)
  assert.equal(ctx.probes.wwwRoot.url, 'https://www.example.co.uk/')
  assert.ok(asked.includes('https://www.example.co.uk/'))
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

test('buildAuditContext fetches the head assets every crawled page points at, once each', async () => {
  const head = `
    <link rel="icon" href="/favicon.ico">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png">
    <link rel="manifest" href="/site.webmanifest">
    <meta property="og:image" content="/og.png">
    <meta property="og:image:secure_url" content="https://cdn.test/og.png">
    <link rel="stylesheet" href="/s.css">`
  const page = (title, body) => ({
    status: 200,
    headers: { 'content-type': 'text/html' },
    body: `<!doctype html><html lang="en"><head><title>${title}</title>${head}</head><body>${body}</body></html>`,
  })
  const asset = (type) => ({ status: 200, headers: { 'content-type': type } })
  const net = recordedNet({
    'https://icons.test/': page('Home', '<a href="/about">About</a>'),
    'https://icons.test/about': page('About', 'about'),
    'https://icons.test/favicon.ico': asset('image/x-icon'),
    'https://icons.test/apple-touch-icon.png': asset('image/png'),
    'https://icons.test/site.webmanifest': asset('application/manifest+json'),
    'https://icons.test/og.png': asset('image/png'),
    'https://cdn.test/og.png': asset('image/png'),
  })
  const asked = []
  const get = net.get
  net.get = (url) => { asked.push(url); return get(url) }
  net.head = (url) => net.get(url)
  net.cert = async () => ({ valid: true, altNames: ['icons.test'], daysLeft: 90, error: null })
  const ctx = await buildAuditContext(net, createDns({}), { url: 'https://icons.test/', random: () => 'deadbeef' })

  assert.deepEqual([...ctx.probes.headAssets.keys()].sort(), [
    'https://cdn.test/og.png',
    'https://icons.test/apple-touch-icon.png',
    'https://icons.test/favicon.ico',
    'https://icons.test/og.png',
    'https://icons.test/site.webmanifest',
  ])
  assert.equal(ctx.probes.headAssets.get('https://icons.test/og.png').status, 200)
  // Two pages declare the same five assets, and each is fetched once. A stylesheet is not a head
  // asset — the static-asset sampler owns that url, so it is absent from this map.
  assert.equal(asked.filter((url) => url === 'https://icons.test/favicon.ico').length, 1)
  assert.equal(ctx.probes.headAssets.has('https://icons.test/s.css'), false)
})

test('buildAuditContext records a head asset that does not answer rather than dropping it', async () => {
  const net = recordedNet({
    'https://icons.test/': {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: '<!doctype html><html><head><title>Home</title><link rel="icon" href="/favicon.ico"></head><body>hi</body></html>',
    },
  })
  net.head = (url) => net.get(url)
  net.cert = async () => ({ valid: true, altNames: [], daysLeft: 90, error: null })
  const ctx = await buildAuditContext(net, createDns({}), { url: 'https://icons.test/', random: () => 'deadbeef' })
  assert.equal(ctx.probes.headAssets.get('https://icons.test/favicon.ico').status, 0)
})

// ------------------------------------------------------------------ link, image and embed probes
// Everything a check in the links, images or forms dimension needs a response for is fetched here,
// once, deduped and capped, so those checks stay pure over the context.

const htmlPage = (body) => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: `<!doctype html><html lang="en"><head><title>A page title</title></head><body>${body}</body></html>`,
})
const ok = (type) => ({ status: 200, headers: { 'content-type': type } })

async function probeCtx(fixture, url = 'https://probe.test/') {
  const net = recordedNet(fixture)
  const asked = []
  const get = net.get
  net.get = (u) => { asked.push(`GET ${u}`); return get(u) }
  net.head = (u) => { asked.push(`HEAD ${u}`); return get(u) }
  net.cert = async () => ({ valid: true, altNames: ['probe.test'], daysLeft: 90, error: null })
  const ctx = await buildAuditContext(net, createDns({}), { url, random: () => 'deadbeef' })
  return { ctx, asked }
}

test('buildAuditContext probes every off-origin link once, with HEAD', async () => {
  const { ctx, asked } = await probeCtx({
    'https://probe.test/': htmlPage('<a href="/two">Two</a> <a href="https://out.test/a">A</a> <a href="mailto:x@y.test">Mail</a>'),
    'https://probe.test/two': htmlPage('<a href="https://out.test/a">A again</a> <a href="https://out.test/b">B</a>'),
    'https://out.test/a': ok('text/html'),
    'https://out.test/b': { status: 404, headers: {} },
  })
  assert.deepEqual([...ctx.probes.externals.keys()].sort(), ['https://out.test/a', 'https://out.test/b'])
  assert.equal(ctx.probes.externals.get('https://out.test/b').status, 404)
  assert.equal(asked.filter((a) => a === 'HEAD https://out.test/a').length, 1)
  assert.equal(asked.filter((a) => a.endsWith('mailto:x@y.test')).length, 0)
})

test('buildAuditContext probes every image and srcset candidate once, with GET', async () => {
  const { ctx, asked } = await probeCtx({
    'https://probe.test/': htmlPage(
      '<img src="/a.png" alt="A" srcset="/a.png 1x, /a@2x.png 2x"><img src="https://cdn.test/b.jpg" alt="B"><a href="/two">Two</a>',
    ),
    'https://probe.test/two': htmlPage('<img src="/a.png" alt="A again">'),
    'https://probe.test/a.png': ok('image/png'),
    'https://probe.test/a@2x.png': ok('image/png'),
    'https://cdn.test/b.jpg': ok('image/jpeg'),
  })
  assert.deepEqual([...ctx.probes.images.keys()].sort(), [
    'https://cdn.test/b.jpg',
    'https://probe.test/a.png',
    'https://probe.test/a@2x.png',
  ])
  assert.equal(asked.filter((a) => a === 'GET https://probe.test/a.png').length, 1)
})

test('buildAuditContext probes form embeds: anything inside a form, and known form hosts anywhere', async () => {
  const { ctx } = await probeCtx({
    'https://probe.test/': htmlPage(
      '<form action="/x"><iframe src="https://embed.test/frame" title="F"></iframe></form>' +
      '<script src="https://js.hsforms.net/forms/embed/v2.js"></script>' +
      '<script src="/app.js"></script><iframe src="https://video.test/v"></iframe>',
    ),
    'https://embed.test/frame': ok('text/html'),
    'https://js.hsforms.net/forms/embed/v2.js': { status: 404, headers: {} },
  })
  assert.deepEqual([...ctx.probes.embeds.keys()].sort(), [
    'https://embed.test/frame',
    'https://js.hsforms.net/forms/embed/v2.js',
  ])
  assert.equal(ctx.probes.embeds.get('https://js.hsforms.net/forms/embed/v2.js').status, 404)
})

test('buildAuditContext records every probe cap, and what each one dropped', async () => {
  const { ctx } = await probeCtx({ 'https://probe.test/': htmlPage('<p>Nothing to probe.</p>') })
  assert.deepEqual(ctx.probes.caps, {
    externals: { cap: 200, dropped: 0 },
    images: { cap: 300, dropped: 0 },
    embeds: { cap: 50, dropped: 0 },
    headAssets: { cap: 100, dropped: 0 },
  })
})

test('a probe set past its cap drops the overflow and says how much it dropped', async () => {
  const links = Array.from({ length: 205 }, (_, i) => `<a href="https://out.test/${i}">L${i}</a>`).join('')
  const fixture = { 'https://probe.test/': htmlPage(links) }
  for (let i = 0; i < 205; i++) fixture[`https://out.test/${i}`] = ok('text/html')
  const { ctx } = await probeCtx(fixture)
  assert.equal(ctx.probes.externals.size, 200)
  assert.equal(ctx.probes.caps.externals.dropped, 5)
})
