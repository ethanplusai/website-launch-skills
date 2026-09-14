import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNet } from '../skills/launch-audit/scripts/lib/net.mjs'

function fakeFetch(routes) {
  return async (url, opts) => {
    const r = routes[url]; if (!r) return new Response('nf', { status: 404 })
    if (r.hang) return new Promise(() => {})
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: r.headers ?? {} })
  }
}

test('follows a redirect chain hop by hop and records it', async () => {
  const net = createNet({ fetchImpl: fakeFetch({ 'http://a.test/': { status: 301, headers: { location: 'https://a.test/' } }, 'https://a.test/': { status: 301, headers: { location: 'https://www.a.test/' } }, 'https://www.a.test/': { status: 200, body: 'hi' } }) })
  const r = await net.get('http://a.test/')
  assert.equal(r.status, 200); assert.equal(r.finalUrl, 'https://www.a.test/'); assert.equal(r.chain.length, 2); assert.equal(r.chain[0].status, 301); assert.equal(r.body, 'hi')
})
test('a redirect loop stops at maxHops with an error', async () => {
  const net = createNet({ fetchImpl: fakeFetch({ 'https://l.test/a': { status: 302, headers: { location: '/b' } }, 'https://l.test/b': { status: 302, headers: { location: '/a' } } }) })
  const r = await net.get('https://l.test/a', { maxHops: 5 })
  assert.equal(r.status, 0); assert.match(r.error, /redirect loop|too many redirects/); assert.equal(r.chain.length, 5)
})
test('relative Location headers resolve against the hop url', async () => {
  const net = createNet({ fetchImpl: fakeFetch({ 'https://r.test/old': { status: 301, headers: { location: '/new' } }, 'https://r.test/new': { status: 200 } }) })
  assert.equal((await net.get('https://r.test/old')).finalUrl, 'https://r.test/new')
})
test('a hanging request times out and returns status 0 with timedOut', async () => {
  const net = createNet({ fetchImpl: fakeFetch({ 'https://h.test/': { hang: true } }), timeoutMs: 20 })
  const r = await net.get('https://h.test/'); assert.equal(r.status, 0); assert.equal(r.timedOut, true)
})
test('map bounds concurrency and preserves order', async () => {
  const net = createNet({ fetchImpl: fakeFetch({}), concurrency: 2 })
  let active = 0, peak = 0
  const out = await net.map([1, 2, 3, 4, 5], async (n) => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; return n * 2 })
  assert.deepEqual(out, [2, 4, 6, 8, 10]); assert.equal(peak, 2)
})
test('cert reports days left and SAN coverage via injected tls', async () => {
  const fakeTls = (opts, cb) => { const sock = { getPeerCertificate: () => ({ subject: { CN: 'a.test' }, subjectaltname: 'DNS:a.test, DNS:www.a.test', issuer: { O: 'Fake CA' }, valid_from: 'Jan 1 00:00:00 2026 GMT', valid_to: 'Dec 31 00:00:00 2027 GMT' }), authorized: true, end() {}, on() {} }; setTimeout(cb, 0); return sock }
  const net = createNet({ tlsConnect: fakeTls })
  const c = await net.cert('a.test'); assert.equal(c.valid, true); assert.deepEqual(c.altNames, ['a.test', 'www.a.test']); assert.ok(c.daysLeft > 300)
})
test('headers are lowercased and the user agent is sent', async () => {
  let seenUa; const net = createNet({ fetchImpl: async (u, o) => { seenUa = o.headers['user-agent']; return new Response('', { status: 200, headers: { 'X-Robots-Tag': 'noindex' } }) } })
  const r = await net.get('https://u.test/'); assert.equal(r.headers['x-robots-tag'], 'noindex'); assert.match(seenUa, /website-launch-skill/)
})

// Ruling 1: non-text content types return bodyBytes (Uint8Array), body: null
test('non-text content types return bodyBytes and null body', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4])
  const net = createNet({ fetchImpl: async () => new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } }) })
  const r = await net.get('https://img.test/')
  assert.equal(r.body, null)
  assert.ok(r.bodyBytes instanceof Uint8Array)
  assert.equal(r.bodyBytes.length, 4)
  assert.equal(r.bytes, 4)
})

// Ruling 2: maxBytes truncates the read body
test('maxBytes truncates a long body and sets truncated: true', async () => {
  const net = createNet({ fetchImpl: async () => new Response('0123456789', { status: 200, headers: { 'content-type': 'text/plain' } }) })
  const r = await net.get('https://big.test/', { maxBytes: 4 })
  assert.equal(r.truncated, true)
  assert.equal(r.bytes, 4)
})

// Ruling 3: head() falls back to GET on 405 or 501
test('head() falls back to GET on 405', async () => {
  const net = createNet({ fetchImpl: async (url, opts) => {
    if (opts.method === 'HEAD') return new Response('', { status: 405 })
    return new Response('got-it', { status: 200 })
  } })
  const r = await net.head('https://h405.test/')
  assert.equal(r.status, 200); assert.equal(r.body, 'got-it')
})
test('head() falls back to GET on 501', async () => {
  const net = createNet({ fetchImpl: async (url, opts) => {
    if (opts.method === 'HEAD') return new Response('', { status: 501 })
    return new Response('got-it-2', { status: 200 })
  } })
  const r = await net.head('https://h501.test/')
  assert.equal(r.status, 200); assert.equal(r.body, 'got-it-2')
})
