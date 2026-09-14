// DNS lookups for the email and hosting checks, with every resolver injected.
//
// createDns({resolveTxt, resolve4, resolve6, resolveCname}) defaults each resolver to the matching
// node:dns/promises function, so tests can hand in a table instead of touching the network. Every
// function here is total: a resolver that rejects — ENOTFOUND for a host that does not exist,
// ENODATA for a host with no record of that type, a timeout, anything — is reported as the
// "absent" shape for that lookup and never thrown. A TXT record arrives from node as an array of
// strings (one per 255-byte chunk); each record's chunks are concatenated before matching, which
// is what a long SPF or DKIM record needs.

// resolveAcross(host) is the one lookup that deliberately does not use the machine's own resolver.
// On cutover day the question is not "where does this host point" but "where does it point *yet*",
// and the only way to see propagation is to ask several public resolvers separately and compare
// their answers. Each one is a fresh node:dns Resolver with its servers set to that ip; the whole
// thing is injectable through `makeResolver` so tests can make two resolvers disagree without a
// socket.

import { resolveTxt as nodeResolveTxt, resolve4 as nodeResolve4, resolve6 as nodeResolve6, resolveCname as nodeResolveCname } from 'node:dns/promises'

export const DKIM_SELECTORS = ['default', 'google', 'selector1', 'selector2', 'k1', 's1', 's2']

// Google, Cloudflare, Quad9, OpenDNS — the four the spec names, in that order.
export const PUBLIC_RESOLVERS = ['8.8.8.8', '1.1.1.1', '9.9.9.9', '208.67.222.222']

async function nodeResolverFor(ip) {
  const { promises } = await import('node:dns')
  const resolver = new promises.Resolver()
  resolver.setServers([ip])
  return resolver
}

const ABSENT_SPF = { present: false, record: null, includesCount: 0, hardFail: false }
const ABSENT_DMARC = { present: false, record: null, policy: null }
const DMARC_POLICIES = new Set(['none', 'quarantine', 'reject'])

export function createDns({
  resolveTxt = nodeResolveTxt,
  resolve4 = nodeResolve4,
  resolve6 = nodeResolve6,
  resolveCname = nodeResolveCname,
  makeResolver = nodeResolverFor,
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

  // Every selector is looked up at once — they are independent lookups and a sequential loop pays
  // the full DNS round trip seven times over — and the answers are reassembled in the order the
  // selector list gave, so `found` reads the same however fast each lookup came back.
  async function dkim(host, selectors = DKIM_SELECTORS) {
    const answers = await Promise.all(selectors.map(async (selector) => {
      const record = (await txt(`${selector}._domainkey.${host}`)).find((r) => /v=DKIM1|(^|;)\s*p\s*=/i.test(r))
      return record === undefined ? null : { selector, record: record.trim() }
    }))
    return { found: answers.filter((answer) => answer !== null) }
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

  // What each public resolver currently believes about `host`. One entry per resolver, in the
  // order asked, and every entry is total the way `addresses` is: a resolver that refuses the
  // connection, times out, or knows nothing reports the absent shape with its code in `error`,
  // never a rejection. Mid-propagation the interesting result is precisely the one where two
  // entries differ, so nothing here merges or de-duplicates the answers.
  async function resolveAcross(host, resolvers = PUBLIC_RESOLVERS) {
    return Promise.all(resolvers.map(async (ip) => {
      const absent = { resolver: ip, a: [], aaaa: [], cname: null, error: null }
      let resolver
      try {
        resolver = await makeResolver(ip)
      } catch (error) {
        return { ...absent, error: error?.code ?? String(error?.message ?? error) }
      }

      const codes = []
      const attempt = async (fn) => {
        if (typeof fn !== 'function') return []
        try {
          const value = await fn(host)
          return Array.isArray(value) ? value : []
        } catch (error) {
          codes.push(error?.code ?? String(error?.message ?? error))
          return []
        }
      }
      const [a, aaaa, cnames] = await Promise.all([
        attempt(resolver.resolve4?.bind(resolver)),
        attempt(resolver.resolve6?.bind(resolver)),
        attempt(resolver.resolveCname?.bind(resolver)),
      ])
      const cname = cnames.length > 0 ? String(cnames[0]) : null
      const unresolved = a.length === 0 && aaaa.length === 0 && cname === null
      return { resolver: ip, a, aaaa, cname, error: unresolved && codes.length > 0 ? codes[0] : null }
    }))
  }

  return { spf, dmarc, dkim, addresses, txt, resolveAcross }
}
