import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRegistry, defineCheck, SkipCheck } from '../skills/launch-audit/scripts/lib/registry.mjs'
const mk = (id, extra = {}) => defineCheck({ id, phase: 'launch-audit', dimension: id.split('.')[0], severity: 'high', tier: 'http', title: 't', catches: 'c', run: () => [], ...extra })
test('adds and lists checks by phase', () => {
  const r = createRegistry(); r.add(mk('head.a')); r.add(mk('links.b', { phase: 'post-launch' }))
  assert.deepEqual(r.byPhase('launch-audit').map((c) => c.id), ['head.a'])
  assert.ok(r.ids().has('links.b'))
})
test('rejects duplicate ids', () => { const r = createRegistry(); r.add(mk('head.a')); assert.throws(() => r.add(mk('head.a')), /duplicate/) })
test('rejects an id whose prefix is not its dimension', () => { assert.throws(() => mk('head.a', { dimension: 'links' }), /dimension/) })
test('rejects a check without run()', () => { assert.throws(() => defineCheck({ id: 'x.y', phase: 'launch-audit', dimension: 'x', severity: 'info', tier: 'http', title: 't', catches: 'c' }), /run/) })
test('ctx.mk is prebound with the check identity', () => {
  const c = mk('head.a'); const f = c.mk({ page: 'https://x.test/', title: 'T', detail: 'D', evidence: [{ type: 'url', value: 'https://x.test/' }], fix: 'F' })
  assert.equal(f.id, 'head.a'); assert.equal(f.severity, 'high'); assert.equal(f.tier, 'http')
})
test('SkipCheck is an Error with a reason property', () => {
  const skip = new SkipCheck('no predecessor url')
  assert.equal(skip.reason, 'no predecessor url')
  assert.ok(skip instanceof Error)
})
