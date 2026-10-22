// The gate context: one pass of I/O, then thirty-eight pure checks over a plain object.
//
// Everything the gate learns about a repository is gathered here — the package manifest, the
// package manager, the framework, the git state, the redirect rules, the build, the build output,
// the environment, and the predecessor's live sitemap. Nothing below this file shells out, reads a
// directory or opens a socket, which is what makes every check testable against a fixture and an
// injected `exec`.
//
// One ordering in here is load-bearing and is asserted by a test: **the build runs before the
// build output is read.** A gate that inspected a `dist` written three commits ago would pass a
// site nobody is about to deploy, which is the exact failure the gate exists to prevent.
//
// The adapters:
//
//   exec(cmd, args, { cwd, env }) → { code, stdout, stderr }   never throws
//   net.get(url) → { status, body, … }                          only the predecessor uses it
//
// `createExec` is the real one. It returns a non-zero `code` where a shell would, instead of
// throwing, because "the build failed" is a finding and a stack trace is not.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'

import { walk } from '../../../launch-audit/scripts/lib/fs-util.mjs'
import { parseHtml } from '../../../launch-audit/scripts/lib/html.mjs'
import { parseRobots } from '../../../launch-audit/scripts/lib/robots.mjs'
import { discoverSitemaps, expandSitemap } from '../../../launch-audit/scripts/lib/sitemap.mjs'
import { detectFramework, parseRedirects } from '../../../launch-audit/scripts/lib/detect/framework.mjs'

const MAX_BUFFER = 16 * 1024 * 1024

export function createExec() {
  return function exec(cmd, args = [], { cwd, env } = {}) {
    try {
      const stdout = execFileSync(cmd, args, {
        cwd, env: env ?? process.env, encoding: 'utf8', maxBuffer: MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { code: 0, stdout: stdout ?? '', stderr: '' }
    } catch (error) {
      const code = typeof error?.status === 'number' ? error.status : 1
      const stderr = error?.stderr === undefined || error.stderr === null ? (error?.message ?? '') : String(error.stderr)
      return { code, stdout: error?.stdout === undefined || error.stdout === null ? '' : String(error.stdout), stderr }
    }
  }
}

// ------------------------------------------------------------------------------------- options

// `--ignore-dir` names folders relative to --dir, written however a person types them (`capture`,
// `./capture/`, `docs\capture`, `capture//raw`). They are compared as normalised forward-slash
// paths with no leading `./` and no trailing slash, and one that climbs out of --dir is dropped, so `capture` means the top-level `capture/` and nothing else: a folder called
// `capture` somewhere under `src/` is still scanned unless it is named by its own path.
export function normalizeIgnoreDirs(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const entry of raw) {
    const raw = String(entry).trim().split('\\').join('/')
    if (raw === '') continue
    const path = posix.normalize(raw).replace(/^(\.\/)+/, '').replace(/\/+$/, '')
    if (path === '' || path === '.' || path === '..' || path.startsWith('../') || path.startsWith('/')) continue
    if (!out.includes(path)) out.push(path)
  }
  return out
}

// Whether a path relative to --dir is inside one of the ignored folders. Only the repository scans
// ask this; nothing asks it of the build output, which is what deploys.
export const isIgnoredPath = (rel, ignoreDirs) =>
  ignoreDirs.some((dir) => rel === dir || rel.startsWith(`${dir}/`))

// The build folder is what deploys, and `hygiene.secrets-committed` is the only check that looks
// for credentials in it when it is committed (`public/` for Hugo or GitHub Pages). An ignored
// folder that is the build folder, holds it, or sits inside it would switch that scan off for the
// very files that ship, so it is refused outright rather than reported.
export function assertIgnoreClearOfBuild(ignoreDirs, buildDirName) {
  if (buildDirName === null || buildDirName === undefined) return
  const [build] = normalizeIgnoreDirs([buildDirName])
  if (build === undefined) return
  for (const dir of ignoreDirs) {
    if (isIgnoredPath(build, [dir]) || isIgnoredPath(dir, [build])) {
      throw new Error(`--ignore-dir ${dir} overlaps the build folder ${build}; the build output is what deploys and is always scanned`)
    }
  }
}

export function normalizeOptions(raw = {}) {
  return {
    productionUrl: raw.productionUrl ?? null,
    predecessorUrl: raw.predecessorUrl ?? null,
    buildDir: raw.buildDir ?? null,
    requiredEnv: Array.isArray(raw.requiredEnv) ? raw.requiredEnv : [],
    devHosts: Array.isArray(raw.devHosts) ? raw.devHosts : [],
    ignoreDirs: normalizeIgnoreDirs(raw.ignoreDirs),
    strict: raw.strict === true,
    skipBuild: raw.skipBuild === true,
    out: raw.out ?? null,
  }
}

// ------------------------------------------------------------------------------ package manager

// Lockfile → package manager, in the order a repository that somehow has two should be read: the
// more specific tools first, npm as the fallback every Node repository answers to. `hygiene.lockfile`
// is the check that notices when there is more than one.
export const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
]

export function lockfilesIn(dir) {
  return LOCKFILES.filter(([name]) => existsSync(join(dir, name)))
}

export function detectPackageManager(dir) {
  const found = lockfilesIn(dir)
  return found.length === 0 ? 'npm' : found[0][1]
}

// ------------------------------------------------------------------------------------ the build

export const BUILD_DIR_ORDER = ['dist', 'out', 'build', '_site', 'public', '.next']

export const NEXT_OUTPUT_NOTE =
  'Next.js .next output is not static HTML; pass --build-dir out after next export, or treat results as advisory'

const isDir = (path) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// `public` is the one candidate that is routinely a *source* directory rather than a build output,
// so it only counts when it holds an index.html — which is what distinguishes "this is what the
// generator wrote" from "this is what the generator copies".
function looksLikeBuildDir(dir, name) {
  const full = join(dir, name)
  if (!isDir(full)) return false
  if (name === 'public') return existsSync(join(full, 'index.html'))
  return true
}

export function resolveBuildDir(dir, options, framework) {
  if (options.buildDir) {
    return { name: options.buildDir, note: null }
  }
  for (const name of BUILD_DIR_ORDER) {
    if (!looksLikeBuildDir(dir, name)) continue
    return { name, note: name === '.next' ? NEXT_OUTPUT_NOTE : null }
  }
  const guess = framework?.buildDirGuess
  if (guess && isDir(join(dir, guess))) return { name: guess, note: null }
  return { name: null, note: null }
}

// ------------------------------------------------------------------------------------ git state

const lines = (text) => String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '')

// Porcelain v1: two status columns, a space, then the path. A rename is `XY old -> new`, and the
// path the reader cares about is the new one.
function porcelainPaths(stdout) {
  return String(stdout ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const path = line.slice(3).trim()
      const arrow = path.indexOf(' -> ')
      return arrow === -1 ? path : path.slice(arrow + 4)
    })
    .map((path) => path.replace(/^"|"$/g, ''))
}

export function gitState(exec, dir) {
  const run = (...args) => exec('git', args, { cwd: dir })
  const inside = run('rev-parse', '--is-inside-work-tree')
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return { isRepo: false, root: null, dirty: [], upstream: null, ahead: null, tracked: [] }
  }
  const status = run('status', '--porcelain')
  const upstream = run('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
  const ahead = upstream.code === 0 ? run('rev-list', '--count', '@{u}..HEAD') : null
  const tracked = run('ls-files')
  // Which repository answered. `git status` reports the whole repository whatever directory it was
  // asked from, and its paths are relative to this root — not to --dir. Gating an app inside a
  // monorepo is a normal thing to do, and the findings have to say where their paths start.
  const top = run('rev-parse', '--show-toplevel')
  return {
    isRepo: true,
    root: top.code === 0 && top.stdout.trim() !== '' ? top.stdout.trim() : null,
    dirty: porcelainPaths(status.stdout),
    upstream: upstream.code === 0 ? upstream.stdout.trim() : null,
    ahead: ahead !== null && ahead.code === 0 ? Number(ahead.stdout.trim()) : null,
    tracked: tracked.code === 0 ? lines(tracked.stdout) : [],
  }
}

// ------------------------------------------------------------------------------------ the paths

// A url path, normalised the way the gate compares them: leading slash, no query, no fragment, no
// trailing slash except at the root. `/about/`, `/about?x=1` and `/about` are one path here,
// because they are one page to everybody except a redirect rule.
export function normalizePath(input) {
  let path = String(input ?? '')
  const cut = path.search(/[?#]/)
  if (cut !== -1) path = path.slice(0, cut)
  try {
    path = decodeURIComponent(path)
  } catch {
    // a malformed escape stays as written; it is still a path somebody typed
  }
  if (!path.startsWith('/')) path = `/${path}`
  path = path.replace(/\/{2,}/g, '/')
  if (path.length > 1) path = path.replace(/\/+$/, '')
  return path === '' ? '/' : path
}

// The url path a build file is served at: `index.html` is the root, `x/index.html` is `/x`, and a
// flat `about.html` is `/about` — which is what a host with clean urls serves, and what a sitemap
// written by the generator will say.
export function pageUrlPath(rel) {
  const posix = rel.split(sep).join('/')
  if (posix === 'index.html') return '/'
  if (posix.endsWith('/index.html')) return normalizePath(`/${posix.slice(0, -'/index.html'.length)}`)
  if (posix.endsWith('.html')) return normalizePath(`/${posix.slice(0, -'.html'.length)}`)
  return normalizePath(`/${posix}`)
}

// The build file that would serve a root-relative path, or null. The four candidate spellings are
// the ones every static host tries, in the order they try them.
export function resolveInBuild(ctx, path) {
  const clean = normalizePath(path)
  if (clean === '/') return ctx.fileSet.has('index.html') ? 'index.html' : null
  const bare = clean.slice(1)
  for (const candidate of [bare, `${bare}.html`, `${bare}/index.html`, `${bare}/index.htm`]) {
    if (ctx.fileSet.has(candidate)) return candidate
  }
  return null
}

// --------------------------------------------------------------------------------- environment

const ENV_FILES = ['.env.production', '.env']

// Names that are actually defined: a `KEY=` with nothing after it is a name somebody wrote down,
// not a value the build can use, and treating it as set is how an empty interpolation ships.
export function definedEnvNames(dir, env) {
  const names = new Set()
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value === 'string' && value.trim() !== '') names.add(key)
  }
  for (const file of ENV_FILES) {
    const full = join(dir, file)
    if (!existsSync(full)) continue
    let text
    try {
      text = readFileSync(full, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const name = trimmed.slice(0, eq).replace(/^export\s+/, '').trim()
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
      if (value !== '') names.add(name)
    }
  }
  return names
}

// --------------------------------------------------------------------------------- predecessor

// The live sitemap of the site being replaced, expanded one level. This is the only network the
// gate touches, and it fails closed: a child sitemap that will not fetch or will not parse is
// recorded as an error, and `predecessor.coverage` turns that into a failure rather than reporting
// coverage of the pages it did manage to read.
export async function fetchPredecessor(net, predecessorUrl) {
  const result = { url: predecessorUrl, origin: null, paths: [], sitemaps: [], errors: [] }
  if (net === null || net === undefined) {
    result.errors.push('no network adapter was supplied to this run')
    return result
  }
  let origin
  try {
    origin = new URL(predecessorUrl).origin
  } catch {
    result.errors.push(`--predecessor-url is not a url: ${predecessorUrl}`)
    return result
  }
  result.origin = origin

  let robots = { sitemaps: [] }
  const robotsResponse = await net.get(new URL('/robots.txt', origin).href)
  if (robotsResponse.status === 200 && typeof robotsResponse.body === 'string') {
    robots = parseRobots(robotsResponse.body)
  }

  const { found } = await discoverSitemaps(net, origin, robots)
  if (found.length === 0) {
    result.errors.push(`no sitemap could be fetched from ${origin} (tried robots.txt and the conventional paths)`)
    return result
  }

  const seen = new Set()
  for (const sitemap of found) {
    result.sitemaps.push(sitemap.url)
    const expanded = await expandSitemap(net, sitemap.url)
    for (const error of expanded.errors) result.errors.push(error)
    for (const entry of expanded.urls) {
      let path
      try {
        const parsed = new URL(entry.loc)
        if (parsed.origin !== origin) continue
        path = normalizePath(parsed.pathname)
      } catch {
        continue
      }
      if (seen.has(path)) continue
      seen.add(path)
      result.paths.push(path)
    }
  }
  result.paths.sort()
  return result
}

// ------------------------------------------------------------------------------------ the build

function runBuild({ dir, pm, options, exec }) {
  if (options.skipBuild) {
    return {
      skipped: '--skip-build was passed, so the build did not run and the output on disk may be stale',
      command: null, code: null, stdout: '', stderr: '',
    }
  }
  const command = `${pm} run build`
  const result = exec(pm, ['run', 'build'], { cwd: dir })
  return { skipped: null, command, code: result.code, stdout: result.stdout, stderr: result.stderr }
}

// ------------------------------------------------------------------------------------ the context

const readJsonOr = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

const TEXT_BUILD_EXTENSIONS = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.css', '.json', '.txt', '.xml', '.svg', '.webmanifest', '.map'])

const extensionOf = (name) => {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot).toLowerCase()
}

export async function buildGateContext({ dir, options: rawOptions, exec, net = null, now = new Date(), env = process.env } = {}) {
  const config = normalizeOptions(rawOptions)
  if (!isDir(dir)) throw new Error(`--dir is not a directory: ${dir}`)
  if (!config.productionUrl) throw new Error('--production-url is required')

  let prodUrl
  try {
    prodUrl = new URL(config.productionUrl)
  } catch {
    throw new Error(`--production-url is not a url: ${config.productionUrl}`)
  }

  const pkg = readJsonOr(join(dir, 'package.json'), {})
  const pm = detectPackageManager(dir)
  const framework = detectFramework(dir, pkg)
  const redirects = parseRedirects(dir)
  const git = gitState(exec, dir)

  // Refused before the build runs, against whatever build folder can already be named, and again
  // after it, against the one the build actually wrote.
  assertIgnoreClearOfBuild(config.ignoreDirs, config.buildDir ?? resolveBuildDir(dir, config, framework).name ?? framework?.buildDirGuess ?? null)

  // The build first, then the output it wrote. Reversing these two lines is how a gate starts
  // passing a stale dist.
  const build = runBuild({ dir, pm, options: config, exec })

  const { name: buildDirName, note: buildDirNote } = resolveBuildDir(dir, config, framework)
  const buildDir = buildDirName === null ? null : join(dir, buildDirName)
  assertIgnoreClearOfBuild(config.ignoreDirs, buildDirName)

  const files = []
  const html = new Map()
  if (buildDir !== null && buildDirNote === null && isDir(buildDir)) {
    for (const full of walk(buildDir)) {
      files.push(relative(buildDir, full).split(sep).join('/'))
    }
    files.sort()
    for (const rel of files) {
      if (!rel.endsWith('.html') && !rel.endsWith('.htm')) continue
      let raw
      try {
        raw = readFileSync(join(buildDir, rel), 'utf8')
      } catch {
        continue
      }
      const base = new URL(pageUrlPath(rel), prodUrl.origin).href
      html.set(rel, { page: parseHtml(raw, base), raw, url: base, path: pageUrlPath(rel) })
    }
  }

  const predecessor = config.predecessorUrl
    ? await fetchPredecessor(net, config.predecessorUrl)
    : null

  return {
    dir,
    config,
    pkg,
    pm,
    framework,
    redirects,
    git,
    build,
    buildDir,
    buildDirName,
    buildDirNote,
    files,
    fileSet: new Set(files),
    html,
    env,
    envNames: definedEnvNames(dir, env),
    nodeVersion: env?.NODE_VERSION_OVERRIDE ?? process.version,
    predecessor,
    net,
    now: now instanceof Date ? now : new Date(now),
    prodUrl: prodUrl.href,
    prodOrigin: prodUrl.origin,
    prodHost: prodUrl.hostname,
    isTextBuildFile: (rel) => TEXT_BUILD_EXTENSIONS.has(extensionOf(rel)),
  }
}
