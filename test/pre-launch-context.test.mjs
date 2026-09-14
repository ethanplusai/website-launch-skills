// The gate context: everything the checks read, gathered once, with all I/O injected.
//
// The context is the only place in the gate that shells out, reads a directory or touches the
// network, which is what lets every check be a pure function of a plain object. The order it does
// that in matters in exactly one way, and there is a test for it below: the build runs before the
// build output is read, so a stale `dist` is never the thing the gate inspects.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildGateContext, createExec, detectPackageManager, normalizeOptions, resolveInBuild } from '../skills/pre-launch/scripts/lib/context.mjs'
import { PASSING, FAILING, PASSING_URL, FAILING_URL, cleanGit, dirtyGit, noGit, copyFixture, outsideRepoDir, execFake } from './pre-launch-helpers.mjs'

const options = (over = {}) => normalizeOptions({ productionUrl: PASSING_URL, skipBuild: true, ...over })

test('the package manager is read off the lockfile, and npm is the fallback', () => {
  assert.equal(detectPackageManager(PASSING), 'npm')
  assert.equal(detectPackageManager(FAILING), 'pnpm')
  const { dir, cleanup } = outsideRepoDir('pm')
  try {
    assert.equal(detectPackageManager(dir), 'npm')
    writeFileSync(join(dir, 'bun.lockb'), '')
    assert.equal(detectPackageManager(dir), 'bun')
    // pnpm, yarn and bun are asked before npm, and in that order, so a repository that somehow
    // carries two answers deterministically — and hygiene.lockfile is what reports the ambiguity.
    writeFileSync(join(dir, 'yarn.lock'), '')
    assert.equal(detectPackageManager(dir), 'yarn')
  } finally { cleanup() }
})

test('the passing fixture produces a context with its build output read in', async () => {
  const ctx = await buildGateContext({ dir: PASSING, options: options(), exec: cleanGit(), now: new Date('2026-09-14T00:00:00Z') })
  assert.equal(ctx.pm, 'npm')
  assert.equal(ctx.framework.name, 'astro')
  assert.equal(ctx.buildDirName, 'dist')
  assert.ok(ctx.files.includes('index.html'), 'index.html is in the file list')
  assert.ok(ctx.files.includes('og.png'))
  assert.equal(ctx.html.size, 5)
  assert.equal(ctx.html.get('index.html').page.head.canonical, 'https://passing.test/')
  assert.match(ctx.html.get('index.html').raw, /<title>/)
  assert.equal(ctx.prodHost, 'passing.test')
})

test('git state is collected through exec, and a missing work tree says so rather than throwing', async () => {
  const clean = await buildGateContext({ dir: PASSING, options: options(), exec: cleanGit() })
  assert.deepEqual(clean.git, { isRepo: true, dirty: [], upstream: 'origin/main', ahead: 0, tracked: clean.git.tracked })
  assert.ok(clean.git.tracked.includes('package.json'))

  const dirty = await buildGateContext({ dir: FAILING, options: options({ productionUrl: FAILING_URL }), exec: dirtyGit() })
  assert.deepEqual(dirty.git.dirty, ['src/home.html', 'notes.txt'])
  assert.equal(dirty.git.upstream, null)

  const none = await buildGateContext({ dir: PASSING, options: options(), exec: noGit() })
  assert.equal(none.git.isRepo, false)
  assert.deepEqual(none.git.tracked, [])
})

test('the build runs before the output is read, and --skip-build records why it did not', async () => {
  const { dir, cleanup } = copyFixture(PASSING, 'build-order')
  try {
    rmSync(join(dir, 'dist'), { recursive: true, force: true })
    const order = []
    const exec = execFake({
      'npm run build': () => {
        order.push('build')
        mkdirSync(join(dir, 'dist'), { recursive: true })
        writeFileSync(join(dir, 'dist', 'index.html'), '<!doctype html><html lang="en"><head><title>t</title></head><body><h1>h</h1></body></html>')
        return { code: 0, stdout: 'built\n', stderr: '' }
      },
    })
    const ctx = await buildGateContext({ dir, options: options({ skipBuild: false }), exec })
    order.push('read')
    assert.deepEqual(order, ['build', 'read'])
    assert.equal(ctx.build.code, 0)
    assert.equal(ctx.build.command, 'npm run build')
    assert.equal(ctx.build.skipped, null)
    assert.ok(ctx.files.includes('index.html'), 'the dist the build just wrote is the one that was read')
  } finally { cleanup() }
})

test('--skip-build leaves a reason on the context and never calls the package manager', async () => {
  const exec = cleanGit()
  const ctx = await buildGateContext({ dir: PASSING, options: options({ skipBuild: true }), exec })
  assert.match(ctx.build.skipped, /--skip-build/)
  assert.equal(exec.calls.some((c) => c.cmd !== 'git'), false)
})

test('the build dir is auto-detected in order, and a Next .next output is named not guessed', async () => {
  const { dir, cleanup } = outsideRepoDir('builddir')
  try {
    writeFileSync(join(dir, 'package.json'), '{}')
    mkdirSync(join(dir, 'public'), { recursive: true })
    writeFileSync(join(dir, 'public', 'logo.svg'), '<svg></svg>')
    const withoutIndex = await buildGateContext({ dir, options: options(), exec: noGit() })
    assert.equal(withoutIndex.buildDirName, null, 'public without an index.html is not a build dir')

    writeFileSync(join(dir, 'public', 'index.html'), '<!doctype html><title>x</title>')
    const withIndex = await buildGateContext({ dir, options: options(), exec: noGit() })
    assert.equal(withIndex.buildDirName, 'public')

    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(join(dir, 'dist', 'index.html'), '<!doctype html><title>x</title>')
    const preferred = await buildGateContext({ dir, options: options(), exec: noGit() })
    assert.equal(preferred.buildDirName, 'dist', 'dist wins over public')
  } finally { cleanup() }
})

test('an explicit --build-dir is used verbatim', async () => {
  const ctx = await buildGateContext({ dir: PASSING, options: options({ buildDir: 'dist' }), exec: noGit() })
  assert.equal(ctx.buildDirName, 'dist')
})

test('resolveInBuild maps a root path onto the file that would serve it', async () => {
  const ctx = await buildGateContext({ dir: PASSING, options: options(), exec: noGit() })
  assert.equal(resolveInBuild(ctx, '/'), 'index.html')
  assert.equal(resolveInBuild(ctx, '/about'), 'about.html')
  assert.equal(resolveInBuild(ctx, '/og.png'), 'og.png')
  assert.equal(resolveInBuild(ctx, '/about?x=1#top'), 'about.html')
  assert.equal(resolveInBuild(ctx, '/nope'), null)
})

test('createExec never throws: a non-zero command comes back as a code', () => {
  const exec = createExec()
  const ok = exec(process.execPath, ['-e', 'process.stdout.write("hi")'])
  assert.equal(ok.code, 0)
  assert.equal(ok.stdout, 'hi')
  const bad = exec(process.execPath, ['-e', 'process.stderr.write("boom");process.exit(3)'])
  assert.equal(bad.code, 3)
  assert.match(bad.stderr, /boom/)
  const missing = exec('definitely-not-a-command-abc123', [])
  assert.notEqual(missing.code, 0)
})

test('env names come from the process env and from .env files on disk', async () => {
  const { dir, cleanup } = copyFixture(PASSING, 'envnames')
  try {
    writeFileSync(join(dir, '.env.production'), '# a comment\nPUBLIC_API_BASE=https://api.passing.test\nEMPTY=\n')
    const ctx = await buildGateContext({ dir, options: options(), exec: noGit(), env: { FROM_PROCESS: '1' } })
    assert.ok(ctx.envNames.has('PUBLIC_API_BASE'))
    assert.ok(ctx.envNames.has('FROM_PROCESS'))
    assert.equal(ctx.envNames.has('EMPTY'), false, 'a name with no value is not defined')
  } finally { cleanup() }
})
