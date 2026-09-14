import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers.mjs'
import { walk } from '../skills/launch-audit/scripts/lib/fs-util.mjs'

const VENDOR = /plastix|aesthetix|accessibe|wpengine|Desktop\/git|\/Users\//i // vendor-negative-use
const TAG = 'vendor-negative-use'
const SKIP = new Set(['node_modules', '.git', 'tmp', 'website-launch', '.superpowers', '.agents', 'superpowers'])
const TEXT = /\.(mjs|md|json|xml|html|css|txt|csv)$/

function offenders() {
  const hits = []
  for (const file of walk(REPO_ROOT, { skipDirs: SKIP })) {
    if (!TEXT.test(file)) continue
    if (file.endsWith('docs/sources.md')) continue
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (VENDOR.test(line) && !line.includes(TAG)) hits.push(`${file.slice(REPO_ROOT.length + 1)}:${i + 1}`)
    })
  }
  return hits
}

test('vendor detector fires on a planted line', () => {
  assert.ok(VENDOR.test("out = join(home, 'Desktop/git/agency')")) // vendor-negative-use
  assert.ok(!VENDOR.test('Hosting account provisioned'))
})

test('the walk reaches package.json and this test', () => {
  const rel = walk(REPO_ROOT, { skipDirs: SKIP }).map((f) => f.slice(REPO_ROOT.length + 1))
  assert.ok(rel.includes('package.json'))
  assert.ok(rel.includes('test/invariants.test.mjs'))
})

test('no vendor name survives in the repo', () => {
  assert.deepEqual(offenders(), [])
})

test('package.json declares zero dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
})
