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

export function createNet({
  fetchImpl = globalThis.fetch,
  tlsConnect = tlsConnectDefault,
  timeoutMs = 15000,
  concurrency = 8,
  userAgent = 'website-launch-skill/1.0 (+https://github.com/ethanplusai/website-launch-skill)',
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

  async function readBody(response, maxBytes) {
    let buf
    try {
      buf = await response.arrayBuffer()
    } catch {
      buf = new ArrayBuffer(0)
    }
    const fullBytes = new Uint8Array(buf)
    let readBytes = fullBytes
    let truncated = false
    if (fullBytes.length > maxBytes) {
      readBytes = fullBytes.slice(0, maxBytes)
      truncated = true
    }
    const contentLength = Number(response.headers.get('content-length')) || 0
    const bytes = readBytes.length > 0 ? readBytes.length : contentLength
    if (isTextContentType(response.headers.get('content-type'))) {
      const body = new TextDecoder('utf-8').decode(readBytes)
      return { body, bodyBytes: null, bytes, truncated }
    }
    return { body: null, bodyBytes: readBytes, bytes, truncated }
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

  function cert(hostname, port = 443) {
    return new Promise((resolve) => {
      let settled = false
      const finish = (result) => {
        if (settled) return
        settled = true
        resolve(result)
      }
      let sock
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
      } catch (error) {
        finish(emptyCertResult(String((error && error.message) || error)))
      }
    })
  }

  return { get, head, map, cert }
}
