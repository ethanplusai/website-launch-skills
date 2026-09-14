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
//
// A public resolver on the far side of a corporate firewall does not refuse, it goes quiet, so
// every resolver is raced against a deadline as well as carrying node's own per-query timeout. One
// unreachable resolver must cost one row of the table and nothing else: the run that needs this
// answer is the one somebody is watching on cutover day.

import { resolveTxt as nodeResolveTxt, resolve4 as nodeResolve4, resolve6 as nodeResolve6, resolveCname as nodeResolveCname } from 'node:dns/promises'

export const DKIM_SELECTORS = ['default', 'google', 'selector1', 'selector2', 'k1', 's1', 's2']

// Google, Cloudflare, Quad9, OpenDNS — the four the spec names, in that order.
export const PUBLIC_RESOLVERS = ['8.8.8.8', '1.1.1.1', '9.9.9.9', '208.67.222.222']

// node's own per-query budget: 5s a try, two tries. The deadline below is longer than one full
// resolver's worth of those on purpose — it is the backstop for a resolver that never settles at
// all, not a second, tighter timeout competing with this one.
const RESOLVER_TIMEOUT_MS = 5000
const RESOLVER_TRIES = 2
const RESOLVE_ACROSS_DEADLINE_MS = 7000

async function nodeResolverFor(ip) {
  const { promises } = await import('node:dns')
  const resolver = new promises.Resolver({ timeout: RESOLVER_TIMEOUT_MS, tries: RESOLVER_TRIES })
  resolver.setServers([ip])
  return resolver
}

// Resolves to `{timedOut: true}` when `work` has not settled within `ms`. A rejection is not the
// caller's problem here — every caller below already reports a failed lookup as an absent answer —
// so it resolves as `{timedOut: false, value: null}` rather than propagating.
function withDeadline(work, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true, value: null }), ms)
    // Deliberately not unref'd. A never-settling lookup leaves this timer as the only thing in the
    // event loop, and an unref'd one would let the process wind down before the deadline it exists
    // to enforce ever fires. It is cleared the moment `work` settles, so it bounds the wait rather
    // than extending it.
    const settle = (value) => {
      clearTimeout(timer)
      resolve({ timedOut: false, value })
    }
    work.then(settle, () => settle(null))
  })
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
  resolveAcrossDeadlineMs = RESOLVE_ACROSS_DEADLINE_MS,
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
    // `held` is how the deadline path reaches the resolver the lookup opened. Giving up without
    // cancelling leaves node's own per-query timers — 5s a try, two tries — running behind a
    // deadline that has already answered, which keeps the process alive past the point the run is
    // done with them. A resolver that answered in time is never cancelled.
    const ask = async (ip, held) => {
      const absent = { resolver: ip, a: [], aaaa: [], cname: null, error: null }
      let resolver
      try {
        resolver = await makeResolver(ip)
      } catch (error) {
        return { ...absent, error: error?.code ?? String(error?.message ?? error) }
      }
      held.resolver = resolver

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
    }

    return Promise.all(resolvers.map(async (ip) => {
      const held = { resolver: null }
      const { timedOut, value } = await withDeadline(ask(ip, held), resolveAcrossDeadlineMs)
      if (timedOut) {
        try { held.resolver?.cancel?.() } catch { /* a resolver that will not cancel is still abandoned */ }
        return { resolver: ip, a: [], aaaa: [], cname: null, error: 'timeout' }
      }
      return value ?? { resolver: ip, a: [], aaaa: [], cname: null, error: 'no answer' }
    }))
  }

  return { spf, dmarc, dkim, addresses, txt, resolveAcross }
}
