import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDns, PUBLIC_RESOLVERS } from '../skills/launch-audit/scripts/lib/dns.mjs'

function resolverError(code) {
  const error = new Error(`${code} lookup failed`)
  error.code = code
  return error
}

const txtFor = (table) => async (name) => {
  if (!(name in table)) throw resolverError('ENOTFOUND')
  return table[name]
}

test('spf() reports the record, its include count, and a hard fail', async () => {
  const dns = createDns({
    resolveTxt: txtFor({ 'example.test': [['v=spf1 include:_spf.mail.test ', 'include:_spf.other.test -all'], ['unrelated=1']] }),
  })
  const spf = await dns.spf('example.test')
  assert.equal(spf.present, true)
  assert.equal(spf.record, 'v=spf1 include:_spf.mail.test include:_spf.other.test -all')
  assert.equal(spf.includesCount, 2)
  assert.equal(spf.hardFail, true)
})

test('spf() reports a soft fail and no includes', async () => {
  const dns = createDns({ resolveTxt: txtFor({ 'example.test': [['v=spf1 ~all']] }) })
  const spf = await dns.spf('example.test')
  assert.deepEqual(spf, { present: true, record: 'v=spf1 ~all', includesCount: 0, hardFail: false })
})

test('spf() is absent when no TXT record carries v=spf1', async () => {
  const dns = createDns({ resolveTxt: txtFor({ 'example.test': [['google-site-verification=abc']] }) })
  assert.deepEqual(await dns.spf('example.test'), { present: false, record: null, includesCount: 0, hardFail: false })
})

test('spf() swallows a resolver error instead of throwing', async () => {
  const dns = createDns({ resolveTxt: async () => { throw resolverError('ENOTFOUND') } })
  assert.deepEqual(await dns.spf('nope.test'), { present: false, record: null, includesCount: 0, hardFail: false })
})

test('dmarc() reads the policy from _dmarc', async () => {
  const dns = createDns({ resolveTxt: txtFor({ '_dmarc.example.test': [['v=DMARC1; p=reject; rua=mailto:a@example.test']] }) })
  const dmarc = await dns.dmarc('example.test')
  assert.equal(dmarc.present, true)
  assert.equal(dmarc.policy, 'reject')
  assert.match(dmarc.record, /^v=DMARC1/)
})

test('dmarc() normalizes p=None and reports quarantine', async () => {
  const none = createDns({ resolveTxt: txtFor({ '_dmarc.a.test': [['v=DMARC1; p=None']] }) })
  assert.equal((await none.dmarc('a.test')).policy, 'none')
  const quarantine = createDns({ resolveTxt: txtFor({ '_dmarc.b.test': [['v=DMARC1;p=quarantine;pct=100']] }) })
  assert.equal((await quarantine.dmarc('b.test')).policy, 'quarantine')
})

test('dmarc() is absent, with a null policy, when the record is missing or unparseable', async () => {
  const missing = createDns({ resolveTxt: async () => { throw resolverError('ENODATA') } })
  assert.deepEqual(await missing.dmarc('example.test'), { present: false, record: null, policy: null })
  const noPolicy = createDns({ resolveTxt: txtFor({ '_dmarc.c.test': [['v=DMARC1; rua=mailto:a@c.test']] }) })
  const result = await noPolicy.dmarc('c.test')
  assert.equal(result.present, true)
  assert.equal(result.policy, null)
})

test('dkim() returns every selector that answers', async () => {
  const dns = createDns({
    resolveTxt: txtFor({
      'google._domainkey.example.test': [['v=DKIM1; k=rsa; p=MIIBIj']],
      's1._domainkey.example.test': [['v=DKIM1; p=AAAA']],
    }),
  })
  const dkim = await dns.dkim('example.test')
  assert.deepEqual(dkim.found.map((f) => f.selector), ['google', 's1'])
  assert.match(dkim.found[0].record, /v=DKIM1/)
})

test('dkim() looks every selector up at once, and still reports them in list order', async () => {
  let concurrent = 0
  let peak = 0
  const dns = createDns({
    resolveTxt: async (name) => {
      concurrent++
      peak = Math.max(peak, concurrent)
      await new Promise((resolve) => setImmediate(resolve))
      concurrent--
      return name === 's2._domainkey.example.test' || name === 'default._domainkey.example.test'
        ? [['v=DKIM1; p=AAAA']]
        : []
    },
  })
  const dkim = await dns.dkim('example.test')
  // DKIM_SELECTORS is ['default', 'google', 'selector1', 'selector2', 'k1', 's1', 's2'], so the
  // answers come back in that order however they were resolved.
  assert.deepEqual(dkim.found.map((f) => f.selector), ['default', 's2'])
  assert.ok(peak > 1, `expected the selectors to be resolved together, peak concurrency was ${peak}`)
})

test('dkim() honours an explicit selector list and reports nothing when none answer', async () => {
  const dns = createDns({ resolveTxt: txtFor({ 'custom._domainkey.example.test': [['v=DKIM1; p=BBBB']] }) })
  assert.deepEqual((await dns.dkim('example.test', ['custom'])).found.map((f) => f.selector), ['custom'])
  assert.deepEqual((await dns.dkim('example.test', ['absent'])).found, [])
})

test('addresses() collects A, AAAA and CNAME', async () => {
  const dns = createDns({
    resolve4: async () => ['203.0.113.10'],
    resolve6: async () => ['2001:db8::1'],
    resolveCname: async () => ['edge.host.test'],
  })
  assert.deepEqual(await dns.addresses('example.test'), {
    a: ['203.0.113.10'], aaaa: ['2001:db8::1'], cname: 'edge.host.test', error: null,
  })
})

test('addresses() reports the resolver code when the host does not resolve at all', async () => {
  const dns = createDns({
    resolve4: async () => { throw resolverError('ENOTFOUND') },
    resolve6: async () => { throw resolverError('ENOTFOUND') },
    resolveCname: async () => { throw resolverError('ENOTFOUND') },
  })
  assert.deepEqual(await dns.addresses('nope.test'), { a: [], aaaa: [], cname: null, error: 'ENOTFOUND' })
})

test('addresses() does not report an error when only the optional lookups fail', async () => {
  const dns = createDns({
    resolve4: async () => ['203.0.113.10'],
    resolve6: async () => { throw resolverError('ENODATA') },
    resolveCname: async () => { throw resolverError('ENODATA') },
  })
  assert.deepEqual(await dns.addresses('example.test'), { a: ['203.0.113.10'], aaaa: [], cname: null, error: null })
})

test('createDns() defaults to the node resolver and still answers', async () => {
  const dns = createDns()
  assert.equal(typeof dns.spf, 'function')
  assert.equal(typeof dns.dmarc, 'function')
  assert.equal(typeof dns.dkim, 'function')
  assert.equal(typeof dns.addresses, 'function')
})

// ------------------------------------------------------------------ resolveAcross (propagation)

// A fake `makeResolver`: one table of answers per resolver ip, so a test can make two public
// resolvers disagree the way they do mid-propagation.
const makeResolverFor = (table) => async (ip) => {
  const answers = table[ip]
  if (answers === undefined) throw resolverError('ECONNREFUSED')
  return {
    resolve4: async () => {
      if (answers.a === undefined) throw resolverError('ENODATA')
      return answers.a
    },
    resolve6: async () => {
      if (answers.aaaa === undefined) throw resolverError('ENODATA')
      return answers.aaaa
    },
    resolveCname: async () => {
      if (answers.cname === undefined) throw resolverError('ENODATA')
      return [answers.cname]
    },
  }
}

test('resolveAcross asks every resolver and reports each answer in list order', async () => {
  const dns = createDns({
    makeResolver: makeResolverFor({
      '8.8.8.8': { a: ['203.0.113.10'] },
      '1.1.1.1': { a: ['203.0.113.10'], aaaa: ['2001:db8::1'] },
    }),
  })
  const answers = await dns.resolveAcross('example.test', ['8.8.8.8', '1.1.1.1'])
  assert.deepEqual(answers.map((r) => r.resolver), ['8.8.8.8', '1.1.1.1'])
  assert.deepEqual(answers[0], { resolver: '8.8.8.8', a: ['203.0.113.10'], aaaa: [], cname: null, error: null })
  assert.deepEqual(answers[1].aaaa, ['2001:db8::1'])
})

test('resolveAcross reports a CNAME and no error when only A and AAAA are absent', async () => {
  const dns = createDns({ makeResolver: makeResolverFor({ '9.9.9.9': { cname: 'edge.host.test' } }) })
  const [answer] = await dns.resolveAcross('www.example.test', ['9.9.9.9'])
  assert.deepEqual(answer, { resolver: '9.9.9.9', a: [], aaaa: [], cname: 'edge.host.test', error: null })
})

test('resolveAcross reports a resolver that answers nothing as an error and never throws', async () => {
  const dns = createDns({ makeResolver: makeResolverFor({ '8.8.8.8': { a: ['203.0.113.10'] } }) })
  const answers = await dns.resolveAcross('example.test', ['8.8.8.8', '203.0.113.99'])
  assert.equal(answers[0].error, null)
  assert.equal(answers[1].error, 'ECONNREFUSED')
  assert.deepEqual(answers[1].a, [])
})

test('resolveAcross shows two resolvers disagreeing mid-propagation', async () => {
  const dns = createDns({
    makeResolver: makeResolverFor({
      '8.8.8.8': { a: ['203.0.113.10'] },
      '1.1.1.1': { a: ['198.51.100.7'] },
    }),
  })
  const answers = await dns.resolveAcross('example.test', ['8.8.8.8', '1.1.1.1'])
  assert.deepEqual(answers.map((r) => r.a), [['203.0.113.10'], ['198.51.100.7']])
})

test('resolveAcross defaults to the four public resolvers', async () => {
  const asked = []
  const dns = createDns({
    makeResolver: async (ip) => {
      asked.push(ip)
      return { resolve4: async () => ['203.0.113.10'], resolve6: async () => [], resolveCname: async () => [] }
    },
  })
  const answers = await dns.resolveAcross('example.test')
  assert.deepEqual(asked.sort(), ['1.1.1.1', '208.67.222.222', '8.8.8.8', '9.9.9.9'])
  assert.deepEqual(answers.map((r) => r.resolver), PUBLIC_RESOLVERS)
})

test('createDns() exposes resolveAcross with a node-backed resolver by default', async () => {
  assert.equal(typeof createDns().resolveAcross, 'function')
})

test('resolveAcross gives up on a resolver that never settles, and the others still answer', async () => {
  const dns = createDns({
    resolveAcrossDeadlineMs: 20,
    makeResolver: async (ip) => {
      if (ip === '9.9.9.9') return new Promise(() => {}) // never settles, not even to reject
      return { resolve4: async () => ['203.0.113.10'], resolve6: async () => [], resolveCname: async () => [] }
    },
  })
  const answers = await dns.resolveAcross('example.test', ['8.8.8.8', '9.9.9.9'])
  assert.deepEqual(answers[0], { resolver: '8.8.8.8', a: ['203.0.113.10'], aaaa: [], cname: null, error: null })
  assert.deepEqual(answers[1], { resolver: '9.9.9.9', a: [], aaaa: [], cname: null, error: 'timeout' })
})

test('resolveAcross gives up on a lookup that never settles, not only a resolver that never opens', async () => {
  const dns = createDns({
    resolveAcrossDeadlineMs: 20,
    makeResolver: async () => ({
      resolve4: () => new Promise(() => {}),
      resolve6: async () => [],
      resolveCname: async () => [],
    }),
  })
  const [answer] = await dns.resolveAcross('example.test', ['8.8.8.8'])
  assert.equal(answer.error, 'timeout')
})

test('resolveAcross reports a CNAME host the way a real resolver does: the CNAME and its A records', async () => {
  const dns = createDns({
    makeResolver: async () => ({
      resolve4: async () => ['203.0.113.10'],
      resolve6: async () => [],
      resolveCname: async () => ['new.test'],
    }),
  })
  const [answer] = await dns.resolveAcross('www.example.test', ['8.8.8.8'])
  assert.deepEqual(answer.a, ['203.0.113.10'])
  assert.equal(answer.cname, 'new.test')
  assert.equal(answer.error, null)
})
