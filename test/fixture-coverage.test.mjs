// Every check has both a passing and a failing fixture.
//
// The spec's rule is "every check has at least one positive and one negative fixture". There is no
// way to prove that mechanically — a test can assert anything — so this test enforces the proxy
// that catches the failure it exists to catch: a check nobody exercised. The literal check id has
// to appear at least twice across `test/*.test.mjs`, which is what a pair of assertions looks like
// (the id fires on the bad fixture; the id is absent on the good one).
//
// Checks that always emit — the informational ones that report a state rather than a fault — are
// not exempt. Their two mentions are the two states: the one where the state is one thing and the
// one where it is another. If an id falls short here, the fix is the missing assertion, never a
// wider exemption list.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers.mjs'
import { allChecks } from '../scripts/gen-checks-doc.mjs'

const MIN_MENTIONS = 2
const TEST_DIR = join(REPO_ROOT, 'test')

const testSources = () => readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.mjs'))
  .map((name) => readFileSync(join(TEST_DIR, name), 'utf8'))
  .join('\n')

// Counts the id as a whole token: `head.title` must not be credited for `head.title-length`.
function mentions(source, id) {
  const pattern = new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9-])`, 'g')
  return (source.match(pattern) ?? []).length
}

test('the mention counter does not credit an id for a longer id that starts with it', () => {
  assert.equal(mentions("'head.title' 'head.title-length' 'head.title'", 'head.title'), 2)
  assert.equal(mentions("'head.title-length'", 'head.title'), 0)
})

test('every check id appears at least twice across the test suite', () => {
  const source = testSources()
  const short = allChecks()
    .map((check) => ({ id: check.id, count: mentions(source, check.id) }))
    .filter((entry) => entry.count < MIN_MENTIONS)
  assert.deepEqual(
    short,
    [],
    `these check ids are exercised fewer than ${MIN_MENTIONS} times in test/*.test.mjs — each needs a passing and a failing assertion:\n${short.map((e) => `  ${e.id} (${e.count})`).join('\n')}`,
  )
})

test('the registry the coverage check walks covers all three phases', () => {
  const phases = new Set(allChecks().map((check) => check.phase))
  assert.deepEqual([...phases].sort(), ['launch-audit', 'post-launch', 'pre-launch'])
})
