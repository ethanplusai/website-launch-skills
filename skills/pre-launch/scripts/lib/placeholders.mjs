// Group 2 — placeholders and leaks: the strings that mean the site is not finished, and the ones
// that mean it was built for somebody else's machine.
//
// The patterns are the shared ones (`detect/placeholders.mjs`), proved one by one in
// `detect.test.mjs`. What this module decides is the *surface*: which files each check reads, and
// what counts as a hit once it has read them.
//
// Two surfaces, and both matter:
//
// - **Source** catches the placeholder that is still in the template and would come back the next
//   time somebody builds, even if today's output happens not to show it.
// - **Build output** catches the placeholder that only exists after a generator ran, and the dev
//   host that only leaks once a bundler has inlined a variable.
//
// The one severity a flag may change in this whole skill is here: `placeholders.source-maps` is
// advisory by default and a blocker under `--strict`. Nothing else moves, in either direction.

import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { defineCheck, SkipCheck } from '../../../launch-audit/scripts/lib/registry.mjs'
import { walk } from '../../../launch-audit/scripts/lib/fs-util.mjs'
import { PLACEHOLDER_TEXT, PLACEHOLDER_IDS, DEV_HOSTS, scanText } from '../../../launch-audit/scripts/lib/detect/placeholders.mjs'
import { isIgnoredPath } from './context.mjs'

const PHASE = 'pre-launch'
const DIMENSION = 'placeholders'
const check = (def) => defineCheck({ phase: PHASE, dimension: DIMENSION, tier: 'repo', severity: 'blocker', ...def })

const file = (value) => ({ type: 'file', value })
const text = (value) => ({ type: 'text', value })
const MAX_LISTED = 20
const MAX_FILE_BYTES = 2 * 1024 * 1024

// The directories a site's own words and markup live in. Everything else in a repository —
// configuration, tooling, the README — is allowed to say `TODO`, and flagging it would train
// people to ignore this check.
const SOURCE_DIRS = [
  'src', 'content', 'pages', 'app', 'components', 'layouts', 'public', 'static',
  'templates', 'views', 'site', '_includes', '_layouts', 'themes', 'data', 'posts',
]

const TEXT_EXTENSIONS = new Set([
  '.html', '.htm', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.astro',
  '.md', '.mdx', '.markdown', '.json', '.txt', '.xml', '.css', '.scss', '.yaml', '.yml',
  '.njk', '.liquid', '.hbs', '.ejs', '.pug', '.php', '.webmanifest',
])

const extensionOf = (name) => {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot).toLowerCase()
}

function readIfText(full) {
  if (!TEXT_EXTENSIONS.has(extensionOf(full))) return null
  try {
    if (statSync(full).size > MAX_FILE_BYTES) return null
    return readFileSync(full, 'utf8')
  } catch {
    return null
  }
}

// The source directories this repository actually has. A repository that keeps its content
// somewhere unlisted is scanned only through its build output, and the check says which
// directories it did look at rather than implying it looked everywhere. A source directory the
// operator ignored with --ignore-dir is not one it looked at, so it is not named as one.
const existingSourceDirs = (ctx) => SOURCE_DIRS.filter((name) => existsSync(join(ctx.dir, name)))
const presentSourceDirs = (ctx) => existingSourceDirs(ctx).filter((name) => !isIgnoredPath(name, ctx.config.ignoreDirs))

// One line naming the bound, for "Not covered". Every placeholders check that reads source emits
// it; the runner de-duplicates, so the reader sees it once.
export function sourceScanNote(ctx) {
  const present = presentSourceDirs(ctx)
  if (present.length > 0) return `placeholders: source scan limited to ${present.join(', ')}`
  // The repository does have source folders, and the operator ignored every one of them. Saying it
  // has none would be false, and would contradict the "ignored by request" line beside it.
  const existing = existingSourceDirs(ctx)
  if (existing.length > 0) {
    return `placeholders: no source directory was scanned — ${existing.join(', ')} ${existing.length === 1 ? 'was' : 'were'} ignored by request, so only the build output was searched`
  }
  // A whole sentence, because somebody reads this line out loud. It names every directory the scan
  // knows, which is also the answer to "then where should mine be?".
  return `placeholders: no source directory was scanned — this repository has none of ${SOURCE_DIRS.join(', ')}, so only the build output was searched`
}

// Every text file under the source directories this repository actually has, as
// `{ label, body }` where the label is the path a person would open.
function sourceFiles(ctx) {
  const out = []
  for (const name of presentSourceDirs(ctx)) {
    const dir = join(ctx.dir, name)
    let entries
    try {
      entries = walk(dir)
    } catch {
      continue
    }
    for (const full of entries) {
      const label = full.slice(ctx.dir.length + 1).split('\\').join('/')
      if (isIgnoredPath(label, ctx.config.ignoreDirs)) continue
      const body = readIfText(full)
      if (body === null) continue
      out.push({ label, body })
    }
  }
  return out
}

// Every text file in the build output, labelled by its path inside the build directory.
function buildFiles(ctx, extensions = null) {
  if (ctx.buildDir === null) return []
  const out = []
  for (const rel of ctx.files) {
    if (extensions !== null && !extensions.has(extensionOf(rel))) continue
    const body = readIfText(join(ctx.buildDir, rel))
    if (body === null) continue
    out.push({ label: `${ctx.buildDirName}/${rel}`, body })
  }
  return out
}

const lineOf = (body, index) => body.slice(0, index).split('\n').length

// One evidence line per hit: where it is, and the thing that was actually matched. A check that
// says "placeholders found" without quoting one is a check nobody can act on.
function hitsIn(sources, patterns, options = {}) {
  const hits = []
  for (const { label, body } of sources) {
    for (const hit of scanText(body, patterns, options)) {
      hits.push({ label, line: lineOf(body, hit.index), match: hit.match })
    }
  }
  return hits
}

const evidenceFor = (hits) => hits.slice(0, MAX_LISTED).map((h) => file(`${h.label}:${h.line} — ${h.match}`))

const summarise = (hits, what) =>
  `${hits.length} ${what}${hits.length === 1 ? '' : 's'} in ${new Set(hits.map((h) => h.label)).size} file${new Set(hits.map((h) => h.label)).size === 1 ? '' : 's'}`

const FORM_ID_PATTERNS = PLACEHOLDER_IDS.filter((p) => /formspree|form/i.test(p.source))
const ANALYTICS_ID_PATTERNS = PLACEHOLDER_IDS.filter((p) => !FORM_ID_PATTERNS.includes(p))

// ------------------------------------------------------------------------------------ the checks

const analyticsId = check({
  id: 'placeholders.analytics-id',
  title: 'A placeholder analytics id',
  catches: 'a measurement id nobody replaced, so the launch collects no data and nobody notices for a month',
  run(ctx) {
    const notCovered = [sourceScanNote(ctx)]
    const hits = hitsIn([...sourceFiles(ctx), ...buildFiles(ctx)], ANALYTICS_ID_PATTERNS)
    if (hits.length === 0) return { findings: [], notCovered }
    return {
      notCovered,
      findings: [this.mk({
        title: 'A placeholder analytics id',
        detail: `${summarise(hits, 'placeholder measurement id')}; the site will report to nothing`,
        evidence: evidenceFor(hits),
        fix: 'Put the real measurement id in, from the analytics property that will receive production traffic.',
      })],
    }
  },
})

const formId = check({
  id: 'placeholders.form-id',
  title: 'A placeholder form endpoint',
  catches: 'a contact form posting to an example endpoint, so every enquiry is lost silently',
  run(ctx) {
    const notCovered = [sourceScanNote(ctx)]
    const hits = hitsIn([...sourceFiles(ctx), ...buildFiles(ctx)], FORM_ID_PATTERNS)
    if (hits.length === 0) return { findings: [], notCovered }
    return {
      notCovered,
      findings: [this.mk({
        title: 'A placeholder form endpoint',
        detail: `${summarise(hits, 'placeholder form id')}; submissions to it go nowhere`,
        evidence: evidenceFor(hits),
        fix: 'Point the form at the real endpoint, then send a test submission and confirm a human received it.',
      })],
    }
  },
})

const copy = check({
  id: 'placeholders.copy',
  title: 'Placeholder copy in the site',
  catches: 'lorem ipsum, TODO markers and unreplaced template tokens shipping as page content',
  run(ctx) {
    const sources = sourceFiles(ctx)
    // The build's *rendered* text and its head, rather than its markup: a `{{ }}` in a compiled
    // template is markup, and a `{{ }}` a reader can see is a defect.
    const rendered = []
    for (const [rel, { page }] of ctx.html) {
      const parts = [page.text, page.head.title ?? '', page.head.metaByName.get('description') ?? '']
      rendered.push({ label: `${ctx.buildDirName}/${rel}`, body: parts.join('\n') })
    }
    const notCovered = [sourceScanNote(ctx)]
    const hits = hitsIn([...sources, ...rendered], PLACEHOLDER_TEXT)
    if (hits.length === 0) return { findings: [], notCovered }
    return {
      notCovered,
      findings: [this.mk({
        title: 'Placeholder copy in the site',
        detail: `${summarise(hits, 'placeholder string')}; a visitor would read them`,
        evidence: evidenceFor(hits),
        fix: 'Replace each with the real copy, or delete the block it is in if the section was never meant to ship.',
      })],
    }
  },
})

const requiredEnv = check({
  id: 'placeholders.required-env',
  title: 'A required environment variable is not set',
  catches: 'a production build interpolating an undefined variable into the page as an empty string',
  run(ctx) {
    const names = ctx.config.requiredEnv
    if (names.length === 0) {
      throw new SkipCheck('no --required-env names were given, so there is nothing to look for')
    }
    const missing = names.filter((name) => !ctx.envNames.has(name))
    if (missing.length === 0) return []
    return [this.mk({
      title: 'A required environment variable is not set',
      detail: `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} defined neither in this environment nor in .env.production or .env, so the build interpolated nothing where ${missing.length === 1 ? 'it was' : 'they were'} used`,
      evidence: missing.map((name) => text(`${name} is not defined`)),
      fix: 'Set each name in the hosting project\'s production environment, and in .env.production for local builds, then rebuild.',
    })]
  },
})

const devHost = check({
  id: 'placeholders.dev-host',
  title: 'A development or staging host in the build output',
  catches: 'a localhost or preview-deploy url shipped to production, where it is a dead link or a duplicate-content copy',
  run(ctx) {
    // The site's own production host is never a leak, however it is spelled, and neither is an
    // operator-supplied host that happens to be the production one.
    const extraHosts = ctx.config.devHosts.filter((host) => String(host).trim().toLowerCase() !== ctx.prodHost.toLowerCase())
    const hits = hitsIn(buildFiles(ctx), DEV_HOSTS, { extraHosts })
      .filter((hit) => !ctx.prodHost.toLowerCase().includes(hit.match.toLowerCase().replace(/^\.|\.$/g, '')))
    if (hits.length === 0) return []
    return [this.mk({
      title: 'A development or staging host in the build output',
      detail: `${summarise(hits, 'development host reference')}; ${ctx.prodHost} is the only host this build should name`,
      evidence: evidenceFor(hits),
      fix: 'Drive every url from the production site url in configuration rather than a hard-coded host, then rebuild.',
    })]
  },
})

const SOURCEMAP_COMMENT = /\/\/#\s*sourceMappingURL=(\S+)/
const SOURCEMAP_CSS = /\/\*#\s*sourceMappingURL=(\S+)/
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.css'])

const sourceMaps = check({
  id: 'placeholders.source-maps',
  title: 'Source maps referenced from the build',
  severity: 'low',
  catches: 'original source published alongside the bundle, readable by anybody who opens devtools',
  run(ctx) {
    const hits = hitsIn(buildFiles(ctx, SCRIPT_EXTENSIONS), [SOURCEMAP_COMMENT, SOURCEMAP_CSS])
    const mapFiles = ctx.files.filter((rel) => rel.endsWith('.map'))
    if (hits.length === 0 && mapFiles.length === 0) return []
    // The one severity in this skill a flag may raise. It never goes the other way: --strict makes
    // this a blocker, and nothing makes a blocker advisory.
    const severity = ctx.config.strict ? 'blocker' : 'low'
    const evidence = [...evidenceFor(hits), ...mapFiles.slice(0, MAX_LISTED).map((rel) => file(`${ctx.buildDirName}/${rel}`))]
    return [this.mk({
      severity,
      title: 'Source maps referenced from the build',
      detail: `${hits.length} sourceMappingURL reference${hits.length === 1 ? '' : 's'} and ${mapFiles.length} .map file${mapFiles.length === 1 ? '' : 's'} in the output${ctx.config.strict ? '' : ' — advisory unless --strict'}`,
      evidence: evidence.length > 0 ? evidence : [text('source maps are present in the build output')],
      fix: 'Turn source maps off for the production build, or upload them to the error tracker instead of publishing them.',
    })]
  },
})

export const checks = [analyticsId, formId, copy, requiredEnv, devHost, sourceMaps]
