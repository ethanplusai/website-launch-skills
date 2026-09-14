// The build, and the directory it was supposed to produce.
//
// These two checks are the hinge of the gate: everything in the `output` group reads files that
// only exist because the build wrote them, so a build that failed and a build directory that is
// not there have to be reported as themselves rather than as forty missing-file findings.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checks } from '../skills/pre-launch/scripts/lib/build.mjs'
import { PASSING, copyFixture, execFake, outsideRepoDir } from './pre-launch-helpers.mjs'
import { ctxFor, group, assertStatus } from './pre-launch-check-helpers.mjs'

test('a build that exits 0 passes and a build dir with an index.html is found', async () => {
  const { dir, cleanup } = copyFixture(PASSING, 'build-ok')
  try {
    const exec = execFake({ 'npm run build': { code: 0, stdout: 'built in 1.2s\n', stderr: '' } })
    const map = await group(checks, await ctxFor(dir, { exec, skipBuild: false }))
    assertStatus(map, 'build.succeeds', 'pass', assert)
    assertStatus(map, 'build.dir-found', 'pass', assert)
  } finally { cleanup() }
})

test('a failing build fails the gate, with the tail of stderr as evidence', async () => {
  const { dir, cleanup } = copyFixture(PASSING, 'build-bad')
  try {
    const stderr = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')
    const exec = execFake({ 'npm run build': { code: 1, stdout: '', stderr } })
    const map = await group(checks, await ctxFor(dir, { exec, skipBuild: false }))
    const found = assertStatus(map, 'build.succeeds', 'fail', assert)
    assert.match(found.detail, /exit(ed)? 1/i)
    const tail = found.evidence.map((e) => e.value).join('\n')
    assert.match(tail, /line 59/)
    assert.equal(/line 0\b/.test(tail), false, 'only the tail of stderr is quoted')
  } finally { cleanup() }
})

test('--skip-build skips the build check with the reason, and never reads as a pass', async () => {
  const map = await group(checks, await ctxFor(PASSING))
  const found = assertStatus(map, 'build.succeeds', 'skip', assert)
  assert.match(found.detail, /--skip-build/)
})

test('the package manager the lockfile names is the one the build is run with', async () => {
  const { dir, cleanup } = copyFixture(PASSING, 'build-pm')
  try {
    rmSync(join(dir, 'package-lock.json'))
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n')
    const exec = execFake({ 'pnpm run build': { code: 0, stdout: '', stderr: '' } })
    const map = await group(checks, await ctxFor(dir, { exec, skipBuild: false }))
    assertStatus(map, 'build.succeeds', 'pass', assert)
    assert.ok(exec.calls.some((c) => c.key === 'pnpm run build'), 'pnpm was the command')
  } finally { cleanup() }
})

test('no build directory at all fails rather than skipping every output check silently', async () => {
  const { dir, cleanup } = outsideRepoDir('nodist')
  try {
    writeFileSync(join(dir, 'package.json'), '{}')
    const map = await group(checks, await ctxFor(dir))
    const found = assertStatus(map, 'build.dir-found', 'fail', assert)
    assert.match(found.detail, /dist/)
  } finally { cleanup() }
})

test('a build dir with no index.html at its root fails', async () => {
  const { dir, cleanup } = outsideRepoDir('noindex')
  try {
    writeFileSync(join(dir, 'package.json'), '{}')
    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, 'dist', 'home.html'), '<!doctype html><title>x</title>')
    const map = await group(checks, await ctxFor(dir))
    const found = assertStatus(map, 'build.dir-found', 'fail', assert)
    assert.match(found.detail, /index\.html/)
  } finally { cleanup() }
})

test('a Next .next directory is skipped with the instruction, not audited as static HTML', async () => {
  const { dir, cleanup } = outsideRepoDir('nextout')
  try {
    writeFileSync(join(dir, 'package.json'), '{"dependencies":{"next":"^15"}}')
    writeFileSync(join(dir, 'next.config.mjs'), 'export default {}\n')
    mkdirSync(join(dir, '.next'))
    writeFileSync(join(dir, '.next', 'BUILD_ID'), 'abc\n')
    const map = await group(checks, await ctxFor(dir))
    const found = assertStatus(map, 'build.dir-found', 'skip', assert)
    assert.match(found.detail, /--build-dir out/)
  } finally { cleanup() }
})
