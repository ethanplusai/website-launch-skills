// A `net` adapter built from recorded responses instead of sockets.
//
// This exists so the command line can be exercised end to end without a server. There is no site
// to point `launch-audit.mjs` at in a test, and standing one up would test the fixture server as
// much as the audit — so `main()` honours WEBSITE_LAUNCH_RECORDED_FIXTURE, a path to a JSON file
// of recorded responses, and builds this adapter instead of the real one. It is a testing hook,
// documented in `--help`, and nothing in a normal run reads the variable.
//
// The fixture shape is a flat map of absolute url to recording:
//
//   { "https://example.test/": { "status": 200, "headers": {...}, "body": "<html>…" } }
//
// `finalUrl` and `chain` express a redirect, `bodyBase64` records a binary body, and a url that is
// not in the map answers `status: 0, error: 'not recorded'` — a miss shows up as a finding about
// an unreachable url rather than as a crash, which is the same thing a dead host would produce.

import { readFileSync } from 'node:fs'
import { Buffer } from 'node:buffer'

const CONCURRENCY = 4

// Builds a net adapter over a plain recordings object. `get` and `map` match createNet()'s shape
// closely enough for every module that consumes a net; `head` and `cert` are attached by
// `recordedNetFromPath`, since a recording has neither a method nor a certificate.
export function recordedNet(fixture) {
  const entries = new Map(Object.entries(fixture))

  function lowerHeaders(headers) {
    const out = {}
    if (headers) for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v
    return out
  }

  async function get(url) {
    const rec = entries.get(url)
    if (!rec) {
      return {
        url, finalUrl: url, status: 0, ok: false, headers: {}, body: null, bodyBytes: null,
        chain: [], error: 'not recorded', timedOut: false, bytes: 0, truncated: false,
      }
    }
    const status = rec.status
    const body = rec.body ?? null
    const bodyBytes = rec.bodyBase64 === undefined ? null : Uint8Array.from(Buffer.from(rec.bodyBase64, 'base64'))
    return {
      url, finalUrl: rec.finalUrl ?? url, status, ok: status >= 200 && status < 300,
      headers: lowerHeaders(rec.headers), body, bodyBytes,
      chain: rec.chain ?? [], error: rec.error ?? null, timedOut: rec.timedOut === true,
      bytes: rec.bytes ?? (typeof body === 'string' ? body.length : (bodyBytes?.length ?? 0)),
      truncated: rec.truncated === true,
    }
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
    const workerCount = Math.max(1, Math.min(CONCURRENCY, items.length))
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    return results
  }

  return { get, map }
}

// The certificate a recorded run reports. A fixture records HTTP, never TLS, so this says so: the
// certificate is valid and its expiry is unknown, which keeps the transport checks quiet rather
// than inventing an expiry date the recording never saw.
function recordedCert(host) {
  const apex = host.replace(/^www\./i, '')
  return {
    valid: true,
    subject: apex,
    altNames: [apex, `www.${apex}`],
    issuer: 'recorded fixture',
    validFrom: null,
    validTo: null,
    daysLeft: null,
    error: null,
  }
}

// The full adapter the CLI hook needs: recorded `get`/`map`, `head` answered from the same
// recordings (a fixture records one response per url, not one per method), and a stand-in cert.
// Named for a filesystem path, to keep it distinct from the test helper's fixture-relative
// `recordedNetFromFile`, which resolves a name under test/fixtures rather than taking a path.
export function recordedNetFromPath(path) {
  const net = recordedNet(JSON.parse(readFileSync(path, 'utf8')))
  net.head = (url) => net.get(url)
  net.cert = async (host) => recordedCert(host)
  return net
}

// DNS for a recorded run: every lookup is empty, so the email-authentication checks report absent
// records rather than reaching the network for a host that does not exist.
export function offlineDnsResolvers() {
  const absent = async () => {
    const error = new Error('ENODATA lookup failed (recorded run)')
    error.code = 'ENODATA'
    throw error
  }
  return { resolveTxt: async () => [], resolve4: absent, resolve6: absent, resolveCname: absent }
}
