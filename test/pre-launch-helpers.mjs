// Shared scaffolding for the pre-launch gate tests.
//
// Two fixture repositories carry the whole suite: `passing-site` is a build that the gate has
// nothing to say about, and `failing-site` seeds one instance of every failure class the gate
// knows how to name. Both are real directories on disk, because the gate's subject is a
// repository and a mocked filesystem would test the mock.
//
// Git is the one input the fixtures cannot carry: a `.git` directory is not a thing git can commit
// inside a fixture, and a fixture that lives inside this repository would otherwise report this
// repository's working tree. So `exec` is injected everywhere, and `cleanGit`/`dirtyGit` below are
// the two answers a repository can give.

import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixturePath } from './helpers.mjs'

export const PASSING = fixturePath('passing-site')
export const FAILING = fixturePath('failing-site')

export const PASSING_URL = 'https://passing.test'
export const FAILING_URL = 'https://failing.test'

// A directory outside this repository, so a gate run that shells out to git finds no work tree at
// all rather than this one. `test/tmp` is inside the repo and would not do.
export function outsideRepoDir(name) {
  const dir = mkdtempSync(join(tmpdir(), `website-launch-${name}-`))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export function copyFixture(source, name) {
  const { dir, cleanup } = outsideRepoDir(name)
  const target = join(dir, name)
  cpSync(source, target, { recursive: true })
  return { dir: target, cleanup }
}

const done = (stdout = '') => ({ code: 0, stdout, stderr: '' })
const failed = (stderr, code = 1) => ({ code, stdout: '', stderr })

// An exec fake keyed by the command line it is handed. `table` maps a space-joined command to a
// result or to a function of ({cwd, env}); anything unlisted answers success with no output, which
// is what a git subcommand nobody asserted on should look like.
export function execFake(table) {
  const calls = []
  const exec = (cmd, args = [], opts = {}) => {
    const key = [cmd, ...args].join(' ')
    calls.push({ cmd, args, key, opts })
    const entry = table[key]
    if (entry === undefined) return done()
    return typeof entry === 'function' ? entry(opts) : entry
  }
  exec.calls = calls
  return exec
}

export const GIT_INSIDE = 'git rev-parse --is-inside-work-tree'
export const GIT_STATUS = 'git status --porcelain'
export const GIT_UPSTREAM = 'git rev-parse --abbrev-ref --symbolic-full-name @{u}'
export const GIT_AHEAD = 'git rev-list --count @{u}..HEAD'
export const GIT_FILES = 'git ls-files'
export const GIT_TOPLEVEL = 'git rev-parse --show-toplevel'

export function cleanGit(extra = {}) {
  return execFake({
    [GIT_INSIDE]: done('true\n'),
    [GIT_STATUS]: done(''),
    [GIT_UPSTREAM]: done('origin/main\n'),
    [GIT_AHEAD]: done('0\n'),
    [GIT_FILES]: done(['package.json', 'astro.config.mjs', 'vercel.json', 'src/index.html', '.env.example'].join('\n') + '\n'),
    [GIT_TOPLEVEL]: (opts) => done(`${opts.cwd}\n`),
    ...extra,
  })
}

export function dirtyGit(extra = {}) {
  return execFake({
    [GIT_INSIDE]: done('true\n'),
    [GIT_STATUS]: done(' M src/home.html\n?? notes.txt\n'),
    [GIT_UPSTREAM]: failed('fatal: no upstream configured for branch \'work\'\n', 128),
    [GIT_AHEAD]: failed('fatal: no upstream configured\n', 128),
    [GIT_FILES]: done(['package.json', '.env', 'src/config.js', 'src/home.html', 'vercel.json'].join('\n') + '\n'),
    [GIT_TOPLEVEL]: (opts) => done(`${opts.cwd}\n`),
    ...extra,
  })
}

export function noGit(extra = {}) {
  return execFake({
    [GIT_INSIDE]: failed('fatal: not a git repository (or any of the parent directories): .git\n', 128),
    ...extra,
  })
}

// A `net` over a flat map of url → { status, body }. Predecessor coverage is the only part of the
// gate that touches the network, and this is the whole of what it needs.
export function fakeNet(responses) {
  const miss = (url) => ({ url, finalUrl: url, status: 0, ok: false, headers: {}, body: null, chain: [], error: 'not recorded' })
  const get = async (url) => {
    const rec = responses[url]
    if (rec === undefined) return miss(url)
    return { url, finalUrl: url, status: rec.status ?? 200, ok: (rec.status ?? 200) === 200, headers: rec.headers ?? {}, body: rec.body ?? null, chain: [], error: null }
  }
  return { get, map: async (items, fn) => Promise.all(items.map((item) => fn(item))) }
}

export const byId = (results) => new Map(results.checks.map((c) => [c.id, c]))

export const statusOf = (results, id) => byId(results).get(id)?.status
