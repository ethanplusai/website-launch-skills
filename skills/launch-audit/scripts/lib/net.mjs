import { connect as tlsConnectDefault } from 'node:tls'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const TEXT_CONTENT_TYPES = [/^text\//, /^application\/xml$/, /^application\/json$/, /^application\/xhtml\+xml$/]

function isTextContentType(contentType) {
  if (!contentType) return false
  const type = contentType.split(';')[0].trim().toLowerCase()
  return TEXT_CONTENT_TYPES.some((re) => re.test(type))
}

function emptyCertResult(error) {
  return { valid: false, subject: null, altNames: [], issuer: null, validFrom: null, validTo: null, daysLeft: null, error }
}

// The identity every request from this tool carries, http tier and browser tier alike, so a site
// owner reading their logs sees one agent rather than two.
export const USER_AGENT = 'website-launch-skills/0.1 (+https://github.com/ethanplusai/website-launch-skills)'

export function createNet({
  fetchImpl = globalThis.fetch,
  tlsConnect = tlsConnectDefault,
  timeoutMs = 15000,
  concurrency = 8,
  userAgent = USER_AGENT,
} = {}) {
  function doFetch(url, method, headers) {
    return new Promise((resolve) => {
      const controller = new AbortController()
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        controller.abort()
        resolve({ response: null, error: new Error('timeout'), timedOut: true })
      }, timeoutMs)
      Promise.resolve()
        .then(() => fetchImpl(url, { method, headers, redirect: 'manual', signal: controller.signal }))
        .then((response) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ response, error: null, timedOut: false })
        })
        .catch((error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ response: null, error, timedOut: false })
        })
    })
  }

  // The declared size of a response, or null when the server did not say.
  function declaredLength(response) {
    const raw = response.headers.get('content-length')
    if (raw === null || raw === undefined || raw === '') return null
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : null
  }

  function decode(readBytes, response, bytes, truncated) {
    if (isTextContentType(response.headers.get('content-type'))) {
      return { body: new TextDecoder('utf-8').decode(readBytes), bodyBytes: null, bytes, truncated }
    }
    return { body: null, bodyBytes: readBytes, bytes, truncated }
  }

  function concat(chunks, total) {
    const out = new Uint8Array(total)
    let at = 0
    for (const chunk of chunks) {
      out.set(chunk, at)
      at += chunk.length
    }
    return out
  }

  // `maxBytes` is a cap on what this tool will *read*, not on what it will keep after reading.
  //
  // The old shape awaited `arrayBuffer()` and then sliced, which meant a fifty-megabyte photo was
  // pulled down the wire in full so that all but five megabytes of it could be thrown away — a cap
  // that costs the bandwidth it exists to save, on an audit that probes every image on every page.
  // Three cases now:
  //
  //   the server declared a size over the cap   nothing is read; the declared size is reported
  //   a stream                                  read until the cap, then stop and cancel
  //   no stream at all (a HEAD, a 204, a fake)  the old path, since there is nothing to stream
  //
  // `truncated` means "there was more than this", and `bytes` is the declared size when there is
  // one — a truncated read knows how much it read, not how big the thing was.
  async function readBody(response, maxBytes) {
    const declared = declaredLength(response)

    if (declared !== null && declared > maxBytes) {
      await response.body?.cancel().catch(() => {})
      return { body: null, bodyBytes: null, bytes: declared, truncated: true }
    }

    const reader = typeof response.body?.getReader === 'function' ? response.body.getReader() : null
    if (reader === null) {
      let buf
      try {
        buf = await response.arrayBuffer()
      } catch {
        buf = new ArrayBuffer(0)
      }
      const full = new Uint8Array(buf)
      const truncated = full.length > maxBytes
      const readBytes = truncated ? full.slice(0, maxBytes) : full
      return decode(readBytes, response, declared ?? readBytes.length, truncated)
    }

    const chunks = []
    let read = 0
    let truncated = false
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value ?? 0)
        const room = maxBytes - read
        if (chunk.length > room) {
          chunks.push(chunk.subarray(0, room))
          read = maxBytes
          truncated = true
          break
        }
        chunks.push(chunk)
        read += chunk.length
        if (read === maxBytes) {
          // Exactly at the cap: one more read decides whether anything was left behind.
          const next = await reader.read()
          if (!next.done) truncated = true
          break
        }
      }
    } catch {
      // A stream that breaks mid-read gives up what it already has rather than the whole response.
    }
    await reader.cancel?.().catch(() => {})
    return decode(concat(chunks, read), response, declared ?? read, truncated)
  }

  function headersToRecord(headers) {
    return Object.fromEntries(headers.entries())
  }

  async function get(url, { method = 'GET', maxHops = 10, headers = {}, maxBytes = 5_000_000 } = {}) {
    const reqHeaders = { 'user-agent': userAgent, ...headers }
    let currentUrl = url
    const chain = []
    const visited = new Set([url])
    for (let hops = 0; ; hops++) {
      if (hops >= maxHops) {
        return {
          url, finalUrl: currentUrl, status: 0, ok: false, headers: {}, body: null, bodyBytes: null,
          chain, error: 'too many redirects', timedOut: false, bytes: 0, truncated: false,
        }
      }
      const { response, error, timedOut } = await doFetch(currentUrl, method, reqHeaders)
      if (error || !response) {
        return {
          url, finalUrl: currentUrl, status: 0, ok: false, headers: {}, body: null, bodyBytes: null,
          chain, error: String((error && error.message) || error || 'fetch failed'), timedOut, bytes: 0, truncated: false,
        }
      }
      const status = response.status
      const location = response.headers.get('location')
      if (REDIRECT_STATUSES.has(status) && location) {
        // A redirect body is never read, and an unread body holds its socket open until the
        // connection is reaped. Over a site whose http, www and trailing-slash variants all
        // redirect, that is one stalled socket per probe.
        await response.body?.cancel().catch(() => {})
        chain.push({ url: currentUrl, status, location })
        let nextUrl
        try {
          nextUrl = new URL(location, currentUrl).href
        } catch {
          return {
            url, finalUrl: currentUrl, status: 0, ok: false, headers: {}, body: null, bodyBytes: null,
            chain, error: `invalid redirect location: ${location}`, timedOut: false, bytes: 0, truncated: false,
          }
        }
        if (visited.has(nextUrl)) {
          return {
            url, finalUrl: nextUrl, status: 0, ok: false, headers: {}, body: null, bodyBytes: null,
            chain, error: 'redirect loop', timedOut: false, bytes: 0, truncated: false,
          }
        }
        visited.add(nextUrl)
        currentUrl = nextUrl
        continue
      }
      const { body, bodyBytes, bytes, truncated } = await readBody(response, maxBytes)
      return {
        url, finalUrl: currentUrl, status, ok: response.ok, headers: headersToRecord(response.headers),
        body, bodyBytes, chain, error: null, timedOut: false, bytes, truncated,
      }
    }
  }

  async function head(url, opts = {}) {
    const r = await get(url, { ...opts, method: 'HEAD' })
    if (r.status === 405 || r.status === 501) {
      return get(url, { ...opts, method: 'GET' })
    }
    return r
  }

  async function map(items, fn) {
    const results = new Array(items.length)
    let nextIndex = 0
    async function worker() {
      for (;;) {
        const i = nextIndex++
        if (i >= items.length) return
        try {
          results[i] = await fn(items[i], i)
        } catch (error) {
          results[i] = error
        }
      }
    }
    const workerCount = Math.max(1, Math.min(concurrency, items.length))
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    return results
  }

  // A TLS handshake that never completes used to leave this promise pending forever, and with it
  // every caller that awaited it: `node:tls` calls neither the connect callback nor the 'error'
  // handler for a peer that accepts the socket and then says nothing. Two timers close that door —
  // the socket's own idle timer for a connection that goes quiet mid-handshake, and a plain
  // deadline for the case where the socket object never emits anything at all (a fake, a stalled
  // connect). Both destroy the socket and settle as a timeout, which is what the caller would
  // eventually have concluded anyway, in finite time.
  function cert(hostname, port = 443) {
    return new Promise((resolve) => {
      let settled = false
      let deadline = null
      const finish = (result) => {
        if (settled) return
        settled = true
        if (deadline !== null) clearTimeout(deadline)
        resolve(result)
      }
      let sock
      const giveUp = () => {
        try { sock?.destroy() } catch { /* ignore */ }
        finish(emptyCertResult('timeout'))
      }
      deadline = setTimeout(giveUp, timeoutMs)
      try {
        sock = tlsConnect({ host: hostname, port, servername: hostname, rejectUnauthorized: false }, () => {
          try {
            const certData = sock.getPeerCertificate()
            if (!certData || Object.keys(certData).length === 0) {
              try { sock.end() } catch { /* ignore */ }
              return finish(emptyCertResult('no certificate'))
            }
            const altNames = (certData.subjectaltname || '')
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.startsWith('DNS:'))
              .map((s) => s.slice(4))
            const validFrom = certData.valid_from ? new Date(certData.valid_from) : null
            const validTo = certData.valid_to ? new Date(certData.valid_to) : null
            const daysLeft = validTo ? Math.floor((validTo.getTime() - Date.now()) / 86_400_000) : null
            try { sock.end() } catch { /* ignore */ }
            finish({
              valid: !!sock.authorized,
              subject: certData.subject ? certData.subject.CN ?? null : null,
              altNames,
              issuer: certData.issuer ? certData.issuer.O ?? null : null,
              validFrom: validFrom ? validFrom.toISOString() : null,
              validTo: validTo ? validTo.toISOString() : null,
              daysLeft,
              error: null,
            })
          } catch (error) {
            try { sock.destroy() } catch { /* ignore */ }
            finish(emptyCertResult(String((error && error.message) || error)))
          }
        })
        sock.on('error', (error) => {
          try { sock.destroy() } catch { /* ignore */ }
          finish(emptyCertResult(String((error && error.message) || error)))
        })
        sock.setTimeout?.(timeoutMs, giveUp)
      } catch (error) {
        finish(emptyCertResult(String((error && error.message) || error)))
      }
    })
  }

  return { get, head, map, cert }
}
