// Repo hygiene: the seven things about the repository itself that decide whether the thing you are
// about to deploy is the thing you think you are deploying.
//
// Every one of these reads git through the injected `exec`, so each test states the repository it
// is describing rather than depending on the one the tests happen to run inside.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import { checks, satisfiesRange } from '../skills/pre-launch/scripts/lib/hygiene.mjs'
import { PASSING, FAILING, cleanGit, dirtyGit, noGit, execFake, copyFixture, GIT_STATUS, GIT_FILES, GIT_AHEAD, GIT_UPSTREAM } from './pre-launch-helpers.mjs'
import { ctxFor, group, assertStatus } from './pre-launch-check-helpers.mjs'

test('a clean, pushed, lockfiled repository passes every hygiene check', async () => {
  const map = await group(checks, await ctxFor(PASSING, { exec: cleanGit(), env: { NODE_VERSION_OVERRIDE: 'v22.0.0' } }))
  for (const id of ['hygiene.clean-tree', 'hygiene.pushed', 'hygiene.nested-git', 'hygiene.node-version', 'hygiene.env-tracked', 'hygiene.secrets-committed', 'hygiene.lockfile']) {
    assertStatus(map, id, 'pass', assert)
  }
})

test('an uncommitted tree fails and lists the paths', async () => {
  const map = await group(checks, await ctxFor(PASSING, { exec: dirtyGit() }))
  const found = assertStatus(map, 'hygiene.clean-tree', 'fail', assert)
  assert.ok(found.evidence.some((e) => e.value.includes('src/home.html')))
})

test('the tree listing is capped at twenty paths and says how many more there are', async () => {
  const many = Array.from({ length: 26 }, (_, i) => ` M src/page-${i}.html`).join('\n')
  const map = await group(checks, await ctxFor(PASSING, { exec: cleanGit({ [GIT_STATUS]: { code: 0, stdout: `${many}\n`, stderr: '' } }) }))
  const found = assertStatus(map, 'hygiene.clean-tree', 'fail', assert)
  assert.ok(found.evidence.length <= 21, `evidence was ${found.evidence.length} lines`)
  assert.match(found.detail, /26/)
})

test('unpushed commits fail, and so does a branch with no upstream at all', async () => {
  const ahead = await group(checks, await ctxFor(PASSING, { exec: cleanGit({ [GIT_AHEAD]: { code: 0, stdout: '3\n', stderr: '' } }) }))
  const found = assertStatus(ahead, 'hygiene.pushed', 'fail', assert)
  assert.match(found.detail, /3/)

  const noUpstream = await group(checks, await ctxFor(PASSING, { exec: cleanGit({ [GIT_UPSTREAM]: { code: 128, stdout: '', stderr: 'fatal: no upstream\n' } }) }))
  const missing = assertStatus(noUpstream, 'hygiene.pushed', 'fail', assert)
  assert.match(missing.detail, /upstream/)
})

test('outside a git work tree the git checks skip with a reason, and a skip is not a pass', async () => {
  const map = await group(checks, await ctxFor(PASSING, { exec: noGit() }))
  for (const id of ['hygiene.clean-tree', 'hygiene.pushed', 'hygiene.env-tracked', 'hygiene.secrets-committed']) {
    const found = assertStatus(map, id, 'skip', assert)
    assert.match(found.detail, /not a git/i)
  }
  assertStatus(map, 'hygiene.nested-git', 'pass', assert)
})

test('a nested .git below the root fails, and one under node_modules does not', async () => {
  const { dir, cleanup } = copyFixture(PASSING, 'nested')
  try {
    mkdirSync(join(dir, 'node_modules', 'vendored', '.git'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'vendored', '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const clean = await group(checks, await ctxFor(dir, { exec: cleanGit() }))
    assertStatus(clean, 'hygiene.nested-git', 'pass', assert)

    mkdirSync(join(dir, 'vendor', 'legacy', '.git'), { recursive: true })
    writeFileSync(join(dir, 'vendor', 'legacy', '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const nested = await group(checks, await ctxFor(dir, { exec: cleanGit() }))
    const found = assertStatus(nested, 'hygiene.nested-git', 'fail', assert)
    assert.ok(found.evidence.some((e) => e.value.includes('vendor/legacy/.git')))
  } finally { cleanup() }
})

test('the node version is matched against engines.node, and no engines means a skip', async () => {
  const tooOld = await group(checks, await ctxFor(FAILING, { exec: cleanGit(), env: { NODE_VERSION_OVERRIDE: 'v22.23.1' } }))
  const found = assertStatus(tooOld, 'hygiene.node-version', 'fail', assert)
  assert.match(found.detail, />=99/)

  const ok = await group(checks, await ctxFor(PASSING, { exec: cleanGit(), env: { NODE_VERSION_OVERRIDE: 'v20.11.0' } }))
  assertStatus(ok, 'hygiene.node-version', 'pass', assert)
})

test('a tracked .env fails; .env.example does not', async () => {
  const tracked = await group(checks, await ctxFor(FAILING, { exec: dirtyGit() }))
  const found = assertStatus(tracked, 'hygiene.env-tracked', 'fail', assert)
  assert.ok(found.evidence.some((e) => e.value.includes('.env')))

  const exampleOnly = await group(checks, await ctxFor(PASSING, {
    exec: cleanGit({ [GIT_FILES]: { code: 0, stdout: '.env.example\n.env.sample\npackage.json\n', stderr: '' } }),
  }))
  assertStatus(exampleOnly, 'hygiene.env-tracked', 'pass', assert)
})

test('a committed secret-shaped string fails with the file and line', async () => {
  const map = await group(checks, await ctxFor(FAILING, { exec: dirtyGit() }))
  const found = assertStatus(map, 'hygiene.secrets-committed', 'fail', assert)
  assert.ok(found.evidence.some((e) => e.type === 'file' && /src\/config\.js:\d+/.test(e.value)), JSON.stringify(found.evidence))
})

test('two different lockfiles are ambiguous and fail; none at all is advisory', async () => {
  const both = await group(checks, await ctxFor(FAILING, { exec: cleanGit() }))
  const found = assertStatus(both, 'hygiene.lockfile', 'fail', assert)
  assert.match(found.detail, /pnpm-lock\.yaml/)
  assert.match(found.detail, /yarn\.lock/)

  const { dir, cleanup } = copyFixture(PASSING, 'nolock')
  try {
    const { rmSync } = await import('node:fs')
    rmSync(join(dir, 'package-lock.json'))
    const none = await group(checks, await ctxFor(dir, { exec: cleanGit() }))
    const advisory = assertStatus(none, 'hygiene.lockfile', 'advisory', assert)
    assert.equal(advisory.severity, 'low')
  } finally { cleanup() }
})

test('files the secret scan could not read are declared, not dropped in silence', async () => {
  const { dir, cleanup } = copyFixture(PASSING, 'unscannable')
  try {
    const { writeFileSync: write } = await import('node:fs')
    // One binary file and one over the 1 MB cap: both are real bounds on what was scanned.
    write(join(dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]))
    write(join(dir, 'huge.txt'), 'x'.repeat(1024 * 1024 + 1))
    const exec = cleanGit({ [GIT_FILES]: { code: 0, stdout: 'package.json\nblob.bin\nhuge.txt\n', stderr: '' } })
    const map = await group(checks, await ctxFor(dir, { exec }))
    const found = assertStatus(map, 'hygiene.secrets-committed', 'pass', assert)
    assert.deepEqual(found.notCovered, ['hygiene.secrets-committed: 2 files skipped (over 1 MB or binary)'])
  } finally { cleanup() }
})

test('a scan that read every tracked file declares no bound at all', async () => {
  const map = await group(checks, await ctxFor(PASSING, { exec: cleanGit() }))
  assert.deepEqual(map.get('hygiene.secrets-committed').notCovered, [])
})

// The forms engines.node is actually written in, and the ones this matcher must refuse to answer
// for rather than quietly satisfy. A range it cannot read is `null`, never `true`.
test('satisfiesRange reads the ranges engines.node is written in, and refuses the ones it cannot', () => {
  const cases = [
    ['^20 || >=22', 'v22.23.1', true],
    ['20.x', 'v22.23.1', false],
    ['>=18.17.0 <21', 'v22.0.0', false],
    ['>=18.17.0 <21', 'v20.1.0', true],
    ['^20.0.0', 'v22.0.0', false],
    ['~22.1', 'v22.23.1', false],
    ['~22.1', 'v22.1.5', true],
    ['20 || 22', 'v22.23.1', true],
    ['*', 'v22.23.1', true],
    ['lts/*', 'v22.23.1', null],
  ]
  for (const [range, version, expected] of cases) {
    assert.equal(satisfiesRange(version, range), expected, `${version} against "${range}"`)
  }
})

test('every hygiene check declares itself as a pre-launch repo-tier check', () => {
  for (const check of checks) {
    assert.equal(check.phase, 'pre-launch')
    assert.equal(check.tier, 'repo')
    assert.equal(check.dimension, 'hygiene')
  }
})
