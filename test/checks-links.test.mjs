import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checks } from '../skills/launch-audit/scripts/lib/checks/links.mjs'
import { findingsFor, has, of, allEvidence, evidenceText } from './checks-helpers.mjs'

const run = (fixture, options) => findingsFor(checks, `recorded/${fixture}`, options)
// A site whose links all work: the negative case for everything below.
const good = () => run('links-good-site.json', { url: 'https://good-links.test/' })
// Broken, redirecting, unverifiable, dev-host, insecure, unlabelled and generic links, all on one
// page, so every check has something real to catch.
const bad = () => run('links-site.json', { url: 'https://links.test/' })
const staging = () => run('links-site.json', { url: 'https://links.test/', staging: true, cacheTag: 'staging' })

test('every check is registrable, http-tier, and in the links dimension', () => {
  assert.ok(checks.length > 0)
  for (const check of checks) {
    assert.equal(check.phase, 'launch-audit')
    assert.equal(check.dimension, 'links')
    assert.ok(check.id.startsWith('links.'))
    assert.equal(check.tier, 'http')
    assert.ok(check.title && check.catches)
  }
  assert.equal(new Set(checks.map((c) => c.id)).size, checks.length)
})

test('a site whose links all work reports nothing at all', async () => {
  assert.deepEqual(await good(), [])
})

test('links.internal-broken names the dead target and the page that links to it', async () => {
  const found = of(await bad(), 'links.internal-broken')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'high')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /links\.test\/gone/)
  assert.match(evidence, /404/)
  assert.equal(found[0].page, 'https://links.test/')
  assert.ok(!has(await good(), 'links.internal-broken'))
})

test('links.external-broken fires on a 404 off-origin target', async () => {
  const found = of(await bad(), 'links.external-broken')
  assert.equal(found.length, 1)
  assert.match(evidenceText(found[0]), /dead\.test\/page/)
  assert.equal(found[0].severity, 'medium')
  assert.ok(!has(await good(), 'links.external-broken'))
})

test('links.external-unverifiable covers a target that never answered and one that refused a bot', async () => {
  const found = of(await bad(), 'links.external-unverifiable')
  assert.equal(found.length, 2)
  for (const finding of found) assert.equal(finding.severity, 'info')
  const evidence = allEvidence(found)
  assert.match(evidence, /slow\.test\/page/)
  assert.match(evidence, /blocked\.test\/page/)
  assert.ok(!has(await good(), 'links.external-unverifiable'))
})

test('an external that times out is unverifiable, never broken', async () => {
  const findings = await bad()
  assert.ok(!allEvidence(of(findings, 'links.external-broken')).includes('slow.test'))
  assert.ok(!allEvidence(of(findings, 'links.external-broken')).includes('blocked.test'))
})

test('a net that reports a timeout produces info, not a broken link', async () => {
  const findings = await run('links-site.json', {
    url: 'https://links.test/',
    cacheTag: 'timeout',
    records: { 'https://out.test/blog': { status: 0, timedOut: true, error: 'timeout after 10000ms' } },
  })
  const unverifiable = of(findings, 'links.external-unverifiable')
  assert.match(allEvidence(unverifiable), /out\.test\/blog/)
  assert.match(allEvidence(unverifiable), /timed out/)
  assert.ok(!allEvidence(of(findings, 'links.external-broken')).includes('out.test/blog'))
})

test('links.to-dev-host blocks a production launch and is merely high on staging', async () => {
  const found = of(await bad(), 'links.to-dev-host')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'blocker')
  assert.match(evidenceText(found[0]), /localhost:3000/)
  assert.equal(of(await staging(), 'links.to-dev-host')[0].severity, 'high')
  assert.ok(!has(await good(), 'links.to-dev-host'))
})

test('links.to-http-on-https names the plain-http links an https page carries', async () => {
  const found = of(await bad(), 'links.to-http-on-https')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  assert.match(evidenceText(found[0]), /insecure\.test/)
  assert.ok(!has(await good(), 'links.to-http-on-https'))
})

test('links.to-redirecting-internal fires on an internal target that redirects', async () => {
  const found = of(await bad(), 'links.to-redirecting-internal')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'low')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /links\.test\/old/)
  assert.match(evidence, /links\.test\/pricing/)
  assert.ok(!has(await good(), 'links.to-redirecting-internal'))
})

test('links.noopener-missing fires on target=_blank without rel=noopener', async () => {
  const found = of(await bad(), 'links.noopener-missing')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'low')
  assert.match(evidenceText(found[0]), /out\.test\/blog/)
  // The good site writes rel="noopener noreferrer" on its one new-tab link.
  assert.ok(!has(await good(), 'links.noopener-missing'))
})

test('links.mailto-invalid fires on an address with no domain', async () => {
  const found = of(await bad(), 'links.mailto-invalid')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  assert.match(evidenceText(found[0]), /mailto:hello@/)
  assert.ok(!has(await good(), 'links.mailto-invalid'))
})

test('links.tel-invalid fires on a tel: href that is not a number', async () => {
  const found = of(await bad(), 'links.tel-invalid')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  assert.match(evidenceText(found[0]), /tel:call-us/)
  assert.ok(!has(await good(), 'links.tel-invalid'))
})

test('links.empty-anchor fires on a link with neither text nor an accessible name', async () => {
  const found = of(await bad(), 'links.empty-anchor')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'low')
  assert.match(evidenceText(found[0]), /links\.test\/about/)
  assert.ok(!has(await good(), 'links.empty-anchor'))
})

test('links.hash-href fires on href="#" and leaves a real fragment link alone', async () => {
  const found = of(await bad(), 'links.hash-href')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'low')
  assert.match(evidenceText(found[0]), /Back to top/)
  // The good site's skip link is href="#main", which goes somewhere.
  assert.ok(!has(await good(), 'links.hash-href'))
})

test('links.javascript-href fires on a javascript: anchor', async () => {
  const found = of(await bad(), 'links.javascript-href')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  assert.match(evidenceText(found[0]), /javascript:void\(0\)/)
  assert.ok(!has(await good(), 'links.javascript-href'))
})

test('links.same-text-different-target fires on one label used for two destinations', async () => {
  const found = of(await bad(), 'links.same-text-different-target')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'info')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /Contact/)
  assert.match(evidence, /links\.test\/contact-us/)
  assert.ok(!has(await good(), 'links.same-text-different-target'))
})

test('links.generic-anchor-text fires on "Click here"', async () => {
  const found = of(await bad(), 'links.generic-anchor-text')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'info')
  assert.match(evidenceText(found[0]), /Click here/)
  assert.ok(!has(await good(), 'links.generic-anchor-text'))
})

test('links.skip-link-missing is reported once for the site, listing the pages that lack one', async () => {
  const found = of(await bad(), 'links.skip-link-missing')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'low')
  assert.match(evidenceText(found[0]), /links\.test\//)
  assert.ok(!has(await good(), 'links.skip-link-missing'))
})
