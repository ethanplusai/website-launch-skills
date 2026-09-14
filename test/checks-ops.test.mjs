import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checks, OPS_CHECKLIST } from '../skills/launch-audit/scripts/lib/checks/ops.mjs'
import { findingsFor, has, of, allEvidence, evidenceText } from './checks-helpers.mjs'

const run = (fixture, options) => findingsFor(checks, `recorded/${fixture}`, options)

// Email records for a domain that publishes all three.
const authenticated = (domain) => ({
  resolveTxt: async (name) => {
    if (name === domain) return [['v=spf1 include:mail.test -all']]
    if (name === `_dmarc.${domain}`) return [['v=DMARC1; p=quarantine']]
    if (name === `default._domainkey.${domain}`) return [['v=DKIM1; p=AAAA']]
    return []
  },
})

// A site with no privacy, terms or cookie link anywhere, on a domain that publishes no SPF, no
// DMARC and no DKIM.
const bad = () => run('ops-site.json', { url: 'https://ops.test/' })
// The same shop, with the three policies linked in the footer and its email authenticated.
const good = () => run('ops-good-site.json', {
  url: 'https://ops-good.test/',
  resolvers: authenticated('ops-good.test'),
  cacheTag: 'ops-good',
})

test('every check is registrable and in the ops dimension', async () => {
  assert.ok(checks.length > 0)
  for (const check of checks) {
    assert.equal(check.phase, 'launch-audit')
    assert.equal(check.dimension, 'ops')
    assert.ok(check.id.startsWith('ops.'))
    assert.ok(check.title && check.catches)
  }
  assert.equal(new Set(checks.map((c) => c.id)).size, checks.length)
})

test('OPS_CHECKLIST is the thirteen-item launch list, and names the checks that verify it', () => {
  assert.equal(OPS_CHECKLIST.length, 13)
  for (const item of OPS_CHECKLIST) {
    assert.equal(typeof item.label, 'string')
    assert.ok(item.label.length > 0)
    assert.ok(item.auto === null || typeof item.auto === 'string')
  }
  assert.deepEqual(OPS_CHECKLIST.filter((i) => i.auto !== null).map((i) => i.auto), [
    'analytics', 'forms', 'ops.email-auth', 'ops.legal-pages', 'host.soft-404', 'indexability.site-noindex',
  ])
  assert.equal(OPS_CHECKLIST[0].label, 'Hosting account provisioned; access confirmed')
  assert.equal(OPS_CHECKLIST[12].label, 'Search engines allowed on production')
})

test('a site with its policies published and its email authenticated reports only the checklist', async () => {
  assert.deepEqual((await good()).map((f) => f.id), ['ops.checklist'])
})

test('ops.email-auth reports each missing record separately', async () => {
  const found = of(await bad(), 'ops.email-auth')
  assert.equal(found.length, 3)
  for (const finding of found) {
    assert.equal(finding.severity, 'medium')
    assert.ok(finding.evidence.some((e) => e.type === 'dns'))
  }
  const evidence = allEvidence(found)
  assert.match(evidence, /SPF/)
  assert.match(evidence, /DMARC/)
  assert.match(evidence, /DKIM/)
  assert.ok(!has(await good(), 'ops.email-auth'))
})

test('ops.email-auth reports only what is actually missing', async () => {
  const findings = await run('ops-site.json', {
    url: 'https://ops.test/',
    cacheTag: 'spf-only',
    resolvers: {
      resolveTxt: async (name) => (name === 'ops.test' ? [['v=spf1 include:mail.test -all']] : []),
    },
  })
  const found = of(findings, 'ops.email-auth')
  assert.equal(found.length, 2)
  assert.ok(!allEvidence(found).includes('SPF'))
})

test('ops.legal-pages fires when nothing on the site links to a policy, and says what it looked for', async () => {
  const found = of(await bad(), 'ops.legal-pages')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /privacy/)
  assert.match(evidence, /terms/)
  assert.match(evidence, /cookie/)
  assert.match(evidence, /link/)
  assert.ok(!has(await good(), 'ops.legal-pages'))
})

test('ops.checklist renders every item, marked auto or human', async () => {
  const found = of(await bad(), 'ops.checklist')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'info')
  assert.equal(found[0].evidence.length, OPS_CHECKLIST.length)
  for (const item of found[0].evidence) assert.equal(item.type, 'text')
  const lines = found[0].evidence.map((e) => e.value)
  assert.ok(lines.includes('- [auto: ops.email-auth] Email authentication: SPF, DKIM, DMARC present'))
  assert.ok(lines.includes('- [auto: host.soft-404] Custom 404 returns a real 404'))
  assert.ok(lines.includes('- [human] Hosting account provisioned; access confirmed'))
  assert.ok(lines.includes('- [human] Backups configured and a restore tested'))
  // The checklist is one finding for the site, never one per page.
  assert.equal(of(await good(), 'ops.checklist').length, 1)
})
