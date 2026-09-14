// DNS lookups for the email and hosting checks, with every resolver injected.
//
// createDns({resolveTxt, resolve4, resolve6, resolveCname}) defaults each resolver to the matching
// node:dns/promises function, so tests can hand in a table instead of touching the network. Every
// function here is total: a resolver that rejects — ENOTFOUND for a host that does not exist,
// ENODATA for a host with no record of that type, a timeout, anything — is reported as the
// "absent" shape for that lookup and never thrown. A TXT record arrives from node as an array of
// strings (one per 255-byte chunk); each record's chunks are concatenated before matching, which
// is what a long SPF or DKIM record needs.

import { resolveTxt as nodeResolveTxt, resolve4 as nodeResolve4, resolve6 as nodeResolve6, resolveCname as nodeResolveCname } from 'node:dns/promises'

export const DKIM_SELECTORS = ['default', 'google', 'selector1', 'selector2', 'k1', 's1', 's2']

const ABSENT_SPF = { present: false, record: null, includesCount: 0, hardFail: false }
const ABSENT_DMARC = { present: false, record: null, policy: null }
const DMARC_POLICIES = new Set(['none', 'quarantine', 'reject'])

export function createDns({
  resolveTxt = nodeResolveTxt,
  resolve4 = nodeResolve4,
  resolve6 = nodeResolve6,
  resolveCname = nodeResolveCname,
} = {}) {
  // Every record for `name`, each one already joined from its chunks. Never throws.
  async function txt(name) {
    try {
      const records = await resolveTxt(name)
      if (!Array.isArray(records)) return []
      return records.map((record) => (Array.isArray(record) ? record.join('') : String(record)))
    } catch {
      return []
    }
  }

  async function spf(host) {
    const record = (await txt(host)).find((r) => /^v=spf1(\s|$)/i.test(r.trim()))
    if (record === undefined) return { ...ABSENT_SPF }
    const value = record.trim()
    return {
      present: true,
      record: value,
      includesCount: (value.match(/\binclude:/gi) || []).length,
      hardFail: /(^|\s)-all(\s|$)/i.test(value),
    }
  }

  async function dmarc(host) {
    const record = (await txt(`_dmarc.${host}`)).find((r) => /^v=DMARC1(\s*;|$)/i.test(r.trim()))
    if (record === undefined) return { ...ABSENT_DMARC }
    const value = record.trim()
    const policy = /(^|;)\s*p\s*=\s*([a-z]+)/i.exec(value)
    const named = policy ? policy[2].toLowerCase() : null
    return { present: true, record: value, policy: named !== null && DMARC_POLICIES.has(named) ? named : null }
  }

  async function dkim(host, selectors = DKIM_SELECTORS) {
    const found = []
    for (const selector of selectors) {
      const record = (await txt(`${selector}._domainkey.${host}`)).find((r) => /v=DKIM1|(^|;)\s*p\s*=/i.test(r))
      if (record !== undefined) found.push({ selector, record: record.trim() })
    }
    return { found }
  }

  async function addresses(host) {
    const codes = []
    async function attempt(fn, name) {
      try {
        const value = await fn(name)
        return Array.isArray(value) ? value : []
      } catch (error) {
        codes.push(error?.code ?? String(error?.message ?? error))
        return []
      }
    }
    const [a, aaaa, cnames] = await Promise.all([
      attempt(resolve4, host),
      attempt(resolve6, host),
      attempt(resolveCname, host),
    ])
    const cname = cnames.length > 0 ? String(cnames[0]) : null
    const unresolved = a.length === 0 && aaaa.length === 0 && cname === null
    return { a, aaaa, cname, error: unresolved && codes.length > 0 ? codes[0] : null }
  }

  return { spf, dmarc, dkim, addresses, txt }
}
