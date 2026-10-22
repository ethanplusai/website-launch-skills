// Group 1 — repo hygiene: is the thing you are about to deploy the thing you think it is?
//
// None of these look at the website. They look at the repository, because a build made from a
// working tree nobody committed, on a branch nobody pushed, with a `.env` in git history, is a
// launch that cannot be reproduced and a secret that cannot be un-published.
//
// Every git fact arrives through `ctx.git`, which the context gathered through the injected
// `exec`. Outside a work tree the four git-dependent checks skip with a reason rather than
// reporting a clean repository, because a skip is not a pass.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { defineCheck, SkipCheck } from '../../../launch-audit/scripts/lib/registry.mjs'
import { SECRETS, scanText } from '../../../launch-audit/scripts/lib/detect/placeholders.mjs'
import { isIgnoredPath, lockfilesIn } from './context.mjs'

const PHASE = 'pre-launch'
const DIMENSION = 'hygiene'
const check = (def) => defineCheck({ phase: PHASE, dimension: DIMENSION, tier: 'repo', severity: 'blocker', ...def })

const NOT_A_REPO = 'this directory is not a git repository, so git could not be asked'
const MAX_LISTED = 20

const file = (value) => ({ type: 'file', value })
const text = (value) => ({ type: 'text', value })

// Up to twenty paths as evidence. A working tree with two hundred uncommitted files is one
// problem, and printing two hundred lines about it buries the other thirty-seven checks.
const listed = (paths, toEvidence) => paths.slice(0, MAX_LISTED).map(toEvidence)

// ------------------------------------------------------------------------------- semver ranges

const parseVersion = (input) => {
  const found = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(input ?? ''))
  if (found === null) return null
  return [Number(found[1]), Number(found[2] ?? 0), Number(found[3] ?? 0)]
}

const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

// The upper bound `^` implies: the next major, except below 1.0.0 where the minor is the
// breaking-change position.
const caretCeiling = (parts) => (parts[0] === 0 ? [0, parts[1] + 1, 0] : [parts[0] + 1, 0, 0])

// A deliberately small range matcher for the forms `engines.node` is actually written in: `>=20`,
// `^20.11.0`, `~20.11`, `20.x`, `18 || 20 || 22`, and a bare `20.11.0`. A range it cannot read
// answers `null` rather than `true`: a range this does not understand is not a range it may
// declare satisfied, and the check reports that as its own finding.
export function satisfiesRange(version, range) {
  const current = parseVersion(version)
  if (current === null) return null
  const clauses = String(range).split('||').map((c) => c.trim()).filter((c) => c !== '')
  if (clauses.length === 0) return null

  let readable = false
  for (const clause of clauses) {
    const comparators = clause.split(/[\s,]+/).filter((c) => c !== '')
    let all = true
    let clauseReadable = true
    for (const comparator of comparators) {
      const found = /^(>=|<=|>|<|=|\^|~)?\s*v?(.+)$/.exec(comparator)
      if (found === null) { clauseReadable = false; break }
      const operator = found[1] ?? '='
      const raw = found[2]
      if (raw === '*' || raw === 'x') continue
      if (!/^\d+(\.(\d+|x|\*))?(\.(\d+|x|\*))?$/i.test(raw)) { clauseReadable = false; break }
      const target = parseVersion(raw)
      if (target === null) { clauseReadable = false; break }

      if (operator === '>=') { if (compare(current, target) < 0) all = false; continue }
      if (operator === '>') { if (compare(current, target) <= 0) all = false; continue }
      if (operator === '<=') { if (compare(current, target) > 0) all = false; continue }
      if (operator === '<') { if (compare(current, target) >= 0) all = false; continue }
      if (operator === '^') {
        if (compare(current, target) < 0 || compare(current, caretCeiling(target)) >= 0) all = false
        continue
      }
      if (operator === '~') {
        if (compare(current, target) < 0 || compare(current, [target[0], target[1] + 1, 0]) >= 0) all = false
        continue
      }
      // `=` or no operator. A bare `20` or a `20.x` is a range over everything that major covers;
      // a full `20.11.0` is the one version it names.
      const segments = raw.split('.')
      const fixed = segments.filter((s) => !/^(x|\*)$/i.test(s)).length
      if (fixed === segments.length && segments.length === 3) {
        if (compare(current, target) !== 0) all = false
        continue
      }
      const upper = fixed <= 1 ? [target[0] + 1, 0, 0] : [target[0], target[1] + 1, 0]
      if (compare(current, target) < 0 || compare(current, upper) >= 0) all = false
    }
    if (!clauseReadable) continue
    readable = true
    if (all) return true
  }
  return readable ? false : null
}

// ------------------------------------------------------------------------------- nested git dirs

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '_site', '.next', '.output'])
const MAX_DEPTH = 6

// Every directory named `.git` below the root, excluding the root's own and anything vendored.
// A nested repository is a directory whose contents the outer repository does not actually track,
// which means what you deploy and what you pushed are two different things. `ignoreDirs` are the
// folders the operator named with --ignore-dir, as paths relative to the root.
export function nestedGitDirs(root, { ignoreDirs = [] } = {}) {
  const found = []
  const visit = (dir, depth) => {
    if (depth > MAX_DEPTH) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = join(dir, entry.name)
      if (entry.name === '.git') {
        if (dir !== root) found.push(relative(root, full).split(sep).join('/'))
        continue
      }
      if (SKIP_DIRS.has(entry.name)) continue
      if (isIgnoredPath(relative(root, full).split(sep).join('/'), ignoreDirs)) continue
      visit(full, depth + 1)
    }
  }
  visit(root, 0)
  return found.sort()
}

// ------------------------------------------------------------------------------------ the checks

const ENV_FILE = /(^|\/)\.env(\..+)?$/
const ENV_ALLOWED = /(^|\/)\.env\.(example|sample|template)$/

const LOCKFILE_NAMES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'npm-shrinkwrap.json'])
const MAX_SCAN_BYTES = 1024 * 1024
const NUL = String.fromCharCode(0)

// git answers about the whole repository, whatever directory it was asked from, and the paths in
// `git status` start at the repository root. When --dir is a subdirectory of one — an app inside a
// monorepo, or a fixture inside a tool's own checkout — a reader handed `README.md` will look for
// it under --dir, not find it, and stop believing the line. So the findings that report
// repository-wide facts say which repository, and where its root is from here.
function repoScope(ctx) {
  const root = ctx.git.root
  if (typeof root !== 'string' || root === '') return []
  if (resolve(root) === resolve(ctx.dir)) return []
  const up = relative(ctx.dir, root).split(sep).join('/')
  return [text(`answered by the repository rooted at ${up === '' ? '.' : up}, relative to --dir; these paths start at that root`)]
}

const cleanTree = check({
  id: 'hygiene.clean-tree',
  title: 'Uncommitted changes in the working tree',
  catches: 'a build made from files that are in no commit, so the deploy cannot be reproduced',
  run(ctx) {
    if (!ctx.git.isRepo) throw new SkipCheck(NOT_A_REPO)
    if (ctx.git.dirty.length === 0) return []
    return [this.mk({
      title: 'Uncommitted changes in the working tree',
      detail: `${ctx.git.dirty.length} path${ctx.git.dirty.length === 1 ? '' : 's'} differ from HEAD, so what is about to be deployed is in no commit`,
      evidence: [...listed(ctx.git.dirty, file), ...repoScope(ctx)],
      fix: 'Commit or stash every change, then build and run the gate again.',
    })]
  },
})

const pushed = check({
  id: 'hygiene.pushed',
  title: 'HEAD is not pushed to its upstream',
  catches: 'a deploy from a commit that exists on one machine only, which nobody else can roll back to',
  run(ctx) {
    if (!ctx.git.isRepo) throw new SkipCheck(NOT_A_REPO)
    if (ctx.git.upstream === null) {
      return [this.mk({
        title: 'The current branch has no upstream',
        detail: 'this branch has no upstream, so the commit being deployed exists on this machine only',
        evidence: [text('git rev-parse --abbrev-ref --symbolic-full-name @{u} reported no upstream'), ...repoScope(ctx)],
        fix: 'Push the branch and set its upstream (git push -u <remote> <branch>), then run the gate again.',
      })]
    }
    if ((ctx.git.ahead ?? 0) === 0) return []
    return [this.mk({
      title: 'Commits on HEAD are not pushed',
      detail: `${ctx.git.ahead} commit${ctx.git.ahead === 1 ? '' : 's'} ahead of ${ctx.git.upstream}`,
      evidence: [text(`git rev-list --count @{u}..HEAD = ${ctx.git.ahead}`), ...repoScope(ctx)],
      fix: 'Push the branch, then run the gate again.',
    })]
  },
})

const nestedGit = check({
  id: 'hygiene.nested-git',
  title: 'A nested git repository below the root',
  catches: 'a directory whose contents the outer repository does not track and a deploy therefore cannot carry',
  run(ctx) {
    const nested = nestedGitDirs(ctx.dir, { ignoreDirs: ctx.config.ignoreDirs })
    if (nested.length === 0) return []
    return [this.mk({
      title: 'A nested git repository below the root',
      detail: `${nested.length} nested repositor${nested.length === 1 ? 'y' : 'ies'} found; their contents are not tracked by this repository`,
      evidence: listed(nested, file),
      fix: 'Remove the nested .git, or make the directory a submodule the outer repository records.',
    })]
  },
})

const nodeVersion = check({
  id: 'hygiene.node-version',
  title: 'The running Node does not satisfy engines.node',
  catches: 'a local build on a Node the host will not use, which is how a build passes here and fails in CI',
  run(ctx) {
    const range = ctx.pkg?.engines?.node
    if (typeof range !== 'string' || range.trim() === '') {
      throw new SkipCheck('package.json declares no engines.node, so there is no range to check against')
    }
    const ok = satisfiesRange(ctx.nodeVersion, range)
    if (ok === null) {
      return [this.mk({
        severity: 'low',
        title: 'engines.node could not be read',
        detail: `"${range}" is not a range this gate knows how to evaluate, so the running Node ${ctx.nodeVersion} was not checked against it`,
        evidence: [text(`engines.node = ${range}`), text(`running ${ctx.nodeVersion}`)],
        fix: 'Write the range with >=, ^, ~, x or a plain version, or confirm the host Node by hand.',
      })]
    }
    if (ok) return []
    return [this.mk({
      title: 'The running Node does not satisfy engines.node',
      detail: `package.json requires ${range} and this build ran on ${ctx.nodeVersion}`,
      evidence: [text(`engines.node = ${range}`), text(`running ${ctx.nodeVersion}`)],
      fix: 'Build on a Node that satisfies the range, or correct the range if it is out of date.',
    })]
  },
})

const envTracked = check({
  id: 'hygiene.env-tracked',
  title: 'An environment file is tracked by git',
  catches: 'real credentials committed to history, where rotating them is the only remedy',
  run(ctx) {
    if (!ctx.git.isRepo) throw new SkipCheck(NOT_A_REPO)
    const tracked = ctx.git.tracked.filter((path) => ENV_FILE.test(path) && !ENV_ALLOWED.test(path))
    if (tracked.length === 0) return []
    return [this.mk({
      title: 'An environment file is tracked by git',
      detail: `${tracked.length} .env file${tracked.length === 1 ? ' is' : 's are'} in the index; whatever they hold is in this repository's history`,
      evidence: listed(tracked, file),
      fix: 'git rm --cached the file, add it to .gitignore, rotate every credential it held, and keep a .env.example instead.',
    })]
  },
})

const secretsCommitted = check({
  id: 'hygiene.secrets-committed',
  title: 'A secret-shaped string is committed',
  catches: 'an API key, token or private key published in the repository',
  run(ctx) {
    if (!ctx.git.isRepo) throw new SkipCheck(NOT_A_REPO)
    const hits = []
    // A file this scan never opened is a file it cannot vouch for. The bound is real — a 4 MB
    // bundle or a binary asset is not worth reading for a regex — so it is declared rather than
    // hidden.
    let unscanned = 0
    for (const rel of ctx.git.tracked) {
      const name = rel.split('/').pop()
      if (LOCKFILE_NAMES.has(name) || rel.includes('node_modules/')) continue
      if (isIgnoredPath(rel, ctx.config.ignoreDirs)) continue
      const full = join(ctx.dir, rel)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (!stat.isFile()) continue
      if (stat.size > MAX_SCAN_BYTES) { unscanned++; continue }
      let body
      try {
        body = readFileSync(full, 'utf8')
      } catch {
        unscanned++
        continue
      }
      if (body.includes(NUL)) { unscanned++; continue }
      for (const hit of scanText(body, SECRETS)) {
        const line = body.slice(0, hit.index).split('\n').length
        hits.push(`${rel}:${line} — a ${hit.match.slice(0, 4)} credential`)
      }
    }
    const notCovered = unscanned > 0
      ? [`hygiene.secrets-committed: ${unscanned} files skipped (over 1 MB or binary)`]
      : []
    if (hits.length === 0) return { findings: [], notCovered }
    return {
      notCovered,
      findings: [this.mk({
        title: 'A secret-shaped string is committed',
        detail: `${hits.length} secret-shaped string${hits.length === 1 ? '' : 's'} in tracked files`,
        evidence: listed(hits, file),
        fix: 'Rotate every credential named here first, then remove it from the working tree and from history.',
      })],
    }
  },
})

const lockfile = check({
  id: 'hygiene.lockfile',
  title: 'The lockfiles do not name one package manager',
  catches: 'two lockfiles disagreeing about versions, so the host installs something nobody tested',
  run(ctx) {
    const found = lockfilesIn(ctx.dir).map(([name]) => name)
    if (found.length === 1) return []
    if (found.length === 0) {
      return [this.mk({
        severity: 'low',
        title: 'No lockfile in the repository',
        detail: 'without a lockfile the host resolves dependency versions itself, so the deployed build is not the build that was tested',
        evidence: [text(`no lockfile found; ${ctx.pm} would be used by default`)],
        fix: `Run ${ctx.pm} install and commit the lockfile it writes.`,
      })]
    }
    return [this.mk({
      title: 'More than one lockfile',
      detail: `${found.join(' and ')} both exist, so which package manager the host uses is a coin toss; ${ctx.pm} was assumed here`,
      evidence: found.map(file),
      fix: 'Delete every lockfile but the one for the package manager the host actually runs, and commit the deletion.',
    })]
  },
})

export const checks = [cleanTree, pushed, nestedGit, nodeVersion, envTracked, secretsCommitted, lockfile]
