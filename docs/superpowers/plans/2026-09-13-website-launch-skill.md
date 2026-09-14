# website-launch-skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three verify-only Agent Skills — `pre-launch` (gate), `launch-audit` (auditor), `post-launch` (watch) — sharing one zero-dependency Node engine, with fixture-driven tests, a generated check inventory, and install paths for any agent.

**Architecture:** Ports-and-adapters. All pure logic (parsing, checks, findings, reports, diffs) is unit-tested against fixtures; all I/O sits behind two injectable adapters (`net.mjs` for HTTP/TLS/DNS, `browser.mjs` for the optional Playwright tier). Every check is a registered object `{id, phase, dimension, severity, tier, title, run}`; the registry is the single source for `docs/checks.md`. The three scripts are thin orchestrators over the engine.

**Tech Stack:** Node ≥ 20 (built-in `fetch`, `node:test`, `node:tls`, `node:dns`, `node:crypto`). Zero npm dependencies. Playwright optional at runtime, never in tests.

**Spec:** `docs/superpowers/specs/2026-09-13-website-launch-skill-design.md`

## Global Constraints

- Node ≥ 20; `package.json` `"engines": {"node": ">=20"}`; zero `dependencies`; zero `devDependencies`.
- Tests: `node --test "test/**/*.test.mjs"`, no network, no browser, no filesystem writes outside `test/tmp/` (cleaned in `after`).
- Every script supports `--help` and `--json`; scripts are black boxes to agents.
- Every `SKILL.md` ≤ 200 lines; frontmatter `name` equals its directory name, ≤ 64 chars, `[a-z0-9-]`, no leading/trailing/double hyphen; `description` 1–1024 chars.
- No agent-specific paths or variables (no `${CLAUDE_PLUGIN_ROOT}`); script paths in SKILL.md are relative to the skill directory.
- No vendor names anywhere except `docs/sources.md` and lines tagged `vendor-negative-use`. Banned regex (case-insensitive): `plastix|aesthetix|accessibe|wpengine|Desktop/git|/Users/`.
- Every finding carries ≥ 1 evidence item; validation rejects otherwise.
- `pre-launch` exits 1 on any `fail`; no flag converts a `fail`. `launch-audit` and `post-launch` always exit 0.
- Every report ends with a `## Not covered` section, even when empty of caps (it then lists the two never-runnable checks).
- Every check in the registry has ≥ 1 passing and ≥ 1 failing fixture (enforced by test).
- Commit after every task with a conventional-commit message ending in the attribution trailer used in this repo's history.
- Output root: `./website-launch/<slug>-<phase>-<YYYY-MM-DD>/` under `process.cwd()`, overridable with `--out`.

---

## File map

```
package.json, LICENSE, .gitignore, README.md, AGENTS.md
.claude-plugin/marketplace.json
scripts/gen-checks-doc.mjs                      # docs/checks.md generator (root, dev-only)
skills/launch-audit/scripts/lib/
  args.mjs        findings.mjs   registry.mjs   net.mjs        html.mjs
  robots.mjs      sitemap.mjs    crawl.mjs      report.mjs     baseline.mjs
  dns.mjs         browser.mjs    slug.mjs       fs-util.mjs
  detect/analytics.mjs  detect/placeholders.mjs  detect/framework.mjs
  schema/required.mjs   headers/owasp.json
  checks/inventory.mjs  checks/indexability.mjs  checks/host.mjs  checks/head.mjs
  checks/links.mjs      checks/images.mjs        checks/forms.mjs checks/a11y.mjs
  checks/perf.mjs       checks/analytics.mjs     checks/content.mjs
  checks/redirects.mjs  checks/ops.mjs           checks/browser-tier.mjs
skills/launch-audit/scripts/launch-audit.mjs
skills/launch-audit/{SKILL.md, references/*.md}
skills/pre-launch/scripts/lib/{hygiene,placeholders,build,output,framework,predecessor,human}.mjs
skills/pre-launch/scripts/pre-launch.mjs
skills/pre-launch/{SKILL.md, references/*.md}
skills/post-launch/scripts/lib/{cutover,watch,diff}.mjs
skills/post-launch/scripts/post-launch.mjs
skills/post-launch/{SKILL.md, references/*.md}
test/helpers.mjs, test/*.test.mjs, test/fixtures/**
docs/checks.md, docs/sources.md, docs/smoke.md
```

`slug.mjs`: `slugify(url|string) → string` (lowercase, `[^a-z0-9]+` → `-`, trimmed, ≤ 80 chars, `index` for `/`). `fs-util.mjs`: `walk(dir, {skipDirs})`, `readJson`, `writeJson`, `ensureDir` — tiny wrappers over `node:fs`.

---

### Task 1: Repository scaffold, test runner, and the two invariant tests

**Files:**
- Create: `package.json`, `LICENSE` (MIT, "Ethan Rogers", 2026), `.gitignore`, `test/helpers.mjs`, `test/invariants.test.mjs`, `test/tmp/.gitkeep`
- Create: `skills/launch-audit/scripts/lib/fs-util.mjs`, `skills/launch-audit/scripts/lib/slug.mjs`

**Interfaces:**
- Produces: `walk(dir, {skipDirs = new Set(['node_modules','.git'])}) → string[]` (absolute file paths, sorted); `readJson(path)`, `writeJson(path, obj)` (2-space, trailing newline), `ensureDir(path)`; `slugify(input) → string`.
- Produces (test helpers): `REPO_ROOT`, `tmpDir(name) → path` (under `test/tmp/`, removed in `after`), `readFixture(relPath) → string`, `fixturePath(relPath)`.

- [ ] **Step 1: Write `package.json`, `.gitignore`, `LICENSE`**

```json
{
  "name": "website-launch-skill",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "node --test \"test/**/*.test.mjs\"",
    "gen:checks": "node scripts/gen-checks-doc.mjs"
  }
}
```

`.gitignore`: `node_modules/`, `website-launch/`, `test/tmp/*`, `!test/tmp/.gitkeep`, `.DS_Store`, `*.log`.

- [ ] **Step 2: Write the failing invariant tests**

`test/invariants.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers.mjs'
import { walk } from '../skills/launch-audit/scripts/lib/fs-util.mjs'

const VENDOR = /plastix|aesthetix|accessibe|wpengine|Desktop\/git|\/Users\//i // vendor-negative-use
const TAG = 'vendor-negative-use'
const SKIP = new Set(['node_modules', '.git', 'tmp', 'website-launch'])
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
```

`test/helpers.mjs`:
```js
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const fixturePath = (rel) => join(REPO_ROOT, 'test', 'fixtures', rel)
export const readFixture = (rel) => readFileSync(fixturePath(rel), 'utf8')
export function tmpDir(name) {
  const dir = join(REPO_ROOT, 'test', 'tmp', `${name}-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
```

- [ ] **Step 3: Run tests, expect failure** — `npm test` → fails: cannot find `fs-util.mjs`.

- [ ] **Step 4: Implement `fs-util.mjs` and `slug.mjs`**

```js
// fs-util.mjs
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
export function walk(dir, { skipDirs = new Set(['node_modules', '.git']) } = {}) {
  const out = []
  ;(function rec(d) {
    for (const entry of readdirSync(d).sort()) {
      if (skipDirs.has(entry)) continue
      const full = join(d, entry)
      const st = statSync(full)
      if (st.isDirectory()) rec(full)
      else out.push(full)
    }
  })(dir)
  return out
}
export const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
export const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2) + '\n')
export const ensureDir = (p) => mkdirSync(p, { recursive: true })
```
```js
// slug.mjs
export function slugify(input) {
  let s = String(input)
  try { const u = new URL(s); s = (u.hostname + u.pathname).replace(/\/$/, '') || 'index' } catch {}
  s = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!s) s = 'index'
  return s.slice(0, 80)
}
```

- [ ] **Step 5: Run tests, expect pass** — `npm test` → 4 pass.
- [ ] **Step 6: Commit** — `chore: scaffold repo, test runner, vendor and dependency invariants`

---

### Task 2: Findings schema, validator, and the check registry

**Files:**
- Create: `skills/launch-audit/scripts/lib/findings.mjs`, `skills/launch-audit/scripts/lib/registry.mjs`
- Test: `test/findings.test.mjs`, `test/registry.test.mjs`

**Interfaces:**
- Produces: `SEVERITIES = ['blocker','high','medium','low','info']`; `TIERS = ['http','browser','repo','human']`; `EVIDENCE_TYPES = ['url','status','header','html','file','screenshot','dns','cert','metric','text']`.
- `finding({id, phase, dimension, severity, tier, page, title, detail, evidence, fix}) → Finding` (throws `FindingError` on invalid).
- `validateFinding(f, knownIds: Set) → {ok, errors[]}`.
- `sortFindings(list) → list` (severity order, then dimension, then page).
- `defineCheck({id, phase, dimension, severity, tier, title, catches, run}) → Check`; `run(ctx) → Finding[] | Promise<Finding[]>`; `ctx` shape is defined per phase in later tasks, but every `ctx` has `ctx.mk(overrides) → Finding` prebound with the check's `id/phase/dimension/severity/tier`.
- `createRegistry() → {add(check), list(), byPhase(phase), ids(): Set, byId(id)}`; `add` throws on duplicate id or bad shape. `id` format `^[a-z0-9-]+\.[a-z0-9-]+$` (`dimension.slug`), and `id.split('.')[0] === dimension`.

- [ ] **Step 1: Write failing tests**

`test/findings.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { finding, validateFinding, sortFindings, SEVERITIES } from '../skills/launch-audit/scripts/lib/findings.mjs'
const base = { id: 'head.title-missing', phase: 'launch-audit', dimension: 'head', severity: 'high', tier: 'http', page: 'https://x.test/', title: 'Missing <title>', detail: 'No title element', evidence: [{ type: 'url', value: 'https://x.test/' }], fix: 'Add a <title>' }
test('a valid finding round-trips', () => { assert.equal(finding(base).id, 'head.title-missing') })
test('a finding without evidence is rejected', () => { assert.throws(() => finding({ ...base, evidence: [] }), /evidence/) })
test('unknown severity is rejected', () => { assert.throws(() => finding({ ...base, severity: 'fatal' }), /severity/) })
test('unknown evidence type is rejected', () => { assert.throws(() => finding({ ...base, evidence: [{ type: 'vibe', value: 'x' }] }), /evidence type/) })
test('validateFinding rejects ids not in the registry', () => {
  const r = validateFinding(finding(base), new Set(['other.id']))
  assert.equal(r.ok, false); assert.match(r.errors[0], /not registered/)
})
test('sortFindings orders by severity then dimension then page', () => {
  const a = finding({ ...base, severity: 'low', page: 'https://x.test/b' })
  const b = finding({ ...base, severity: 'blocker', page: 'https://x.test/z' })
  const c = finding({ ...base, severity: 'low', page: 'https://x.test/a' })
  assert.deepEqual(sortFindings([a, b, c]).map((f) => f.page), [b.page, c.page, a.page])
  assert.deepEqual(SEVERITIES, ['blocker', 'high', 'medium', 'low', 'info'])
})
```

`test/registry.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRegistry, defineCheck } from '../skills/launch-audit/scripts/lib/registry.mjs'
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
```

- [ ] **Step 2: Run, expect failure** (modules missing).

- [ ] **Step 3: Implement**

```js
// findings.mjs
export const SEVERITIES = ['blocker', 'high', 'medium', 'low', 'info']
export const TIERS = ['http', 'browser', 'repo', 'human']
export const EVIDENCE_TYPES = ['url', 'status', 'header', 'html', 'file', 'screenshot', 'dns', 'cert', 'metric', 'text']
export class FindingError extends Error {}
const req = (o, k) => { if (o[k] === undefined || o[k] === null || o[k] === '') throw new FindingError(`finding.${k} is required`) }
export function finding(input) {
  for (const k of ['id', 'phase', 'dimension', 'severity', 'tier', 'title', 'detail', 'evidence', 'fix']) req(input, k)
  if (!SEVERITIES.includes(input.severity)) throw new FindingError(`unknown severity "${input.severity}"`)
  if (!TIERS.includes(input.tier)) throw new FindingError(`unknown tier "${input.tier}"`)
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) throw new FindingError('evidence must be a non-empty array')
  for (const e of input.evidence) {
    if (!EVIDENCE_TYPES.includes(e?.type)) throw new FindingError(`unknown evidence type "${e?.type}"`)
    if (e.value === undefined || e.value === null || e.value === '') throw new FindingError('evidence.value is required')
  }
  return Object.freeze({ page: null, ...input, evidence: input.evidence.map((e) => ({ ...e })) })
}
export function validateFinding(f, knownIds) {
  const errors = []
  try { finding(f) } catch (e) { errors.push(e.message) }
  if (knownIds && !knownIds.has(f.id)) errors.push(`finding id "${f.id}" is not registered`)
  return { ok: errors.length === 0, errors }
}
export function sortFindings(list) {
  const rank = (s) => SEVERITIES.indexOf(s)
  return [...list].sort((a, b) => rank(a.severity) - rank(b.severity) || a.dimension.localeCompare(b.dimension) || String(a.page).localeCompare(String(b.page)))
}
```
```js
// registry.mjs
import { finding, SEVERITIES, TIERS } from './findings.mjs'
const ID = /^[a-z0-9-]+\.[a-z0-9-]+$/
export function defineCheck(def) {
  for (const k of ['id', 'phase', 'dimension', 'severity', 'tier', 'title', 'catches', 'run']) if (def[k] === undefined) throw new Error(`check.${k} is required`)
  if (typeof def.run !== 'function') throw new Error('check.run must be a function')
  if (!ID.test(def.id)) throw new Error(`check id "${def.id}" must be dimension.slug`)
  if (def.id.split('.')[0] !== def.dimension) throw new Error(`check id "${def.id}" prefix must equal dimension "${def.dimension}"`)
  if (!SEVERITIES.includes(def.severity)) throw new Error(`check severity "${def.severity}"`)
  if (!TIERS.includes(def.tier)) throw new Error(`check tier "${def.tier}"`)
  const check = { ...def }
  check.mk = (o) => finding({ id: def.id, phase: def.phase, dimension: def.dimension, severity: def.severity, tier: def.tier, ...o })
  return Object.freeze(check)
}
export function createRegistry() {
  const map = new Map()
  return {
    add(c) { if (!c.mk) throw new Error('add() takes a defineCheck() result'); if (map.has(c.id)) throw new Error(`duplicate check id ${c.id}`); map.set(c.id, c); return c },
    list: () => [...map.values()],
    byPhase: (p) => [...map.values()].filter((c) => c.phase === p),
    ids: () => new Set(map.keys()),
    byId: (id) => map.get(id),
  }
}
```

- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(engine): findings schema with evidence validation and the check registry`

---

### Task 3: Argument parsing with `--help`, `--json`, and config merge

**Files:**
- Create: `skills/launch-audit/scripts/lib/args.mjs`
- Test: `test/args.test.mjs`

**Interfaces:**
- `defineArgs(spec) → parser` where `spec = { name, description, flags: { [name]: { type: 'string'|'number'|'boolean'|'list', required?, default?, help, repeatable? } } }`.
- `parser.parse(argv, {config?: object}) → {values, errors[], help: string}`; `--config <path>` is always accepted; config values are overridden by CLI values; `list` accumulates repeats and comma-splits; unknown flags are errors; `--help` sets `values.help = true`; `--json` always accepted.
- `parser.helpText() → string` (name, description, one line per flag with default and required marker).

- [ ] **Step 1: Write failing tests**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defineArgs } from '../skills/launch-audit/scripts/lib/args.mjs'
const p = defineArgs({ name: 'demo', description: 'd', flags: {
  url: { type: 'string', required: true, help: 'target' },
  'max-pages': { type: 'number', default: 200, help: 'cap' },
  'dev-host': { type: 'list', help: 'hosts', repeatable: true },
  staging: { type: 'boolean', default: false, help: 's' },
}})
test('parses strings, numbers, lists (repeat and comma), booleans', () => {
  const { values, errors } = p.parse(['--url', 'https://a.test', '--max-pages', '5', '--dev-host', 'a,b', '--dev-host', 'c', '--staging'])
  assert.deepEqual(errors, [])
  assert.equal(values.url, 'https://a.test'); assert.equal(values['max-pages'], 5)
  assert.deepEqual(values['dev-host'], ['a', 'b', 'c']); assert.equal(values.staging, true); assert.equal(values.json, false)
})
test('missing required flag is an error, not a throw', () => { assert.match(p.parse([]).errors[0], /--url is required/) })
test('unknown flag is an error', () => { assert.match(p.parse(['--url', 'x', '--nope']).errors[0], /unknown flag --nope/) })
test('config supplies defaults, CLI overrides', () => {
  const { values } = p.parse(['--max-pages', '9'], { config: { url: 'https://c.test', 'max-pages': 1 } })
  assert.equal(values.url, 'https://c.test'); assert.equal(values['max-pages'], 9)
})
test('--help and --json are always accepted; help text lists every flag', () => {
  assert.equal(p.parse(['--help']).values.help, true)
  const h = p.helpText(); for (const f of ['--url', '--max-pages', '--dev-host', '--staging', '--json', '--config']) assert.ok(h.includes(f), f)
  assert.ok(h.includes('(required)'))
})
test('a non-numeric value for a number flag is an error', () => { assert.match(p.parse(['--url', 'x', '--max-pages', 'lots']).errors[0], /--max-pages expects a number/) })
```

- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement `args.mjs`** — iterate argv; `--flag=value` and `--flag value` both accepted; booleans take no value (and `--no-flag` sets false); collect errors instead of throwing; `helpText` renders `  --name <type>   help (default: x) (required)`. Reserve `help`, `json`, `config` as built-ins.
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(engine): argument parser with help, json, and config merge`

---

### Task 4: Network adapter — fetch with redirect chains, pool, timeout, TLS

**Files:**
- Create: `skills/launch-audit/scripts/lib/net.mjs`
- Test: `test/net.test.mjs`

**Interfaces:**
- `createNet({fetchImpl = globalThis.fetch, tlsConnect = node:tls.connect, timeoutMs = 15000, concurrency = 8, userAgent = 'website-launch-skill/1.0 (+https://github.com/ethanplusai/website-launch-skill)'}) → net`
- `net.get(url, {method='GET', maxHops=10, headers={}}) → {url, finalUrl, status, ok, headers: Record<string,string> (lowercased), body: string|null, chain: [{url, status, location}], error: string|null, timedOut: boolean, bytes: number}` — follows redirects **manually** (`redirect: 'manual'`), records each hop; on error/timeout returns a result with `status: 0`.
- `net.head(url)` — same with HEAD, falls back to GET on 405.
- `net.map(items, fn)` — bounded concurrency; preserves order; never rejects (errors are values).
- `net.cert(hostname, port=443) → {valid, subject, altNames[], issuer, validFrom, validTo, daysLeft, error}` via `tlsConnect` (injectable).

- [ ] **Step 1: Write failing tests** with a scripted fake fetch:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNet } from '../skills/launch-audit/scripts/lib/net.mjs'
function fakeFetch(routes) {
  return async (url, opts) => {
    const r = routes[url]; if (!r) return new Response('nf', { status: 404 })
    if (r.hang) return new Promise(() => {})
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: r.headers ?? {} })
  }
}
test('follows a redirect chain hop by hop and records it', async () => {
  const net = createNet({ fetchImpl: fakeFetch({ 'http://a.test/': { status: 301, headers: { location: 'https://a.test/' } }, 'https://a.test/': { status: 301, headers: { location: 'https://www.a.test/' } }, 'https://www.a.test/': { status: 200, body: 'hi' } }) })
  const r = await net.get('http://a.test/')
  assert.equal(r.status, 200); assert.equal(r.finalUrl, 'https://www.a.test/'); assert.equal(r.chain.length, 2); assert.equal(r.chain[0].status, 301); assert.equal(r.body, 'hi')
})
test('a redirect loop stops at maxHops with an error', async () => {
  const net = createNet({ fetchImpl: fakeFetch({ 'https://l.test/a': { status: 302, headers: { location: '/b' } }, 'https://l.test/b': { status: 302, headers: { location: '/a' } } }) })
  const r = await net.get('https://l.test/a', { maxHops: 5 })
  assert.equal(r.status, 0); assert.match(r.error, /redirect loop|too many redirects/); assert.equal(r.chain.length, 5)
})
test('relative Location headers resolve against the hop url', async () => {
  const net = createNet({ fetchImpl: fakeFetch({ 'https://r.test/old': { status: 301, headers: { location: '/new' } }, 'https://r.test/new': { status: 200 } }) })
  assert.equal((await net.get('https://r.test/old')).finalUrl, 'https://r.test/new')
})
test('a hanging request times out and returns status 0 with timedOut', async () => {
  const net = createNet({ fetchImpl: fakeFetch({ 'https://h.test/': { hang: true } }), timeoutMs: 20 })
  const r = await net.get('https://h.test/'); assert.equal(r.status, 0); assert.equal(r.timedOut, true)
})
test('map bounds concurrency and preserves order', async () => {
  const net = createNet({ fetchImpl: fakeFetch({}), concurrency: 2 })
  let active = 0, peak = 0
  const out = await net.map([1, 2, 3, 4, 5], async (n) => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; return n * 2 })
  assert.deepEqual(out, [2, 4, 6, 8, 10]); assert.equal(peak, 2)
})
test('cert reports days left and SAN coverage via injected tls', async () => {
  const fakeTls = (opts, cb) => { const sock = { getPeerCertificate: () => ({ subject: { CN: 'a.test' }, subjectaltname: 'DNS:a.test, DNS:www.a.test', issuer: { O: 'Fake CA' }, valid_from: 'Jan 1 00:00:00 2026 GMT', valid_to: 'Dec 31 00:00:00 2027 GMT' }), authorized: true, end() {}, on() {} }; setTimeout(cb, 0); return sock }
  const net = createNet({ tlsConnect: fakeTls })
  const c = await net.cert('a.test'); assert.equal(c.valid, true); assert.deepEqual(c.altNames, ['a.test', 'www.a.test']); assert.ok(c.daysLeft > 300)
})
test('headers are lowercased and the user agent is sent', async () => {
  let seenUa; const net = createNet({ fetchImpl: async (u, o) => { seenUa = o.headers['user-agent']; return new Response('', { status: 200, headers: { 'X-Robots-Tag': 'noindex' } }) } })
  const r = await net.get('https://u.test/'); assert.equal(r.headers['x-robots-tag'], 'noindex'); assert.match(seenUa, /website-launch-skill/)
})
```

- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement `net.mjs`** — `AbortController` per hop for timeout; loop up to `maxHops`; on `3xx` with `location`, push `{url, status, location}` to `chain` and continue with `new URL(location, url).href`; detect a repeated URL in the chain → `error: 'redirect loop'`; exceeding hops → `'too many redirects'`; body read as text only for `text/*`, `application/xml`, `application/json`, `application/xhtml+xml`, otherwise `body: null` and `bytes` from `content-length` or read length; `map` uses an index-based worker pool. `cert()` wraps `tlsConnect({host, port, servername: host, rejectUnauthorized: false}, cb)`, reads `getPeerCertificate()` and `authorized`, parses `subjectaltname` `DNS:` entries, computes `daysLeft` from `valid_to`.
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(engine): network adapter with manual redirect chains, timeouts, pool, and TLS read`

---

### Task 5: HTML layer — tolerant extraction without a parser

**Files:**
- Create: `skills/launch-audit/scripts/lib/html.mjs`
- Test: `test/html.test.mjs`, fixtures `test/fixtures/html/{full-head.html, messy.html, jsonld.html, forms.html, no-head.html}`

**Interfaces:**
- `parseHtml(html, baseUrl) → Page` where
```
Page = {
  htmlAttrs: {lang, dir},
  head: { title, charset, viewport, metaByName: Map, metaByProperty: Map, links: [{rel, href(abs), type, sizes, hreflang}], canonical, robots, base },
  headings: [{level, text, empty}], h1Count,
  images: [{src(abs), alt (string|null), width, height, loading, fetchpriority, inPicture, srcset}],
  links: [{href(abs), text, rel, target, internal, scheme}],
  forms: [{action(abs|null), method, inputs: [{type, name, id, labelled: boolean, required}], hasHoneypot, hasCaptcha}],
  jsonld: [{raw, parsed|null, error|null}],
  scripts: [{src(abs)|null, inline: boolean, defer, async, type, inHead}],
  iframes: [{src(abs), title}],
  text: string,             // visible text, scripts/styles stripped, whitespace collapsed
  metaOutsideHead: number, duplicateIds: string[], hasMain: boolean, landmarks: string[], skipLink: boolean,
  tabindexPositive: number, autofocus: number
}
```
- Must tolerate unclosed tags, attributes without quotes, uppercase tags, comments, CDATA, `<script>` containing `<`.

- [ ] **Step 1: Write fixtures and failing tests** — `full-head.html` contains every head element with known values; `messy.html` has unquoted attrs, uppercase `<IMG SRC=x.png ALT="">`, a `<script>` with `"<div>"` inside, a meta tag in `<body>`, two elements with `id="dup"`, a positive tabindex; `jsonld.html` has one valid and one invalid JSON-LD block; `forms.html` has a labelled form, an unlabelled input, a honeypot (`display:none` or `aria-hidden` input named `website`), an `action="#"` form.

```js
test('extracts head metadata with absolute urls', () => {
  const p = parseHtml(readFixture('html/full-head.html'), 'https://x.test/dir/page')
  assert.equal(p.head.title, 'Full Head'); assert.equal(p.head.canonical, 'https://x.test/dir/page')
  assert.equal(p.head.metaByName.get('description'), 'A description.'); assert.equal(p.head.metaByProperty.get('og:image'), 'https://x.test/og.png')
  assert.equal(p.head.links.find((l) => l.rel === 'icon').href, 'https://x.test/favicon.svg'); assert.equal(p.htmlAttrs.lang, 'en')
})
test('survives messy markup and reports body meta, duplicate ids, positive tabindex', () => {
  const p = parseHtml(readFixture('html/messy.html'), 'https://x.test/')
  assert.equal(p.images[0].src, 'https://x.test/x.png'); assert.equal(p.images[0].alt, ''); assert.equal(p.metaOutsideHead, 1); assert.deepEqual(p.duplicateIds, ['dup']); assert.equal(p.tabindexPositive, 1)
  assert.ok(!p.text.includes('<div>'))
})
test('jsonld blocks parse individually', () => { const p = parseHtml(readFixture('html/jsonld.html'), 'https://x.test/'); assert.equal(p.jsonld.length, 2); assert.equal(p.jsonld[0].parsed['@type'], 'Organization'); assert.match(p.jsonld[1].error, /JSON/) })
test('forms report labels, honeypots, and dead actions', () => {
  const p = parseHtml(readFixture('html/forms.html'), 'https://x.test/')
  assert.equal(p.forms[0].inputs.filter((i) => !i.labelled).length, 1); assert.equal(p.forms[0].hasHoneypot, true); assert.equal(p.forms[1].action, 'https://x.test/#')
})
test('heading outline and h1 count', () => { const p = parseHtml('<h1>A</h1><h3>skip</h3><h2></h2>', 'https://x.test/'); assert.equal(p.h1Count, 1); assert.deepEqual(p.headings.map((h) => h.level), [1, 3, 2]); assert.equal(p.headings[2].empty, true) })
test('links are classified internal/external and resolved', () => { const p = parseHtml('<a href="/a">a</a><a href="https://o.test/">o</a><a href="mailto:x@y.z">m</a>', 'https://x.test/p/'); assert.equal(p.links[0].href, 'https://x.test/a'); assert.equal(p.links[0].internal, true); assert.equal(p.links[1].internal, false); assert.equal(p.links[2].scheme, 'mailto') })
```

- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement** a single-pass tokenizer: regex `/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s=\/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|([^<]+)/g`; track `inHead` (true until `</head>` or first `<body>`/non-head element), raw-text state for `script`/`style`/`textarea` (consume until the matching close tag with a case-insensitive search), a `label` map (`for=` targets and wrapped inputs), `duplicateIds` via a Set. `text` accumulates text nodes outside raw-text elements, entity-decodes `&amp; &lt; &gt; &quot; &#39; &nbsp;` and numeric entities, collapses whitespace. `internal` = same origin as `baseUrl`.
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(engine): tolerant html extraction layer`

---

### Task 6: robots.txt and sitemap modules

**Files:**
- Create: `skills/launch-audit/scripts/lib/robots.mjs`, `skills/launch-audit/scripts/lib/sitemap.mjs`
- Test: `test/robots.test.mjs`, `test/sitemap.test.mjs`; fixtures `test/fixtures/robots/{allow-all,disallow-all,ai-mixed,blocks-assets}.txt`, `test/fixtures/sitemaps/{plain.xml, index.xml, child-a.xml, child-b.xml, bad.xml, wp-sitemap.xml}`

**Interfaces:**
- `parseRobots(text) → {groups: [{agents[], allow[], disallow[]}], sitemaps: string[], errors: string[]}`; `isAllowed(robots, ua, path) → boolean` (longest-match, `*` and `$`); `AI_CRAWLERS = [{ua:'GPTBot', vendor:'OpenAI', purpose:'training'}, {ua:'ChatGPT-User', vendor:'OpenAI', purpose:'user'}, {ua:'OAI-SearchBot', vendor:'OpenAI', purpose:'search'}, {ua:'ClaudeBot', vendor:'Anthropic', purpose:'training'}, {ua:'Claude-User', vendor:'Anthropic', purpose:'user'}, {ua:'Claude-SearchBot', vendor:'Anthropic', purpose:'search'}, {ua:'PerplexityBot', vendor:'Perplexity', purpose:'search'}, {ua:'Perplexity-User', vendor:'Perplexity', purpose:'user'}, {ua:'Google-Extended', vendor:'Google', purpose:'training'}, {ua:'Applebot-Extended', vendor:'Apple', purpose:'training'}, {ua:'CCBot', vendor:'Common Crawl', purpose:'training'}, {ua:'Bytespider', vendor:'ByteDance', purpose:'training'}]`; `aiPolicy(robots) → [{ua, vendor, purpose, allowed: boolean}]`; `blocksAssets(robots, ua='*') → string[]` (patterns among `/*.css`, `/*.js`, `/assets`, `/static`, `/_next`, `/_astro`, `/images`, `/img`, `/wp-content`, `/wp-includes` that are disallowed).
- `discoverSitemaps(net, origin, robots) → {candidates: string[], found: [{url, status}]}` trying robots `Sitemap:` lines then `/sitemap.xml`, `/sitemap_index.xml`, `/sitemap-index.xml`, `/wp-sitemap.xml`.
- `parseSitemap(xml) → {kind: 'index'|'urlset'|'invalid', entries: [{loc, lastmod}], error}`.
- `expandSitemap(net, url) → {urls: [{loc, lastmod, from}], children: [{url, status, ok}], errors: string[], failedClosed: boolean}` — index followed one level; any child that fails → `failedClosed: true` and the error names it.

- [ ] **Step 1: Write failing tests** covering: disallow-all detection; `Allow` beating `Disallow` by length; `*` and `$`; per-agent groups; AI policy table producing 12 rows with correct `allowed`; `blocksAssets` on the `blocks-assets` fixture; sitemap index expansion via a fake net; failed-closed on a 500 child; `bad.xml` → `invalid`; `wp-sitemap.xml` (index) discovery when `/sitemap.xml` is 404; `lastmod` parsed or null.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.** `parseSitemap` uses regex over `<url>`/`<sitemap>` blocks with `<loc>` and `<lastmod>`; entity-decode `loc`. `isAllowed`: pick the group whose agent matches `ua` case-insensitively, else `*`; convert patterns to regex (`*` → `.*`, trailing `$` anchors); the longest matching rule wins; tie → allow.
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(engine): robots.txt with AI-crawler policy and sitemap discovery that fails closed`

---

### Task 7: Crawl — sitemap ∪ BFS with named caps

**Files:**
- Create: `skills/launch-audit/scripts/lib/crawl.mjs`
- Test: `test/crawl.test.mjs`; fixture `test/fixtures/recorded/small-site.json` (a hand-built recorded site: 12 pages, one orphan in sitemap, one unlisted page, one 404 link, one external link, an image, a robots.txt, a sitemap)

**Interfaces:**
- `crawlSite(net, {url, maxPages=200, maxDepth=4, ignoreRobots=false, robots, sitemapUrls=[]}) → {pages: [{url, status, finalUrl, depth, source: 'sitemap'|'crawl'|'both', title, page: Page|null, response}], dropped: [{url, reason: 'max-pages'|'max-depth'|'robots'}], orphans: string[], unlisted: string[], assets: {images: Set, scripts: Set, styles: Set}, externalLinks: Map<url, referrers[]>, internalLinks: Map<url, referrers[]>}`
- URL normalization: strip fragment, drop default port, keep query, resolve `..`, treat `/a` and `/a/` as distinct (trailing-slash policy is a check, not a crawl concern).
- Also export `recordedNet(fixture)` in `test/helpers.mjs`: builds a `net` from `{ "https://…": {status, headers, body} }`.

- [ ] **Step 1: Write failing tests**: 12 pages found with correct `source`; orphan and unlisted detected; a `maxPages: 5` run lists 7 named drops; depth cap names drops; robots-disallowed path dropped with reason `robots` unless `ignoreRobots`; 404 target appears in `pages` with status 404 and in `internalLinks` with its referrer; the external link lands in `externalLinks` only; fragment/duplicate URLs deduped.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement** BFS queue seeded with the start URL (depth 0) and every sitemap URL (depth 0, source `sitemap`); fetch with `net.map` in waves per depth; parse HTML pages with `parseHtml`; enqueue same-origin links; track caps and record drops.
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(engine): crawl with sitemap union, orphan detection, and named caps`

---

### Task 8: Report bundle and baseline

**Files:**
- Create: `skills/launch-audit/scripts/lib/report.mjs`, `skills/launch-audit/scripts/lib/baseline.mjs`
- Test: `test/report.test.mjs`, `test/baseline.test.mjs`

**Interfaces:**
- `buildNotCovered({dropped, browserAvailable, browserReason, skipped: [{check, reason}], unverifiableExternals: string[], ignoredRobots, psiSkipped}) → string[]` — always ends with the two fixed lines: `Copy vs. source documents: not run (no source of truth reachable)` and `Pages vs. agreed scope: not run (no scope source reachable)`.
- `renderReport({phase, target, generatedAt, findings, notCovered, ops?: [{label, autoVerifiedBy|null}], summary: {pages, blockers, high, medium, low, info}}) → string` (markdown; H1; summary table; one `## <dimension>` per dimension in first-seen severity order; each finding as `### [severity] title` + `page`, `detail`, `evidence` list, `fix`; then `## Ops & access readiness` if given; then `## Not covered`).
- `writeBundle(outDir, {report, findings, crawl, baseline, redirectsCsv?, extra?: {name, content}[]}) → {files: string[]}`.
- `resolveOutDir({out, slug, phase, now, cwd}) → path` = `out ?? join(cwd, 'website-launch', `${slug}-${phase}-${yyyy-mm-dd}`)`.
- `makeBaseline(crawlResult, {securityHeaders, cert, robotsHash, sitemapUrls}) → Baseline` (shape from spec §3.4); `diffBaseline(before, after) → {missingPages[], newRedirects[], changed: [{url, field, before, after}], statusChanges[], analyticsLost[]}`.

- [ ] **Step 1: Write failing tests**: report contains `## Not covered` even with zero findings and the two fixed lines; severity order within a dimension; evidence rendered; `resolveOutDir` depends on `cwd`; `writeBundle` writes the expected file names into a `tmpDir`; `diffBaseline` detects a missing page, a title change, a new redirect, and a lost analytics tag from two hand-built baselines.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(engine): report renderer with mandatory not-covered section, bundle writer, baseline diff`

---

### Task 9: Checks — indexability and host & transport (+ vendored OWASP, DNS adapter)

**Files:**
- Create: `skills/launch-audit/scripts/lib/checks/indexability.mjs`, `skills/launch-audit/scripts/lib/checks/host.mjs`, `skills/launch-audit/scripts/lib/dns.mjs`, `skills/launch-audit/scripts/lib/headers/owasp.json` (copy the two JSON documents fetched from `github.com/OWASP/www-project-secure-headers/ci/` into `{ "fetched": "2026-09-13", "add": [...], "remove": [...] }`), `skills/launch-audit/scripts/lib/checks/_ctx.mjs`
- Test: `test/checks-indexability.test.mjs`, `test/checks-host.test.mjs`; fixtures under `test/fixtures/recorded/` (`noindex-site.json`, `https-site.json`, `http-only-site.json`, `soft-404-site.json`, `split-host-site.json`, `bad-headers-site.json`)

**Interfaces:**
- Audit `ctx` (defined in `_ctx.mjs`, built by the orchestrator in Task 14): `{ target: {url, origin, host, staging: boolean, devHosts: string[]}, crawl (Task 7 result), robots: {text, parsed, status}, sitemaps: {found, expanded}, probes: {httpRoot, httpsRoot, wwwRoot, apexRoot, slashVariant, notFound: {url, response}}, cert, dns, net, options, mk }`. `buildAuditContext(net, options)` lives in `_ctx.mjs` and performs the probes (root over http/https, www/apex variants, `/this-page-should-not-exist-<random>`, `/robots.txt`, sitemap discovery). Tested with recorded fixtures.
- Each checks module exports `checks: Check[]` created with `defineCheck`, phase `launch-audit`.

**Check ids (indexability):** `indexability.site-noindex` (blocker; info when `staging`), `indexability.page-noindex-in-sitemap` (high), `indexability.nosnippet-unintended` (low), `indexability.robots-unfetchable` (high), `indexability.robots-sitemap-line-missing` (medium), `indexability.robots-sitemap-other-host` (high), `indexability.robots-blocks-assets` (high), `indexability.ai-crawler-policy` (info — one finding listing the 12 rows), `indexability.sitemap-missing` (high), `indexability.sitemap-invalid` (high), `indexability.sitemap-too-large` (medium), `indexability.sitemap-url-not-200` (high), `indexability.sitemap-noindexed-url` (high), `indexability.sitemap-other-host` (high), `indexability.sitemap-lastmod-future` (low), `indexability.canonical-missing` (medium), `indexability.canonical-relative` (medium), `indexability.canonical-other-host` (high), `indexability.canonical-to-redirect-or-404` (high), `indexability.canonical-multiple` (high), `indexability.canonical-header-mismatch` (medium), `indexability.hreflang-invalid` (medium), `indexability.hreflang-not-reciprocal` (medium), `indexability.hreflang-no-x-default` (low), `indexability.llms-txt` (info: present/absent/malformed).

**Check ids (host):** `host.http-not-redirected` (high), `host.http-redirect-not-301` (medium), `host.hsts-missing` (medium), `host.hsts-short` (low), `host.cert-invalid` (blocker), `host.cert-expiring` (high, < 30 days), `host.cert-missing-san` (high, apex or www not covered), `host.www-apex-split` (high, both serve 200), `host.www-apex-no-redirect` (medium), `host.trailing-slash-both-200` (medium), `host.mixed-content` (high), `host.redirect-chain` (medium, > 1 hop), `host.redirect-loop` (high), `host.meta-refresh` (medium), `host.security-header-missing` (medium; one finding per missing OWASP header among CSP, X-Content-Type-Options, X-Frame-Options/frame-ancestors, Referrer-Policy, Permissions-Policy), `host.security-header-coop-corp` (info), `host.leaky-header-present` (low; from OWASP remove list), `host.no-compression` (medium), `host.no-cache-static` (low), `host.http-version` (info), `host.soft-404` (high), `host.default-404-body` (medium), `host.404-no-navigation` (low), `host.dev-host-leak` (blocker on production, high on staging).

- [ ] **Step 1: Write failing tests** — for every id above, one recorded fixture that triggers it and one that does not; assert the finding's `evidence` contains the header/status/url that proves it. Include a test that `staging: true` downgrades `site-noindex` to `info`. Include `dns.mjs` tests with an injected resolver: `txt('example.test')` returns SPF/DMARC parsing results.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement** `_ctx.mjs`, `dns.mjs` (`createDns({resolveTxt, resolve4, resolve6, resolveCname})` → `{spf(host), dmarc(host), dkim(host, selectors=['default','google','selector1','selector2','k1','s1','s2']), addresses(host)}`), and both check modules.
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(checks): indexability and host/transport dimensions with vendored OWASP headers`

---

### Task 10: Checks — head & metadata (+ schema.org required-property table)

**Files:**
- Create: `skills/launch-audit/scripts/lib/checks/head.mjs`, `skills/launch-audit/scripts/lib/schema/required.mjs`
- Test: `test/checks-head.test.mjs`; fixtures `test/fixtures/html/head-*.html`, `test/fixtures/jsonld/*.json`

**Interfaces:**
- `REQUIRED = { Organization: ['name','url'], LocalBusiness: ['name','address','telephone'], WebSite: ['name','url'], Article: ['headline','datePublished','author'], BlogPosting: ['headline','datePublished','author'], Product: ['name','image','offers'], FAQPage: ['mainEntity'], BreadcrumbList: ['itemListElement'], Service: ['name','provider'], Person: ['name'], Event: ['name','startDate','location'] }`; `checkJsonLd(parsed) → {type, missing: string[], urlsToVerify: string[]}` (handles `@graph`, arrays, nested `@type` arrays).
- Check ids: `head.title-missing` (high), `head.title-duplicate` (high), `head.title-length` (low), `head.title-framework-default` (high; list: `Astro`, `Vite App`, `Vite + React`, `Document`, `Create Next App`, `Nuxt`, `SvelteKit app`, `Welcome to Gatsby`, `Site Title`, `Home`), `head.description-missing` (medium), `head.description-duplicate` (medium), `head.description-length` (low), `head.h1-missing` (medium), `head.h1-multiple` (low), `head.heading-skip` (low), `head.heading-empty` (low), `head.lang-missing` (medium), `head.charset-missing` (low), `head.viewport-missing` (high), `head.viewport-blocks-zoom` (medium), `head.favicon-missing` (medium), `head.favicon-broken` (medium), `head.apple-touch-icon-missing` (low), `head.manifest-missing` (info), `head.theme-color-missing` (info), `head.og-missing` (medium; per missing `og:title|og:description|og:image|og:url|og:type`), `head.og-image-broken` (high), `head.og-image-not-raster` (medium), `head.og-image-small` (medium, < 1200×630), `head.og-image-dimensions-missing` (low), `head.og-url-mismatch` (medium), `head.twitter-card-missing` (low; unless OG present and `twitter:card` absent → info), `head.jsonld-invalid` (high), `head.jsonld-missing-required` (medium), `head.jsonld-url-broken` (medium), `head.jsonld-on-noindex` (low), `head.jsonld-types-summary` (info; one per template group), `head.duplicate-id` (low), `head.meta-outside-head` (medium), `head.meta-duplicate` (low).
- Image dimensions from bytes: implement `imageDimensions(buffer) → {type: 'png'|'jpeg'|'gif'|'webp'|'svg'|'ico'|'unknown', width, height}` in `skills/launch-audit/scripts/lib/image-dims.mjs` (PNG IHDR, JPEG SOF markers, GIF header, WebP VP8/VP8L/VP8X, SVG `viewBox`/`width`/`height`). `net.get` must expose `bodyBytes` (Uint8Array) for image content types — extend Task 4 accordingly here.

- [ ] **Step 1: Write failing tests** — a fixture pair per id; `image-dims` tests with tiny hand-crafted PNG/JPEG/GIF/WebP byte arrays (encode the headers inline as hex) and an SVG string.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(checks): head and metadata dimension with structured-data requirements and byte-level image dimensions`

---

### Task 11: Checks — links, images, forms, content, analytics detection

**Files:**
- Create: `checks/links.mjs`, `checks/images.mjs`, `checks/forms.mjs`, `checks/content.mjs`, `checks/analytics.mjs`, `detect/analytics.mjs`, `detect/placeholders.mjs` (all under `skills/launch-audit/scripts/lib/`)
- Test: `test/checks-links.test.mjs`, `test/checks-images.test.mjs`, `test/checks-forms.test.mjs`, `test/checks-content.test.mjs`, `test/detect.test.mjs`

**Interfaces:**
- `detect/analytics.mjs`: `SIGNATURES = [{name:'GA4', re:/gtag\(\s*['"]config['"]\s*,\s*['"](G-[A-Z0-9]+)/, idGroup:1}, {name:'GTM', re:/googletagmanager\.com\/gtm\.js\?id=(GTM-[A-Z0-9]+)/}, {name:'Plausible', re:/plausible\.io\/js\/|data-domain=/}, {name:'Fathom', re:/cdn\.usefathom\.com/}, {name:'PostHog', re:/posthog\.(?:init|com)/}, {name:'Umami', re:/data-website-id=/}, {name:'Matomo', re:/matomo\.js|_paq\.push/}, {name:'Meta Pixel', re:/fbq\(\s*['"]init['"]/}, {name:'Hotjar', re:/static\.hotjar\.com/}, {name:'Clarity', re:/clarity\.ms\/tag/}]`; `detectAnalytics(html) → [{name, id|null}]`.
- `detect/placeholders.mjs`: `PLACEHOLDER_TEXT = [/lorem ipsum/i, /\byour text here\b/i, /\bcoming soon\b/i, /\[INSERT[^\]]*\]/i, /\{\{\s*[\w.]+\s*\}\}/, /\bTODO\b/, /\bFIXME\b/, /REPLACE[_ ]ME/i]`, `PLACEHOLDER_IDS = [/G-XXXXXXX+/i, /G-PLACEHOLDER/i, /UA-\d+-\d+/, /formspree\.io\/f\/(your-form-id|xxxx+|REPLACE)/i, /GTM-XXXX+/i]`, `DEV_HOSTS = [/\blocalhost\b/, /127\.0\.0\.1/, /\.vercel\.app\b/, /\.netlify\.app\b/, /\.pages\.dev\b/, /\bstaging\./, /\bdev\./, /\.local\b/]`, `SECRETS = [/sk-[A-Za-z0-9]{20,}/, /ghp_[A-Za-z0-9]{36}/, /AKIA[0-9A-Z]{16}/, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/]`; `scanText(text, patterns, {extraHosts}) → [{pattern, match, index}]`.
- Check ids — links: `links.internal-broken` (high), `links.external-broken` (medium), `links.external-unverifiable` (info; not a failure), `links.to-dev-host` (blocker prod / high staging), `links.to-http-on-https` (medium), `links.to-redirecting-internal` (low), `links.noopener-missing` (low), `links.mailto-invalid` (medium), `links.tel-invalid` (medium), `links.empty-anchor` (low), `links.hash-href` (low), `links.javascript-href` (medium), `links.same-text-different-target` (info), `links.generic-anchor-text` (info), `links.skip-link-missing` (low).
- images: `images.alt-missing` (high), `images.dimensions-missing` (medium), `images.lazy-on-first-image` (medium), `images.not-lazy-below-fold` (low; images after the 3rd without `loading=lazy`), `images.legacy-format` (low; jpg/png without `<picture>`/srcset alternatives), `images.oversized` (medium, > 500 KB), `images.broken` (high), `images.duplicate-across-pages` (low; content hash via `node:crypto` sha256 of `bodyBytes`), `images.video-autoplay-sound` (medium), `images.video-captions-missing` (info).
- forms: `forms.inventory` (info; one per form), `forms.dead-action` (high; `#`, empty, `javascript:`), `forms.dev-endpoint` (blocker), `forms.placeholder-id` (high), `forms.unlabelled-inputs` (medium), `forms.embed-broken` (high; iframe/script src not 200), `forms.no-spam-protection` (info), `forms.test-submission-required` (info; human item, one per form).
- content: `content.placeholder-text` (high), `content.copyright-year-stale` (low), `content.past-dated-promo` (medium; regex for `through|until|ends|expires` + a month name + day, date < today), `content.phone-variants` (medium; > 1 distinct normalized phone site-wide), `content.email-variants` (info), `content.address-variants` (info; distinct postal-code strings), `content.broken-entity` (low; `&amp;amp;` / literal `&nbsp;` text), `content.mixed-spelling` (info).
- analytics: `analytics.none-detected` (high), `analytics.missing-on-pages` (medium; tag present on some pages, absent on others — list them), `analytics.duplicate-install` (medium), `analytics.inconsistent-ids` (high), `analytics.summary` (info).

- [ ] **Step 1: Write failing tests** — presence proofs for every detector pattern (fire on a planted string) plus a fixture pair per check id. `external-unverifiable` test: a fake net returning `status: 0, timedOut: true` for an external must not produce `external-broken`.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(checks): links, images, forms, content sanity, and analytics detection`

---

### Task 12: Checks — accessibility (HTTP), performance (HTTP), cutover redirects, ops readiness

**Files:**
- Create: `checks/a11y.mjs`, `checks/perf.mjs`, `checks/redirects.mjs`, `checks/ops.mjs`, `checks/inventory.mjs`
- Test: `test/checks-a11y.test.mjs`, `test/checks-perf.test.mjs`, `test/checks-redirects.test.mjs`, `test/checks-ops.test.mjs`, `test/checks-inventory.test.mjs`

**Interfaces:**
- inventory: `inventory.orphan-page` (medium), `inventory.unlisted-page` (low), `inventory.deep-page` (low; depth > 3), `inventory.capped` (info; names each dropped URL — also mirrored into Not covered), `inventory.non-200-page` (high; pages in the crawl set with 4xx/5xx).
- a11y (HTTP tier): `a11y.lang-missing` (dup of head — do NOT re-emit; a11y module only owns): `a11y.form-labels` (high), `a11y.heading-order` (low), `a11y.link-text-empty` (medium), `a11y.tabindex-positive` (low), `a11y.autofocus` (low), `a11y.main-landmark-missing` (medium), `a11y.iframe-title-missing` (medium), `a11y.image-alt-coverage` (info; percentage), `a11y.browser-tier-required` (info; one finding stating axe did not run and why).
- perf (HTTP tier): `perf.page-weight` (medium > 3 MB estimated from referenced assets' `content-length`), `perf.request-count` (low > 100), `perf.render-blocking-script` (medium; `<script src>` in head without `defer`/`async`/`type=module`), `perf.hero-preload-missing` (info; first image not preloaded), `perf.font-display-missing` (low; `@font-face` in inline styles / linked CSS fetched without `font-display`), `perf.third-party-scripts` (info; inventory by host), `perf.browser-tier-required` (info).
- redirects (needs `options.oldUrl`): `redirectMap(oldCrawl, net, newOrigin) → rows: [{old_url, status_on_new: 'same-path-200'|'redirect-200'|'redirect-to-404'|'would-404', final_url, recommendation, confidence}]`; `bestMatch(oldPath, newPaths) → {path, confidence}` (segment overlap: split on `/` and `-`, Jaccard, substring credit, `null` on zero overlap); `toCsv(rows)`. Check ids: `redirects.would-404` (high; one per old URL), `redirects.to-404` (high), `redirects.chain` (medium), `redirects.wildcard-smell` (medium; > 30% of old URLs land on the same target), `redirects.summary` (info), `redirects.old-url-required` (info; when not run).
- ops: `OPS_CHECKLIST = [{label:'Hosting account provisioned; access confirmed', auto:null}, {label:'Domain registrar access tested; DNS control confirmed', auto:null}, {label:'Analytics property live; conversion event defined', auto:'analytics'}, {label:'Search Console (and Bing Webmaster) verified; sitemap submitted', auto:null}, {label:'Form notifications route to a monitored inbox; test submission received', auto:'forms'}, {label:'Email authentication: SPF, DKIM, DMARC present', auto:'ops.email-auth'}, {label:'Privacy policy, terms, and cookie policy published where required', auto:'ops.legal-pages'}, {label:'Chat / booking widgets installed and tested (if used)', auto:null}, {label:'Uptime monitoring in place', auto:null}, {label:'Backups configured and a restore tested', auto:null}, {label:'Staging credentials and any secrets shared during the build rotated', auto:null}, {label:'Custom 404 returns a real 404', auto:'host.soft-404'}, {label:'Search engines allowed on production', auto:'indexability.site-noindex'}]`; check ids: `ops.email-auth` (medium; SPF missing / DMARC missing / DKIM none found — via `ctx.dns`), `ops.legal-pages` (medium; no link whose text or href matches `privacy|terms|cookie`), `ops.checklist` (info; the rendered list with auto/human marks).

- [ ] **Step 1: Write failing tests** — fixture pairs for every id; `bestMatch` cases: `/services/botox` vs `['/treatments/botox','/about']` → botox with confidence > 0.5; `/xyz` vs unrelated → `null`; wildcard-smell on a 10-row map with 6 rows to `/`.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(checks): inventory, http-tier accessibility and performance, cutover redirects, ops readiness`

---

### Task 13: Optional browser tier

**Files:**
- Create: `skills/launch-audit/scripts/lib/browser.mjs`, `skills/launch-audit/scripts/lib/checks/browser-tier.mjs`
- Test: `test/browser.test.mjs`, `test/checks-browser.test.mjs`

**Interfaces:**
- `createBrowser({loader = () => import('playwright'), mode = 'auto'}) → {available: boolean, reason: string|null, render(url, {widths = {desktop:1440, tablet:768, mobile:390}, outDir}) → {screenshots: {desktop, tablet, mobile}, consoleErrors: [{text, url}], failedRequests: [{url, status}], collectorHits: string[] (requests to known analytics collectors: google-analytics.com/g/collect, analytics.google.com, plausible.io/api/event, …), horizontalOverflow: {desktop, tablet, mobile} (boolean), navCollapsed: boolean, renderedHead: {title, description, canonical, robots} }, axe(url) → {available, violations: [{id, impact, nodes, help}]}, lighthouse(url, {formFactor}) → {available, scores: {performance, accessibility, bestPractices, seo}, metrics: {lcp, cls, tbt, inp?}}, close()}`.
- When `mode === 'off'` or the loader throws, `available: false` with `reason` = `'--browser off'` or `'Playwright not installed. Optional: npm i -D playwright && npx playwright install chromium'`.
- `axe` injects axe-core from `node_modules/axe-core/axe.min.js` if resolvable, else `available: false, reason: 'axe-core not installed'`. `lighthouse` uses `import('lighthouse')` if resolvable, else unavailable.
- Check ids (browser tier, all `tier: 'browser'`): `browser.console-errors` (medium), `browser.failed-requests` (medium), `browser.horizontal-overflow` (high on mobile, medium else), `browser.nav-not-collapsed` (medium), `browser.rendered-head-differs` (medium; client-injected meta differs from HTTP-tier head), `browser.analytics-not-firing` (high; tag present in HTML, no collector hit), `browser.consent-missing` (info), `browser.axe-violation` (severity by impact: critical→high, serious→high, moderate→medium, minor→low), `browser.lighthouse-score` (medium below threshold, info otherwise), `browser.screenshots-for-review` (info; lists paths for the agent's visual pass), `browser.embed-console-error` (high).

- [ ] **Step 1: Write failing tests** with a fake loader that returns a stub `chromium.launch()` producing scripted page results; test unavailability messaging for each mode; test that every browser check emits nothing when `available === false` (the `Not covered` line is produced by the orchestrator, Task 14).
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.** In `render`, block the page from navigating away on dialogs (`page.on('dialog', d => d.dismiss())`), never click anything; scroll the page in viewport steps before the full-page screenshot so scroll-revealed content renders (the gap the earlier prototype had); `horizontalOverflow` = `document.documentElement.scrollWidth > innerWidth + 2`; `navCollapsed` = at mobile width, a `nav`/`[role=navigation]` has a visible `button`/`[aria-expanded]` and its link list is hidden.
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(browser): optional Playwright tier with axe, lighthouse, collector detection, and scroll-aware screenshots`

---

### Task 14: `launch-audit` orchestrator, SKILL.md, references

**Files:**
- Create: `skills/launch-audit/scripts/launch-audit.mjs`, `skills/launch-audit/SKILL.md`, `skills/launch-audit/references/{indexability,host,head,links,images,forms,accessibility,performance,analytics,content,redirects,ops,reading-the-report}.md`
- Test: `test/launch-audit-cli.test.mjs`, `test/skills-contract.test.mjs`

**Interfaces:**
- CLI flags per spec §5. Exit code always 0 except usage errors (exit 2 with errors printed).
- `runAudit({net, browser, options, now}) → {findings, crawl, baseline, notCovered, ops, summary}` exported for tests; the `main()` wires real adapters.
- Human summary printed at the end: bundle path, counts by severity, the first five blockers/highs, and the full `Not covered` list.
- `test/skills-contract.test.mjs` (covers all three skills as they land): every `skills/*/SKILL.md` has valid frontmatter (`name` = dirname, regex, lengths), ≤ 200 lines, references only files that exist, contains the string `read-only` and `Not covered`, and does not contain `CLAUDE_PLUGIN_ROOT`.

- [ ] **Step 1: Write failing tests**: `runAudit` on the recorded `small-site.json` produces findings from ≥ 6 dimensions, a baseline with 12 pages, `notCovered` including the browser line when `browser.available === false`; CLI `--help` exits 0 and lists every flag; missing `--url` exits 2; `--json` prints a JSON object with `bundle` and `summary`; the contract test passes for `launch-audit`.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement** the orchestrator (build ctx → run registry `byPhase('launch-audit')` → browser tier if available → assemble ops list marking `auto` ids that produced no findings as auto-verified → write bundle → print summary). Write SKILL.md (≤ 200 lines): frontmatter, golden rule, workflow (gather inputs → run script → read bundle → judgment passes: screenshots per `references/reading-the-report.md`, forms per `references/forms.md`, contact variants → present report with `Not covered` verbatim), the two never-run checks, reference index. Write each reference file: what the findings in that dimension mean, why they matter at launch, how to fix on Astro / Next / Nuxt / SvelteKit / Eleventy / Hugo / WordPress / generic static, and what the check cannot tell you.
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(launch-audit): orchestrator, skill instructions, and per-dimension references`

---

### Task 15: `pre-launch` — gate library, orchestrator, SKILL.md, references, fixtures

**Files:**
- Create: `skills/pre-launch/scripts/lib/{context,hygiene,placeholders,build,output,framework,predecessor,human,gate}.mjs`, `skills/pre-launch/scripts/pre-launch.mjs`, `skills/pre-launch/SKILL.md`, `skills/pre-launch/references/{human-checklist,predecessor-redirects,framework-hints,config,reading-the-gate}.md`, `skills/launch-audit/scripts/lib/detect/framework.mjs`
- Fixtures: `test/fixtures/passing-site/` (package.json with `build` script that copies `src/` to `dist/`; `.launch.json`; complete `dist/` with index, about, contact, thank-you (noindex), 404 (noindex), favicon set, `og.png` 1200×630 — generate a real PNG via a tiny script committed as `test/fixtures/tools/make-png.mjs`, `robots.txt`, `sitemap.xml`, `llms.txt`), `test/fixtures/failing-site/` (every failure class seeded: placeholder GA id, `REPLACE_ME`, localhost link, svg-only OG, missing apple-touch-icon, 404 page indexable, robots pointing at wrong host, duplicate titles, no lang, wildcard redirect in `vercel.json`, missing sitemap loc file), `test/fixtures/sitemaps/predecessor.xml`
- Test: `test/pre-launch-*.test.mjs` (one per module), `test/pre-launch-cli.test.mjs`

**Interfaces:**
- Gate `ctx`: `{ dir, config: {productionUrl, predecessorUrl, buildDir, requiredEnv[], devHosts[], strict, skipBuild}, pkg, framework: {name|null, config: {siteUrl, sitemapIntegration, trailingSlash, redirectsFile, redirects: [{from, to, status, wildcard}]}}, buildDir, files: string[] (build output), html: Map<relPath, Page>, git: {clean, pushed, nested[]}, net, mk }`.
- `detect/framework.mjs`: `detectFramework(dir, pkg) → {name: 'astro'|'next'|'nuxt'|'sveltekit'|'eleventy'|'hugo'|'vite'|'wordpress'|null, configPath, buildDirGuess, siteUrl|null, sitemapIntegration: boolean|null, trailingSlash: 'always'|'never'|'ignore'|null}` using file presence and a light regex read of the config; `parseRedirects(dir) → {file, rules: [{from, to, status, wildcard}]}` for `vercel.json`, `netlify.toml`, `_redirects`, `next.config.{js,mjs,ts}` (regex on `source:`/`destination:`), `.htaccess` (`Redirect`/`RewriteRule`).
- Gate results: `{gate: 'pass'|'fail', checks: [{id, group, status: 'pass'|'fail'|'skip', detail, evidence[]}], human_items: [{id, title, instructions, requires?}], framework, buildDir, notCovered[]}`. Group order: `hygiene, placeholders, build, output, framework, predecessor`. Execution order: `hygiene, placeholders, build, output, framework, predecessor` (build before output).
- Check ids per spec §4 with prefixes `hygiene.`, `placeholders.`, `build.`, `output.`, `framework.`, `predecessor.` — register them in the shared registry with `phase: 'pre-launch'` so `docs/checks.md` covers the gate (severity `blocker` for every `fail`-capable check, `info` for advisory ones like `placeholders.source-maps` when not `--strict`).
- Human items: ids `forms, analytics, hosting, payments (conditional: pkg deps match /stripe|paddle|lemonsqueezy|@paypal/), legal, gsc-baseline (conditional: predecessorUrl), dns, signoff, rollback`; progress file `.launch-progress.json` `{confirmed: [id], updatedAt}` read/written by `--confirm <id>` and `--progress`.
- CLI: `pre-launch.mjs [--dir] --production-url … ; --json ; --confirm <id> ; --reset-progress`. Exit 1 iff any check `fail`.

- [ ] **Step 1: Write failing tests** — each module against the two fixture sites; git checks with an injected `git` runner (`exec` fake returning porcelain output); build check with the fixture's real `npm run build` replaced by an injected `exec`; predecessor coverage with `predecessor.xml` and a fake net; a wildcard rule fails with the rule quoted; unfetchable child sitemap fails closed; CLI exit codes (`passing-site` → 0, `failing-site` → 1); `--strict` flips `source-maps`; human items order fixed and conditional items present only when triggered; progress round-trip in a `tmpDir`.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.** Write SKILL.md: run the script, triage (every `fail` blocks; fix what you can — env, placeholders, redirect entries; never suppress; re-run until `pass`), then walk `human_items` one at a time confirming each with `--confirm`, the verbatim rules, and the predecessor-migration pointer. Write references: `human-checklist.md` (each item: why, how to verify, what "done" looks like), `predecessor-redirects.md` (the methodology: sitemap is the source of truth, same-path first, no wildcards, chains, GSC export before DNS, keep old host up, don't delete the old sitemap), `framework-hints.md` (what the detector reads per framework and how to fix each hint), `config.md` (`.launch.json` schema with an example), `reading-the-gate.md`.
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(pre-launch): mechanical gate, human checklist with resumable progress, and references`

---

### Task 16: `post-launch` — cutover verification, baseline diff, 30-day watch

**Files:**
- Create: `skills/post-launch/scripts/lib/{cutover,watch,plan}.mjs`, `skills/post-launch/scripts/post-launch.mjs`, `skills/post-launch/SKILL.md`, `skills/post-launch/references/{cutover-day,thirty-day-watch,baseline-diff,reading-the-report}.md`
- Test: `test/post-launch-cutover.test.mjs`, `test/post-launch-watch.test.mjs`, `test/post-launch-cli.test.mjs`

**Interfaces:**
- `runCutover({net, dns, browser, options: {url, baseline, oldUrl, redirectsCsv, expectAnalytics, stagingUrl, expectDns: {apex: [], www: []}}, now}) → {findings, diff, notCovered, humanItems}`; check ids: `cutover.dns-unexpected` (high), `cutover.dns-propagation` (info; per resolver), `cutover.https-cert-host` (blocker), `cutover.http-redirect` (high), `cutover.canonical-host` (high), `cutover.noindex-live` (blocker), `cutover.robots-live` (high), `cutover.sitemap-live` (high), `cutover.sitemap-references-staging` (high), `cutover.redirect-drift` (high; one per csv row that doesn't 301/308 in one hop to the expected target), `cutover.baseline-missing-page` (high), `cutover.baseline-changed` (medium; per changed field), `cutover.baseline-new-redirect` (medium), `cutover.analytics-missing` (high), `cutover.analytics-not-firing` (high; browser tier), `cutover.form-endpoint-down` (high), `cutover.staging-still-indexable` (high), `cutover.old-host-serving-content` (high), `cutover.security-headers-regressed` (medium), `cutover.human-items` (info: submit sitemap to Search Console and Bing; request indexing for top pages; confirm Search Console property; verify analytics real-time; keep old host up; announce after clean report).
- `dns.resolveAcross(host, resolvers = ['8.8.8.8','1.1.1.1','9.9.9.9','208.67.222.222']) → [{resolver, a[], aaaa[], cname|null, error}]` using `node:dns.Resolver` with `setServers` (injectable).
- `watchPlan(day) → [{due: 'today'|'overdue'|'upcoming', day, task, automated: boolean, command|null}]` from a fixed schedule table in `plan.mjs` (spec §6.2); `runWatch({…, day}) → {plan, findings (re-run of automated cutover checks + inventory/links/head), state}`; state file `watch.json` `{startedAt, runs: [{day, at, blockers, high}]}`.
- CLI: `post-launch.mjs --mode cutover|watch --url … [--baseline] [--old-url] [--redirects] [--expect-analytics] [--staging-url] [--expect-dns apex=1.2.3.4,www=cname.host] [--day N] [--json]`. Exit 0 always (usage → 2).

- [ ] **Step 1: Write failing tests** — cutover on a recorded "good production" fixture yields only `info`; on a "bad cutover" fixture yields `noindex-live` blocker first in sorted order, `redirect-drift` for a row that 302s, `baseline-missing-page` for a removed page, `staging-still-indexable`; `watchPlan(1)` lists daily items due; `watchPlan(9)` marks day-3 items overdue if no run recorded; state round-trip.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.** SKILL.md: two modes, when to run each, inputs (pointing at the pre-launch/audit bundles), the rule that blockers are read first and announced last, `Not covered` verbatim. References: `cutover-day.md` (the ordered day script, why each step is where it is), `thirty-day-watch.md` (the schedule with what to look at in Search Console/analytics and what "healthy" looks like; old-host decommission rule), `baseline-diff.md` (what each diff field means and which changes are expected), `reading-the-report.md`.
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(post-launch): cutover verification, baseline diff, and the thirty-day watch`

---

### Task 17: Generated check inventory, sources, README, AGENTS.md, marketplace, fixture-coverage test

**Files:**
- Create: `scripts/gen-checks-doc.mjs`, `docs/checks.md`, `docs/sources.md`, `docs/smoke.md`, `README.md`, `AGENTS.md`, `.claude-plugin/marketplace.json`
- Test: `test/docs.test.mjs`, `test/fixture-coverage.test.mjs`

**Interfaces:**
- `gen-checks-doc.mjs` imports every `checks/*.mjs` (audit), the pre-launch check modules, and the post-launch cutover module, builds one registry, renders a markdown table per phase (`id | dimension | severity | tier | title | catches`), writes `docs/checks.md` with a header stating it is generated and the total count.
- `test/docs.test.mjs`: regenerating into a string equals the committed file byte-for-byte; `README.md` mentions each of the three skill names and the strings `read-only`, `Not covered`, `Node 20`; `marketplace.json` lists the three skill paths and they exist.
- `test/fixture-coverage.test.mjs`: for every id in the full registry, at least one test file references the id inside a passing assertion **and** at least one negative fixture assertion — implemented by scanning `test/*.test.mjs` for the literal id string appearing ≥ 2 times; the failure message names the uncovered ids.

- [ ] **Step 1: Write failing tests.**
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement the generator and write the docs.** README sections: what it is (three phases, one sentence each) · honesty rules · install for Claude Code (`/plugin marketplace add ethanplusai/website-launch-skill`), for Codex / Copilot / Cursor / Gemini CLI / Goose / others (clone; point the agent at `skills/`, or copy the three directories together), and without any agent (the three commands) · the optional browser tier (`npm i -D playwright axe-core lighthouse && npx playwright install chromium`) · what each phase produces · what it never does · how to contribute a check (register + two fixtures + reference paragraph) · sources. `AGENTS.md`: three paragraphs — the three skills and when to use each, the golden rule, the `Not covered` rule. `marketplace.json`: name `website-launch-skill`, one plugin `website-launch` with `skills: ["./skills/pre-launch","./skills/launch-audit","./skills/post-launch"]`. `docs/sources.md`: attribution list per spec §7. `docs/smoke.md`: the manual real-site smoke procedure and a checklist for reading every finding.
- [ ] **Step 4: Run, expect pass** — full `npm test` green.
- [ ] **Step 5: Commit** — `docs: generated check inventory, sources, README for any agent, marketplace metadata`

---

### Task 18: Real-site smoke, fixes, and release readiness

**Files:**
- Modify: whatever the smoke surfaces; `docs/smoke.md` (record the run)
- Create: `.agents/sessions/<date>-smoke-and-release.md`

- [ ] **Step 1:** From a scratch directory, run `launch-audit` against a small public static site with `--browser auto` (with and without Playwright installed) and read the entire bundle; confirm every finding is true and every `Not covered` line is accurate.
- [ ] **Step 2:** Run `pre-launch` against `test/fixtures/passing-site` and against one real local Astro or Next repo if available; confirm exit codes and that the human walk-through resumes after interruption.
- [ ] **Step 3:** Run `post-launch --mode cutover` against the same public site using the audit's `baseline.json` as `--baseline`; confirm the diff is empty and the human items print.
- [ ] **Step 4:** Fix every false positive or crash with a regression fixture and test before the fix; commit each as `fix(<area>): …`.
- [ ] **Step 5:** Run `npm test`; confirm `docs/checks.md` regenerates unchanged; confirm the vendor test still passes; tag `v0.1.0`; write the session summary.
- [ ] **Step 6: Commit** — `chore: smoke-tested against a real site; v0.1.0`

---

## Self-review

**Spec coverage.** §2 layout → Tasks 1, 14–17. §3 engine modules → Tasks 2–8, 13 (`slug`, `fs-util` in 1; `image-dims` in 10; `dns` in 9; `detect/*` in 11 and 15). §3.2 schema → 2. §3.3 bundle and `Not covered` → 8, 14. §3.4 baseline → 8, 16. §4 gate groups 1–5 and the human list → 15. §5 dimensions 1–13 → 9 (2, 3), 10 (4), 11 (5, 6, 7, 10, 11), 12 (1, 8-http, 9-http, 12, 13), 13 (8-browser, 9-browser, 10-browser, 11-screenshots). §6 cutover and watch → 16. §7 docs → 14, 15, 16 references; 17 inventory/sources/README. §8 testing → every task; fixture-coverage and contract tests in 14 and 17; smoke in 18. §9 out of scope → nothing planned for it. Gap found and fixed: `inventory.*` ids had no home → added to Task 12; `bodyBytes` on `net.get` needed by images/OG → noted in Task 10 as an extension of Task 4.

**Placeholders.** None: every task names its ids, fixtures, and assertions; implementation steps for large check modules list the exact ids, severities, and triggering conditions rather than full code, which is the contract a fresh implementer needs.

**Type consistency.** `finding()` fields match `ctx.mk` usage; `defineCheck.run(ctx)` returns `Finding[]`; `net.get` result fields (`status, finalUrl, headers, body, chain, error, timedOut, bytes`, plus `bodyBytes` from Task 10) are used identically in 7, 9–12, 16; `Page` fields from Task 5 are the ones consumed in 10–12; `Baseline` from 8 is what 16 diffs; the ops `auto` ids reference real check ids from 9–11.
