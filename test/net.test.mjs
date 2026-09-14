import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNet, USER_AGENT } from '../skills/launch-audit/scripts/lib/net.mjs'

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
test('a redirect loop is detected by URL repeat and stops immediately', async () => {
  const net = createNet({ fetchImpl: fakeFetch({ 'https://l.test/a': { status: 302, headers: { location: '/b' } }, 'https://l.test/b': { status: 302, headers: { location: '/a' } } }) })
  const r = await net.get('https://l.test/a', { maxHops: 5 })
  assert.equal(r.status, 0); assert.match(r.error, /redirect loop/); assert.equal(r.chain.length, 2)
})
test('six distinct hops with no repeat exceeds maxHops with "too many redirects"', async () => {
  const net = createNet({ fetchImpl: fakeFetch({
    'https://m.test/1': { status: 302, headers: { location: '/2' } },
    'https://m.test/2': { status: 302, headers: { location: '/3' } },
    'https://m.test/3': { status: 302, headers: { location: '/4' } },
    'https://m.test/4': { status: 302, headers: { location: '/5' } },
    'https://m.test/5': { status: 302, headers: { location: '/6' } },
    'https://m.test/6': { status: 302, headers: { location: '/7' } },
    'https://m.test/7': { status: 200 },
  }) })
  const r = await net.get('https://m.test/1', { maxHops: 5 })
  assert.equal(r.status, 0); assert.match(r.error, /too many redirects/); assert.equal(r.chain.length, 5)
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
// The user agent is the one string a site owner sees in their logs, and it is how they find the
// project that fetched them. It names the repository, so it has to name the repository that
// exists — a rename that leaves this behind points every log reader at a 404.
test('the user agent names the tool, its version and the repository it comes from', () => {
  assert.equal(USER_AGENT, 'website-launch-skills/0.1 (+https://github.com/ethanplusai/website-launch-skills)')
})

test('headers are lowercased and the user agent is sent', async () => {
  let seenUa; const net = createNet({ fetchImpl: async (u, o) => { seenUa = o.headers['user-agent']; return new Response('', { status: 200, headers: { 'X-Robots-Tag': 'noindex' } }) } })
  const r = await net.get('https://u.test/'); assert.equal(r.headers['x-robots-tag'], 'noindex'); assert.match(seenUa, /website-launch-skills/)
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

// Fix round 1, finding 1: a malformed Location header must resolve, not reject
test('a malformed redirect Location resolves with status 0 and an invalid-location error', async () => {
  const net = createNet({ fetchImpl: fakeFetch({ 'https://bad.test/start': { status: 302, headers: { location: 'http://[not a valid host/path' } } }) })
  const r = await net.get('https://bad.test/start')
  assert.equal(r.status, 0)
  assert.match(r.error, /invalid redirect location/)
  assert.equal(r.chain.length, 1)
})

// Fix round 1, finding 2: cert() must close the socket on a parse error or a socket error
test('cert() destroys the socket when reading the peer certificate throws', async () => {
  let destroyed = false, ended = false
  const fakeTls = (opts, cb) => {
    const sock = {
      getPeerCertificate: () => { throw new Error('boom') },
      authorized: true,
      end() { ended = true },
      destroy() { destroyed = true },
      on() {},
    }
    setTimeout(cb, 0)
    return sock
  }
  const net = createNet({ tlsConnect: fakeTls })
  const c = await net.cert('a.test')
  assert.equal(c.valid, false)
  assert.match(c.error, /boom/)
  assert.equal(destroyed, true)
  assert.equal(ended, false)
})

// A Response-shaped object whose body is a stream the test controls, so a test can say whether the
// body was read at all — which is the whole question `maxBytes` asks.
function streamed({ status = 200, headers = {}, chunks = [], onRead = null }) {
  const encoder = new TextEncoder()
  const queue = chunks.map((c) => (typeof c === 'string' ? encoder.encode(c) : c))
  let i = 0
  let cancelled = false
  const reader = {
    async read() {
      if (onRead) onRead()
      if (i >= queue.length) return { done: true, value: undefined }
      return { done: false, value: queue[i++] }
    },
    async cancel() { cancelled = true },
  }
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    body: { getReader: () => reader, cancel: async () => { cancelled = true } },
    async arrayBuffer() { throw new Error('arrayBuffer must not be used when a stream is available') },
    get cancelled() { return cancelled },
  }
}

// I5: a TLS handshake that never completes left cert() pending forever, and with it every caller.
test('cert() settles as a timeout when the TLS handshake never completes', async () => {
  let destroyed = false
  const fakeTls = () => ({
    getPeerCertificate: () => ({}),
    authorized: false,
    end() {},
    destroy() { destroyed = true },
    on() {},
    setTimeout() {},
  })
  const net = createNet({ tlsConnect: fakeTls, timeoutMs: 25 })
  const c = await net.cert('stalled.test')
  assert.equal(c.valid, false)
  assert.equal(c.error, 'timeout')
  assert.equal(destroyed, true)
})

// The socket's own idle timer settles it too, for a handshake that connects and then goes quiet.
test('cert() settles as a timeout when the socket reports its own timeout', async () => {
  let destroyed = false
  const fakeTls = () => {
    const sock = {
      getPeerCertificate: () => ({}),
      authorized: false,
      end() {},
      destroy() { destroyed = true },
      on() {},
      setTimeout(ms, handler) { setTimeout(handler, 5) },
    }
    return sock
  }
  const net = createNet({ tlsConnect: fakeTls, timeoutMs: 60_000 })
  const c = await net.cert('quiet.test')
  assert.equal(c.error, 'timeout')
  assert.equal(destroyed, true)
})

// I6: a declared content-length over the cap means the body is never read at all. Downloading
// fifty megabytes in order to throw away all but five is not what a cap is for.
test('a content-length over maxBytes is not read, and reports the declared size', async () => {
  let readCalled = false
  const response = streamed({
    headers: { 'content-type': 'image/jpeg', 'content-length': '9000000' },
    chunks: ['never read'],
    onRead: () => { readCalled = true },
  })
  const net = createNet({ fetchImpl: async () => response })
  const r = await net.get('https://huge.test/photo.jpg', { maxBytes: 5_000 })
  assert.equal(readCalled, false, 'the body must not be read when content-length already exceeds the cap')
  assert.equal(r.body, null)
  assert.equal(r.bodyBytes, null)
  assert.equal(r.truncated, true)
  assert.equal(r.bytes, 9_000_000)
})

// No content-length: the only way to know the size is to read, so read — and stop at the cap.
test('an undeclared body is streamed and stops at maxBytes', async () => {
  const response = streamed({
    headers: { 'content-type': 'text/plain' },
    chunks: ['aaaa', 'bbbb', 'cccc'],
  })
  const net = createNet({ fetchImpl: async () => response })
  const r = await net.get('https://stream.test/', { maxBytes: 6 })
  assert.equal(r.truncated, true)
  assert.equal(r.bytes, 6)
  assert.equal(r.body, 'aaaabb')
})

test('a body that fits is streamed whole and is not truncated', async () => {
  const response = streamed({ headers: { 'content-type': 'text/plain' }, chunks: ['aaaa', 'bb'] })
  const net = createNet({ fetchImpl: async () => response })
  const r = await net.get('https://small-stream.test/', { maxBytes: 100 })
  assert.equal(r.truncated, false)
  assert.equal(r.body, 'aaaabb')
  assert.equal(r.bytes, 6)
})

// P2 (M3): an undrained redirect body keeps the socket in limbo. Every hop is drained before the
// next one is fetched.
test('a redirect hop body is cancelled before the next hop is fetched', async () => {
  const hop = streamed({ status: 301, headers: { location: 'https://drain.test/end' }, chunks: ['ignored'] })
  const end = streamed({ status: 200, headers: { 'content-type': 'text/plain' }, chunks: ['done'] })
  const net = createNet({ fetchImpl: async (url) => (url === 'https://drain.test/start' ? hop : end) })
  const r = await net.get('https://drain.test/start')
  assert.equal(r.status, 200)
  assert.equal(hop.cancelled, true, 'the redirect hop body was never drained')
})
