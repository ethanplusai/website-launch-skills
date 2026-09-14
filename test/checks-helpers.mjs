// Fixture-driven audit contexts for the check-module tests.
//
// buildCtxFromFixture(relPath, options) wires a recorded net (test/fixtures/recorded/*.json) and a
// fake DNS resolver into buildAuditContext, so a check module can be exercised end to end without
// a socket. `options` is the real audit options object plus three test-only keys: `records`
// (extra/overriding recordings merged over the fixture), `cert` (the object net.cert() resolves
// to) and `resolvers` (overrides for the injected DNS resolver functions). The 404 probe path is
// pinned by `random: () => 'deadbeef'`, so every fixture records
// `/this-page-should-not-exist-deadbeef`, and `now` is pinned so lastmod comparisons don't drift.
import { readFixture, recordedNet } from './helpers.mjs'
import { buildAuditContext } from '../skills/launch-audit/scripts/lib/checks/_ctx.mjs'
import { createDns } from '../skills/launch-audit/scripts/lib/dns.mjs'

export const NOW = '2026-09-13T00:00:00.000Z'

function resolverError(code) {
  const error = new Error(`${code} lookup failed`)
  error.code = code
  return error
}

export const fakeResolvers = () => ({
  resolveTxt: async () => [],
  resolve4: async () => ['1.2.3.4'],
  resolve6: async () => [],
  resolveCname: async () => { throw resolverError('ENODATA') },
})

export function defaultCert(host) {
  const apex = host.replace(/^www\./, '')
  return {
    valid: true, subject: apex, altNames: [apex, `www.${apex}`], issuer: 'Test CA',
    validFrom: '2026-01-01T00:00:00.000Z', validTo: '2027-01-01T00:00:00.000Z', daysLeft: 200, error: null,
  }
}

// Returns a `records` patch that merges `patch` into one recording's headers. A null patch value
// removes that header.
export function patchHeaders(relPath, url, patch) {
  const record = JSON.parse(readFixture(relPath))[url]
  if (!record) throw new Error(`patchHeaders: ${url} is not in ${relPath}`)
  const headers = { ...record.headers }
  for (const [name, value] of Object.entries(patch)) {
    if (value === null) delete headers[name.toLowerCase()]
    else headers[name.toLowerCase()] = value
  }
  return { [url]: { ...record, headers } }
}

export async function buildCtxFromFixture(relPath, options = {}) {
  const { records = {}, cert, resolvers = {}, cacheTag, ...rest } = options
  if (!rest.url) throw new Error('buildCtxFromFixture: options.url is required')
  const net = recordedNet({ ...JSON.parse(readFixture(relPath)), ...records })
  net.head = (url) => net.get(url)
  const host = new URL(rest.url).hostname
  // `cert` may be one object for every host, or a function of the host — a real site routinely
  // presents two certificates, an apex on one provider and a www on the CDN in front of it.
  net.cert = async (name = host) => {
    if (cert === undefined) return defaultCert(name)
    return typeof cert === 'function' ? cert(name) : cert
  }
  const dns = createDns({ ...fakeResolvers(), ...resolvers })
  return buildAuditContext(net, dns, { random: () => 'deadbeef', now: NOW, ...rest })
}

const cache = new Map()

export function ctxFor(relPath, options = {}) {
  const key = `${relPath}|${options.cacheTag ?? JSON.stringify(options, (k, v) => (typeof v === 'function' ? String(v) : v))}`
  if (!cache.has(key)) cache.set(key, buildCtxFromFixture(relPath, options))
  return cache.get(key)
}

export async function findingsFor(checks, relPath, options) {
  const ctx = await ctxFor(relPath, options)
  const out = []
  for (const check of checks) {
    const produced = await check.run(ctx)
    if (!Array.isArray(produced)) throw new Error(`${check.id}.run() must return an array`)
    for (const f of produced) {
      if (f.id !== check.id && !String(f.id).startsWith(`${check.dimension}.`)) throw new Error(`${check.id} produced ${f.id}`)
      out.push(f)
    }
  }
  return out
}

export const has = (findings, id) => findings.some((f) => f.id === id)
export const of = (findings, id) => findings.filter((f) => f.id === id)
export const evidenceText = (finding) => finding.evidence.map((e) => `${e.type}:${e.value}`).join(' | ')
export const allEvidence = (findings) => findings.map(evidenceText).join(' || ')
