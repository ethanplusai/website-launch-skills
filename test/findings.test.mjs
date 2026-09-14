import { test } from 'node:test'
import assert from 'node:assert/strict'
import { finding, validateFinding, sortFindings, SEVERITIES } from '../skills/launch-audit/scripts/lib/findings.mjs'
const base = { id: 'head.title-missing', phase: 'launch-audit', dimension: 'head', severity: 'high', tier: 'http', page: 'https://x.test/', title: 'Missing <title>', detail: 'No title element', evidence: [{ type: 'url', value: 'https://x.test/' }], fix: 'Add a <title>' }
test('a valid finding round-trips', () => { assert.equal(finding(base).id, 'head.title-missing') })
test('a finding without evidence is rejected', () => { assert.throws(() => finding({ ...base, evidence: [] }), /evidence/) })
test('unknown severity is rejected', () => { assert.throws(() => finding({ ...base, severity: 'fatal' }), /severity/) })
test('unknown evidence type is rejected', () => { assert.throws(() => finding({ ...base, evidence: [{ type: 'vibe', value: 'x' }] }), /evidence type/) })
test('validateFinding rejects ids not in the registry', () => {
  const r = validateFinding(finding(base), new Set(['other.id']))
  assert.equal(r.ok, false); assert.match(r.errors[0], /not registered/)
})
test('sortFindings orders by severity then dimension then page', () => {
  const a = finding({ ...base, severity: 'low', page: 'https://x.test/b' })
  const b = finding({ ...base, severity: 'blocker', page: 'https://x.test/z' })
  const c = finding({ ...base, severity: 'low', page: 'https://x.test/a' })
  assert.deepEqual(sortFindings([a, b, c]).map((f) => f.page), [b.page, c.page, a.page])
  assert.deepEqual(SEVERITIES, ['blocker', 'high', 'medium', 'low', 'info'])
})
test('evidence array is frozen', () => {
  const f = finding(base)
  assert.throws(() => { f.evidence.push({ type: 'text', value: 'x' }) }, /TypeError/)
})
test('evidence items are frozen', () => {
  const f = finding(base)
  assert.throws(() => { f.evidence[0].value = 'y' }, /TypeError/)
})
test('finding object is frozen', () => {
  const f = finding(base)
  assert.throws(() => { f.severity = 'low' }, /TypeError/)
})
