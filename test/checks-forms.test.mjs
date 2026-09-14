import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checks } from '../skills/launch-audit/scripts/lib/checks/forms.mjs'
import { findingsFor, has, of, allEvidence, evidenceText } from './checks-helpers.mjs'

const run = (fixture, options) => findingsFor(checks, `recorded/${fixture}`, options)
// One form, wired to a real endpoint, every control labelled, a honeypot in place.
const good = () => run('forms-good-site.json', { url: 'https://good-forms.test/' })
// Six forms: no action, a dev endpoint, a placeholder endpoint, a javascript: action, a broken
// embed and an action of "#".
const bad = () => run('forms-site.json', { url: 'https://forms.test/' })
const staging = () => run('forms-site.json', { url: 'https://forms.test/', staging: true, cacheTag: 'staging' })

test('every check is registrable and in the forms dimension', () => {
  assert.ok(checks.length > 0)
  for (const check of checks) {
    assert.equal(check.phase, 'launch-audit')
    assert.equal(check.dimension, 'forms')
    assert.ok(check.id.startsWith('forms.'))
    assert.ok(check.title && check.catches)
  }
  assert.equal(new Set(checks.map((c) => c.id)).size, checks.length)
})

test('the only human-tier check is the one a person has to do', () => {
  const human = checks.filter((c) => c.tier === 'human').map((c) => c.id)
  assert.deepEqual(human, ['forms.test-submission-required'])
  for (const check of checks) assert.ok(check.tier === 'http' || check.tier === 'human')
})

test('a correctly wired form reports only its inventory and the submission nobody can automate', async () => {
  assert.deepEqual([...new Set((await good()).map((f) => f.id))].sort(), ['forms.inventory', 'forms.test-submission-required'])
})

test('forms.inventory reports one info finding per form, with its action and method', async () => {
  const found = of(await bad(), 'forms.inventory')
  assert.equal(found.length, 6)
  for (const finding of found) assert.equal(finding.severity, 'info')
  const evidence = allEvidence(found)
  assert.match(evidence, /forms\.test\/contact/)
  assert.match(evidence, /post/)
  assert.equal(of(await good(), 'forms.inventory').length, 1)
})

test('forms.dead-action fires on no action, on javascript: and on "#"', async () => {
  const found = of(await bad(), 'forms.dead-action')
  assert.equal(found.length, 3)
  for (const finding of found) assert.equal(finding.severity, 'high')
  const evidence = allEvidence(found)
  assert.match(evidence, /no action/i)
  assert.match(evidence, /javascript:/)
  assert.match(evidence, /#/)
  assert.ok(!has(await good(), 'forms.dead-action'))
})

test('forms.dev-endpoint blocks a production launch and is high on staging', async () => {
  const found = of(await bad(), 'forms.dev-endpoint')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'blocker')
  assert.match(evidenceText(found[0]), /localhost:4000/)
  assert.equal(of(await staging(), 'forms.dev-endpoint')[0].severity, 'high')
  assert.ok(!has(await good(), 'forms.dev-endpoint'))
})

test('forms.placeholder-id catches a placeholder in the action and one in an input value', async () => {
  const found = of(await bad(), 'forms.placeholder-id')
  assert.equal(found.length, 2)
  for (const finding of found) assert.equal(finding.severity, 'high')
  const evidence = allEvidence(found)
  assert.match(evidence, /your-form-id/)
  assert.match(evidence, /xxxxxx/)
  assert.ok(!has(await good(), 'forms.placeholder-id'))
})

test('forms.unlabelled-inputs lists the controls with no accessible name', async () => {
  const found = of(await bad(), 'forms.unlabelled-inputs')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  assert.match(evidenceText(found[0]), /email/)
  assert.ok(!has(await good(), 'forms.unlabelled-inputs'))
})

test('a hidden honeypot is never reported as an unlabelled input', async () => {
  // Every form in the fixture carries a display:none honeypot named "website".
  assert.ok(!allEvidence(of(await bad(), 'forms.unlabelled-inputs')).includes('website'))
})

test('forms.embed-broken fires on a form embed that does not 200', async () => {
  const found = of(await bad(), 'forms.embed-broken')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'high')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /hsforms\.net/)
  assert.match(evidence, /404/)
  assert.ok(!has(await good(), 'forms.embed-broken'))
})

test('forms.no-spam-protection fires on the one form with neither honeypot nor captcha', async () => {
  const found = of(await bad(), 'forms.no-spam-protection')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'info')
  assert.ok(!has(await good(), 'forms.no-spam-protection'))
})

test('forms.test-submission-required is raised once per form, for a person to do', async () => {
  const found = of(await bad(), 'forms.test-submission-required')
  assert.equal(found.length, 6)
  for (const finding of found) {
    assert.equal(finding.severity, 'info')
    assert.equal(finding.tier, 'human')
  }
  assert.equal(of(await good(), 'forms.test-submission-required').length, 1)
})
