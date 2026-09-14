// The human checklist and its progress file.
//
// Nine items, two of them conditional, in an order that is a dependency order rather than a
// preference: the Search Console baseline has to be taken before DNS moves, and the forms have to
// be wired before the deploy that makes them public. The order is asserted literally here, because
// "never reorder the human list" is a rule the SKILL.md states and a rule nothing else can enforce.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  HUMAN_ITEMS, PROGRESS_FILE, humanItemsFor, readProgress, confirmItem, resetProgress,
} from '../skills/pre-launch/scripts/lib/human.mjs'
import { normalizeOptions } from '../skills/pre-launch/scripts/lib/context.mjs'
import { copyFixture, PASSING, PASSING_URL } from './pre-launch-helpers.mjs'

const config = (over = {}) => normalizeOptions({ productionUrl: PASSING_URL, ...over })

test('the canonical order is fixed and every item carries instructions', () => {
  assert.deepEqual(HUMAN_ITEMS.map((i) => i.id), [
    'forms', 'analytics', 'hosting', 'payments', 'legal', 'gsc-baseline', 'dns', 'signoff', 'rollback',
  ])
  for (const item of HUMAN_ITEMS) {
    assert.equal(typeof item.title, 'string')
    assert.ok(item.title.length > 0, `${item.id} has no title`)
    assert.ok(item.instructions.length > 40, `${item.id} instructions are too thin to act on`)
  }
})

test('payments appears only when the repo depends on a payment SDK', () => {
  const without = humanItemsFor({ pkg: { dependencies: { astro: '^4' } }, config: config(), confirmed: [] })
  assert.equal(without.some((i) => i.id === 'payments'), false)

  for (const dep of ['stripe', '@paddle/paddle-js', 'lemonsqueezy.ts', '@paypal/react-paypal-js', 'braintree', 'square']) {
    const withIt = humanItemsFor({ pkg: { dependencies: { [dep]: '^1' } }, config: config(), confirmed: [] })
    assert.ok(withIt.some((i) => i.id === 'payments'), `${dep} should trigger the payments item`)
  }
})

test('the Search Console baseline appears only when there is a predecessor', () => {
  const without = humanItemsFor({ pkg: {}, config: config(), confirmed: [] })
  assert.equal(without.some((i) => i.id === 'gsc-baseline'), false)
  const withIt = humanItemsFor({ pkg: {}, config: config({ predecessorUrl: 'https://old.test' }), confirmed: [] })
  assert.ok(withIt.some((i) => i.id === 'gsc-baseline'))
})

test('emitted items keep the canonical order once the conditional ones are in', () => {
  const items = humanItemsFor({
    pkg: { dependencies: { stripe: '^16' } },
    config: config({ predecessorUrl: 'https://old.test' }),
    confirmed: [],
  })
  assert.deepEqual(items.map((i) => i.id), HUMAN_ITEMS.map((i) => i.id))
})

test('confirmations round-trip through .launch-progress.json', () => {
  const { dir, cleanup } = copyFixture(PASSING, 'progress')
  try {
    assert.deepEqual(readProgress(dir).confirmed, [])

    const ids = HUMAN_ITEMS.map((i) => i.id)
    confirmItem(dir, 'forms', ids)
    confirmItem(dir, 'analytics', ids)
    confirmItem(dir, 'forms', ids)

    const saved = JSON.parse(readFileSync(join(dir, PROGRESS_FILE), 'utf8'))
    assert.deepEqual(saved.confirmed, ['forms', 'analytics'], 'confirming twice does not duplicate')
    assert.match(saved.updatedAt, /^\d{4}-\d{2}-\d{2}T/)

    const items = humanItemsFor({ pkg: {}, config: config(), confirmed: readProgress(dir).confirmed })
    assert.equal(items.find((i) => i.id === 'forms').confirmed, true)
    assert.equal(items.find((i) => i.id === 'hosting').confirmed, false)

    resetProgress(dir)
    assert.deepEqual(readProgress(dir).confirmed, [])
  } finally { cleanup() }
})

test('an unknown id is refused rather than written', () => {
  const { dir, cleanup } = copyFixture(PASSING, 'progress-bad')
  try {
    assert.throws(() => confirmItem(dir, 'not-an-item', HUMAN_ITEMS.map((i) => i.id)), /not-an-item/)
    assert.deepEqual(readProgress(dir).confirmed, [])
  } finally { cleanup() }
})

test('a corrupt progress file reads as empty rather than crashing the gate', () => {
  const { dir, cleanup } = copyFixture(PASSING, 'progress-corrupt')
  try {
    writeFileSync(join(dir, PROGRESS_FILE), '{ not json')
    assert.deepEqual(readProgress(dir).confirmed, [])
  } finally { cleanup() }
})
