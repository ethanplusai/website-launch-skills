import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const fixturePath = (rel) => join(REPO_ROOT, 'test', 'fixtures', rel)
export const readFixture = (rel) => readFileSync(fixturePath(rel), 'utf8')
export function tmpDir(name) {
  const dir = join(REPO_ROOT, 'test', 'tmp', `${name}-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// Builds a `net` (compatible with net.mjs's createNet() shape, as far as `get`/`map` go) from a
// plain object of `{ "<absolute url>": { status, headers?, body? } }` recordings. Every response
// is shaped like a real net.get() result: `finalUrl` equals the requested url (no redirects),
// headers are lowercased, and an unknown url comes back as a `status: 0, error: 'not recorded'`
// miss rather than throwing, so a fixture gap shows up as a failing assertion instead of a crash.
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
    return {
      url, finalUrl: url, status, ok: status >= 200 && status < 300,
      headers: lowerHeaders(rec.headers), body, bodyBytes: null,
      chain: [], error: null, timedOut: false,
      bytes: typeof body === 'string' ? body.length : 0, truncated: false,
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
    const workerCount = Math.max(1, Math.min(4, items.length))
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    return results
  }

  return { get, map }
}

export function recordedNetFromFile(relPath) {
  return recordedNet(JSON.parse(readFixture(relPath)))
}
