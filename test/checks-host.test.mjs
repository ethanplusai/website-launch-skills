import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checks } from '../skills/launch-audit/scripts/lib/checks/host.mjs'
import { findingsFor, findingsAndSkips, skipReason, has, of, allEvidence, evidenceText, patchHeaders, defaultCert } from './checks-helpers.mjs'

const run = (fixture, options) => findingsFor(checks, `recorded/${fixture}`, options)
const good = () => run('https-site.json', { url: 'https://good.test/' })
const bare = () => run('bad-headers-site.json', { url: 'https://bare.test/' })
const split = () => run('split-host-site.json', { url: 'https://split.test/about' })
const plain = () => run('http-only-site.json', { url: 'http://plain.test/' })

test('every check is registrable, http-tier, and in the host dimension', () => {
  assert.ok(checks.length > 0)
  for (const check of checks) {
    assert.equal(check.phase, 'launch-audit')
    assert.equal(check.dimension, 'host')
    assert.ok(check.id.startsWith('host.'))
    assert.equal(check.tier, 'http')
    assert.ok(check.title && check.catches)
  }
  assert.equal(new Set(checks.map((c) => c.id)).size, checks.length)
})

test('host.http-not-redirected fires when http serves the site directly', async () => {
  const found = of(await plain(), 'host.http-not-redirected')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'high')
  assert.match(evidenceText(found[0]), /http:\/\/plain\.test\//)
  assert.ok(!has(await good(), 'host.http-not-redirected'))
})

test('host.http-redirect-not-301 fires on a temporary http redirect', async () => {
  const found = of(await bare(), 'host.http-redirect-not-301')
  assert.equal(found.length, 1)
  assert.match(evidenceText(found[0]), /302/)
  assert.ok(!has(await good(), 'host.http-redirect-not-301'))
})

test('host.hsts-missing fires when https serves no HSTS header', async () => {
  const found = of(await bare(), 'host.hsts-missing')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  assert.ok(!has(await good(), 'host.hsts-missing'))
})

test('host.hsts-short fires under a one-year max-age', async () => {
  const found = of(await run('https-site.json', {
    url: 'https://good.test/',
    cacheTag: 'short-hsts',
    records: patchHeaders('recorded/https-site.json', 'https://good.test/', { 'strict-transport-security': 'max-age=600' }),
  }), 'host.hsts-short')
  assert.equal(found.length, 1)
  assert.match(evidenceText(found[0]), /max-age=600/)
  assert.ok(!has(await good(), 'host.hsts-short'))
})

test('host.cert-invalid blocks on a certificate that does not validate', async () => {
  const found = of(await run('http-only-site.json', {
    url: 'http://plain.test/',
    cacheTag: 'bad-cert',
    cert: { valid: false, subject: null, altNames: [], issuer: null, validFrom: null, validTo: null, daysLeft: null, error: 'self signed certificate' },
  }), 'host.cert-invalid')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'blocker')
  assert.match(evidenceText(found[0]), /self signed/)
  assert.ok(!has(await good(), 'host.cert-invalid'))
})

test('host.cert-expiring fires inside 30 days', async () => {
  const found = of(await run('https-site.json', {
    url: 'https://good.test/',
    cacheTag: 'expiring-cert',
    cert: { ...defaultCert('good.test'), daysLeft: 12, validTo: '2026-09-25T00:00:00.000Z' },
  }), 'host.cert-expiring')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'high')
  assert.match(evidenceText(found[0]), /12/)
  assert.ok(!has(await good(), 'host.cert-expiring'))
})

test('host.cert-missing-san fires when apex or www is not covered', async () => {
  const found = of(await run('https-site.json', {
    url: 'https://good.test/',
    cacheTag: 'san-cert',
    cert: { ...defaultCert('good.test'), altNames: ['other.test'] },
  }), 'host.cert-missing-san')
  assert.equal(found.length, 1)
  assert.match(evidenceText(found[0]), /good\.test/)
  assert.ok(!has(await good(), 'host.cert-missing-san'))
})

test('host.cert-expiring and host.cert-missing-san stay quiet on an expired certificate', async () => {
  // net.cert() connects with rejectUnauthorized:false, so a handshake against an expired
  // certificate still reports its dates and names — with valid:false.
  const found = await run('https-site.json', {
    url: 'https://good.test/',
    cacheTag: 'expired-cert',
    cert: { ...defaultCert('good.test'), valid: false, daysLeft: -5, error: 'certificate has expired' },
  })
  assert.equal(of(found, 'host.cert-invalid').length, 1)
  assert.deepEqual(of(found, 'host.cert-expiring'), [])
  assert.deepEqual(of(found, 'host.cert-missing-san'), [])
})

test('host.cert-missing-san stays quiet on a certificate issued for another host', async () => {
  const found = await run('https-site.json', {
    url: 'https://good.test/',
    cacheTag: 'wrong-host-cert',
    cert: { ...defaultCert('good.test'), valid: false, altNames: ['other.test'], error: 'hostname mismatch' },
  })
  assert.equal(of(found, 'host.cert-invalid').length, 1)
  assert.deepEqual(of(found, 'host.cert-missing-san'), [])
  assert.deepEqual(of(found, 'host.cert-expiring'), [])
})

// Regression, from the smoke run against a real site: the apex certificate named only the apex,
// the www host was served by a CDN in front of it with its own certificate that did cover www, and
// the audit reported "any visitor who reaches an uncovered host gets a name-mismatch warning" —
// about a host that answers over TLS without a warning of any kind.
test('host.cert-missing-san stays quiet when the other host presents its own certificate', async () => {
  const found = await run('https-site.json', {
    url: 'https://good.test/',
    cacheTag: 'own-www-cert',
    cert: (name) => (name === 'www.good.test'
      ? { ...defaultCert('good.test'), subject: 'www.good.test', altNames: ['www.good.test'] }
      : { ...defaultCert('good.test'), altNames: ['good.test'] }),
  })
  assert.deepEqual(of(found, 'host.cert-missing-san'), [])
})

// The same certificate, and a www host that answers nothing: there is no visitor to warn, and the
// check's own catch line says "while the other is still reachable".
test('host.cert-missing-san stays quiet when the uncovered host does not answer at all', async () => {
  const found = await run('https-site.json', {
    url: 'https://good.test/',
    cacheTag: 'no-www-host',
    records: { 'https://www.good.test/': { error: 'ENOTFOUND www.good.test' } },
    cert: (name) => (name === 'www.good.test'
      ? { valid: false, subject: null, altNames: [], issuer: null, validFrom: null, validTo: null, daysLeft: null, error: 'ENOTFOUND' }
      : { ...defaultCert('good.test'), altNames: ['good.test'] }),
  })
  assert.deepEqual(of(found, 'host.cert-missing-san'), [])
})

// And it still fires when www really is served by the same certificate that does not name it.
test('host.cert-missing-san fires when the reachable www host has no certificate of its own', async () => {
  const found = of(await run('https-site.json', {
    url: 'https://good.test/',
    cacheTag: 'shared-bad-cert',
    cert: { ...defaultCert('good.test'), altNames: ['good.test'] },
  }), 'host.cert-missing-san')
  assert.equal(found.length, 1)
  assert.match(evidenceText(found[0]), /www\.good\.test/)
})

test('host.cert-missing-san accepts a wildcard san', async () => {
  const found = of(await run('https-site.json', {
    url: 'https://good.test/',
    cacheTag: 'wildcard-cert',
    cert: { ...defaultCert('good.test'), altNames: ['good.test', '*.good.test'] },
  }), 'host.cert-missing-san')
  assert.deepEqual(found, [])
})

test('host.www-apex-split fires when both hosts serve 200', async () => {
  const found = of(await split(), 'host.www-apex-split')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'high')
  assert.match(evidenceText(found[0]), /www\.split\.test/)
  assert.ok(!has(await good(), 'host.www-apex-split'))
})

test('host.www-apex-no-redirect fires when the other variant is simply broken', async () => {
  const found = of(await bare(), 'host.www-apex-no-redirect')
  assert.equal(found.length, 1)
  assert.match(evidenceText(found[0]), /www\.bare\.test/)
  assert.ok(!has(await good(), 'host.www-apex-no-redirect'))
})

test('the www/apex checks stay quiet for a subdomain target', async () => {
  const found = await run('subdomain-site.json', { url: 'https://app.example.test/' })
  assert.deepEqual(of(found, 'host.www-apex-split'), [])
  assert.deepEqual(of(found, 'host.www-apex-no-redirect'), [])
  assert.deepEqual(of(found, 'host.cert-missing-san'), [])
})

test('host.trailing-slash-both-200 fires when both path forms serve 200', async () => {
  const found = of(await split(), 'host.trailing-slash-both-200')
  assert.equal(found.length, 1)
  assert.match(evidenceText(found[0]), /\/about\//)
  assert.ok(!has(await good(), 'host.trailing-slash-both-200'))
})

test('host.mixed-content fires on http subresources inside an https page', async () => {
  const found = of(await bare(), 'host.mixed-content')
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://bare.test/')
  assert.match(evidenceText(found[0]), /http:\/\/bare\.test\/insecure\.js/)
  assert.ok(!has(await good(), 'host.mixed-content'))
})

test('host.redirect-chain fires past one hop', async () => {
  const found = of(await split(), 'host.redirect-chain')
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://split.test/old')
  assert.match(evidenceText(found[0]), /\/mid/)
  assert.ok(!has(await good(), 'host.redirect-chain'))
})

test('host.redirect-loop fires when the hops come back around', async () => {
  const found = of(await split(), 'host.redirect-loop')
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://split.test/loop')
  assert.equal(found[0].severity, 'high')
  assert.ok(!has(await good(), 'host.redirect-loop'))
})

test('host.meta-refresh fires on a refresh meta tag', async () => {
  const found = of(await bare(), 'host.meta-refresh')
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://bare.test/')
  assert.match(evidenceText(found[0]), /refresh/i)
  assert.ok(!has(await good(), 'host.meta-refresh'))
})

test('host.security-header-missing reports one finding per missing header', async () => {
  const found = of(await bare(), 'host.security-header-missing')
  assert.equal(found.length, 5)
  const evidence = allEvidence(found)
  for (const header of ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy']) {
    assert.match(evidence, new RegExp(header, 'i'))
  }
  assert.ok(!has(await good(), 'host.security-header-missing'))
})

test('host.security-header-missing accepts CSP frame-ancestors in place of X-Frame-Options', async () => {
  const found = of(await run('bad-headers-site.json', {
    url: 'https://bare.test/',
    cacheTag: 'csp-only',
    records: patchHeaders('recorded/bad-headers-site.json', 'https://bare.test/', {
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
    }),
  }), 'host.security-header-missing')
  const missing = allEvidence(found)
  // A CSP with frame-ancestors answers for both itself and X-Frame-Options, leaving exactly the
  // three headers this fixture genuinely does not send.
  assert.equal(found.length, 3)
  assert.deepEqual(
    found.map((f) => f.evidence.find((e) => e.type === 'header').value.split(':')[0]).sort(),
    ['permissions-policy', 'referrer-policy', 'x-content-type-options'],
  )
  assert.doesNotMatch(missing, /x-frame-options/i)
  assert.doesNotMatch(missing, /content-security-policy/i)
})

test('host.security-header-coop-corp notes the cross-origin isolation headers', async () => {
  const found = of(await bare(), 'host.security-header-coop-corp')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'info')
  assert.match(evidenceText(found[0]), /cross-origin-(opener|resource)-policy/i)
  assert.ok(!has(await good(), 'host.security-header-coop-corp'))
})

test('host.leaky-header-present reports one finding per OWASP remove-list header', async () => {
  const found = of(await bare(), 'host.leaky-header-present')
  const headers = found.map((f) => f.evidence[0].value).join(' ').toLowerCase()
  assert.equal(found.length, 3)
  assert.match(headers, /server: nginx\/1\.18\.0/)
  assert.match(headers, /x-powered-by: express/)
  assert.match(headers, /x-generator/)
  assert.ok(!has(await good(), 'host.leaky-header-present'))
})

test('host.no-compression fires when html comes back uncompressed', async () => {
  const found = of(await bare(), 'host.no-compression')
  assert.equal(found.length, 1)
  assert.ok(!has(await good(), 'host.no-compression'))
})

test('host.no-cache-static fires on a static asset with no cache-control', async () => {
  const found = of(await bare(), 'host.no-cache-static')
  assert.equal(found.length, 1)
  assert.match(evidenceText(found[0]), /style\.css/)
  assert.ok(!has(await good(), 'host.no-cache-static'))
})

test('host.http-version reports whether a newer protocol is advertised', async () => {
  const advertised = of(await good(), 'host.http-version')
  assert.equal(advertised.length, 1)
  assert.equal(advertised[0].severity, 'info')
  assert.match(evidenceText(advertised[0]), /h3/)
  const none = of(await bare(), 'host.http-version')
  assert.equal(none.length, 1)
  assert.match(none[0].title, /not advertised|http\/1/i)
})

test('host.soft-404 fires when a missing page answers 200', async () => {
  const found = of(await run('soft-404-site.json', { url: 'https://soft.test/' }), 'host.soft-404')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'high')
  assert.match(evidenceText(found[0]), /200/)
  assert.ok(!has(await good(), 'host.soft-404'))
})

test('host.default-404-body fires on an unbranded server error page', async () => {
  const found = of(await plain(), 'host.default-404-body')
  assert.equal(found.length, 1)
  assert.match(evidenceText(found[0]), /404 Not Found|nginx/i)
  assert.ok(!has(await good(), 'host.default-404-body'))
})

test('host.404-no-navigation fires when the 404 page offers no way out', async () => {
  const found = of(await plain(), 'host.404-no-navigation')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'low')
  assert.ok(!has(await good(), 'host.404-no-navigation'))
})

test('host.dev-host-leak blocks on production and is high on staging', async () => {
  const production = of(await bare(), 'host.dev-host-leak')
  assert.equal(production.length, 1)
  assert.equal(production[0].severity, 'blocker')
  assert.match(evidenceText(production[0]), /localhost:3000/)

  const staging = of(await run('bad-headers-site.json', { url: 'https://bare.test/', staging: true, cacheTag: 'staging' }), 'host.dev-host-leak')
  assert.equal(staging.length, 1)
  assert.equal(staging[0].severity, 'high')

  assert.ok(!has(await good(), 'host.dev-host-leak'))
})

test('host.dev-host-leak also catches a configured dev host', async () => {
  const found = of(await run('bad-headers-site.json', {
    url: 'https://bare.test/',
    cacheTag: 'dev-hosts',
    devHosts: ['cdn.other.test'],
  }), 'host.dev-host-leak')
  assert.equal(found.length, 1)
  assert.match(evidenceText(found[0]), /cdn\.other\.test/)
})

// I1: a probe that never answered is not evidence of anything about the protocol. Reporting
// "nothing newer than HTTP/1.1 is advertised" for a host that sent no headers at all is a claim
// about a response nobody received.
test('host.http-version skips when the root probe never answered', async () => {
  const { findings, skipped } = await findingsAndSkips(checks, 'recorded/unreachable-site.json', { url: 'https://gone.test/' })
  assert.deepEqual(of(findings, 'host.http-version'), [])
  assert.match(skipReason(skipped, 'host.http-version'), /never answered|no response|status 0/i)
})

// I1: `finalUrl` on a request that failed is the url that was asked for, not a url anything
// landed on. "landed on https://www.bare.test/" describes a page load that did not happen.
test('host.www-apex-no-redirect says the other variant did not answer rather than where it landed', async () => {
  const found = of(await bare(), 'host.www-apex-no-redirect')
  assert.equal(found.length, 1)
  const evidence = evidenceText(found[0])
  assert.ok(!/landed on/.test(evidence), `status-0 probe must not claim a landing: ${evidence}`)
  assert.match(evidence, /did not answer/)
})
