// Repo-side framework detection, and the redirect files a host reads.
//
// The gate needs two things from a repository before it can say anything useful about the build:
// which generator produced it, and what that generator was told to do. Both come out of two cheap
// signals — the dependency list, and a light regex read of the config file — because installing
// the framework to ask it properly would turn a read-only gate into an npm install.
//
// Two rules hold throughout:
//
// - **A guess is worse than nothing.** A repository that matches no signature answers `null` for
//   every field, and the checks that would have used those fields skip with a reason. A wrong
//   framework hint sends somebody looking for a sitemap integration nobody configured.
// - **Regexes read config, they do not evaluate it.** `site: 'https://x'` written across two lines
//   or built from a variable is simply not found, which is reported as "not detected" rather than
//   as a mismatch. The checks above are written so that an undetected value skips rather than
//   fails.
//
// `parseRedirects` normalises five different host formats onto one rule shape,
// `{from, to, status, wildcard}`. `wildcard` is the field the gate actually cares about: a rule
// whose source contains `*`, `:`, `(` or `.*` matches paths nobody enumerated, which is how a
// migration ends up serving the homepage to forty old article urls and losing all of them.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const read = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// The first of `names` that exists in `dir`, as a full path.
function firstExisting(dir, names) {
  for (const name of names) {
    const full = join(dir, name)
    if (existsSync(full)) return full
  }
  return null
}

const configVariants = (base) => ['mjs', 'js', 'ts', 'cjs', 'mts'].map((ext) => `${base}.${ext}`)

const capture = (text, pattern) => {
  if (text === null) return null
  const found = pattern.exec(text)
  return found === null ? null : found[1]
}

const depsOf = (pkg) => ({ ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) })

const SITE = /\bsite\s*:\s*['"`]([^'"`]+)/
const SITE_URL = /\bsiteUrl\s*:\s*['"`]([^'"`]+)/
const BASE_URL_TOML = /^\s*baseURL\s*=\s*["']([^"']+)/m
const TRAILING_SLASH_WORD = /\btrailingSlash\s*:\s*['"`](always|never|ignore)/
const TRAILING_SLASH_BOOL = /\btrailingSlash\s*:\s*(true|false)/

function trailingSlashFrom(text) {
  if (text === null) return null
  const word = TRAILING_SLASH_WORD.exec(text)
  if (word !== null) return word[1]
  const bool = TRAILING_SLASH_BOOL.exec(text)
  if (bool !== null) return bool[1] === 'true' ? 'always' : 'never'
  return null
}

const NONE = { name: null, configPath: null, buildDirGuess: null, siteUrl: null, sitemapIntegration: null, trailingSlash: null }

// Each entry is asked in order, and the first one that recognises the repository wins. Order
// matters: Astro, Nuxt and SvelteKit all bring Vite with them, so Vite is asked last and only ever
// answers for a repository that is nothing but Vite.
const SIGNATURES = [
  {
    name: 'astro',
    configs: configVariants('astro.config'),
    dep: (deps) => deps.astro !== undefined,
    buildDirGuess: 'dist',
    read: (text, deps) => ({
      siteUrl: capture(text, SITE),
      sitemapIntegration: deps['@astrojs/sitemap'] !== undefined || /@astrojs\/sitemap/.test(text ?? ''),
      trailingSlash: trailingSlashFrom(text),
      sitemapFile: 'sitemap-index.xml',
    }),
  },
  {
    name: 'next',
    configs: configVariants('next.config'),
    dep: (deps) => deps.next !== undefined,
    buildDirGuess: '.next',
    read: (text, deps) => ({
      siteUrl: capture(text, SITE_URL) ?? capture(read(join(deps.__dir, 'next-sitemap.config.js')), SITE_URL),
      sitemapIntegration: deps['next-sitemap'] !== undefined,
      trailingSlash: trailingSlashFrom(text),
      sitemapFile: 'sitemap.xml',
    }),
  },
  {
    name: 'nuxt',
    configs: configVariants('nuxt.config'),
    dep: (deps) => deps.nuxt !== undefined,
    buildDirGuess: '.output/public',
    read: (text, deps) => ({
      siteUrl: capture(text, SITE_URL) ?? capture(text, /\burl\s*:\s*['"`](https?:[^'"`]+)/),
      sitemapIntegration: deps['@nuxtjs/sitemap'] !== undefined || deps['nuxt-simple-sitemap'] !== undefined,
      trailingSlash: trailingSlashFrom(text),
      sitemapFile: 'sitemap.xml',
    }),
  },
  {
    name: 'sveltekit',
    configs: configVariants('svelte.config'),
    dep: (deps) => deps['@sveltejs/kit'] !== undefined,
    buildDirGuess: 'build',
    read: (text, deps) => ({
      siteUrl: capture(text, SITE_URL),
      sitemapIntegration: deps['svelte-sitemap'] !== undefined || deps['super-sitemap'] !== undefined,
      trailingSlash: trailingSlashFrom(text),
      sitemapFile: 'sitemap.xml',
    }),
  },
  {
    name: 'eleventy',
    configs: ['.eleventy.js', '.eleventy.cjs', 'eleventy.config.js', 'eleventy.config.cjs', 'eleventy.config.mjs'],
    dep: (deps) => deps['@11ty/eleventy'] !== undefined,
    buildDirGuess: '_site',
    read: (text) => ({
      siteUrl: capture(text, SITE_URL) ?? capture(text, SITE),
      sitemapIntegration: null,
      trailingSlash: trailingSlashFrom(text),
      sitemapFile: 'sitemap.xml',
    }),
  },
  {
    name: 'hugo',
    configs: ['hugo.toml', 'hugo.yaml', 'hugo.json', 'config.toml', 'config/_default/hugo.toml'],
    dep: () => false,
    buildDirGuess: 'public',
    // `config.toml` is not Hugo's name for anything any more, and plenty of tools use it. A file
    // called `hugo.*` is Hugo by name; a `config.toml` is Hugo only if it declares a baseURL.
    // Without this a Vite project with an unrelated config.toml detects as a static site
    // generator it does not use.
    accepts: (configPath, text) => /(^|[/\\])hugo\.(toml|yaml|json)$/.test(configPath) || BASE_URL_TOML.test(text ?? ''),
    // Hugo ships a sitemap template in the default theme set, so the integration question is
    // answered by the generator itself rather than by a plugin.
    read: (text) => ({
      siteUrl: capture(text, BASE_URL_TOML) ?? capture(text, /^\s*baseURL\s*:\s*["']?([^"'\n]+)/m),
      sitemapIntegration: true,
      trailingSlash: null,
      sitemapFile: 'sitemap.xml',
    }),
    requiresConfig: true,
  },
  {
    name: 'wordpress',
    configs: ['wp-config.php'],
    dep: () => false,
    buildDirGuess: null,
    read: () => ({ siteUrl: null, sitemapIntegration: null, trailingSlash: null, sitemapFile: 'wp-sitemap.xml' }),
    requiresConfig: true,
  },
  {
    name: 'vite',
    configs: configVariants('vite.config'),
    dep: (deps) => deps.vite !== undefined,
    buildDirGuess: 'dist',
    read: (text) => ({
      siteUrl: null,
      sitemapIntegration: null,
      trailingSlash: trailingSlashFrom(text),
      sitemapFile: 'sitemap.xml',
    }),
  },
]

export function detectFramework(dir, pkg) {
  const deps = depsOf(pkg)
  deps.__dir = dir
  for (const signature of SIGNATURES) {
    const configPath = firstExisting(dir, signature.configs)
    const byDep = signature.dep(deps)
    // A config file alone is enough for the generators that have no npm presence (Hugo,
    // WordPress); for the rest, either signal will do — a repository with `astro` in its
    // dependencies and no config still builds with Astro's defaults.
    if (configPath === null && (byDep === false || signature.requiresConfig === true)) continue
    const text = configPath === null ? null : read(configPath)
    // A signature may refuse a file that merely has the right name — see Hugo's `config.toml`.
    if (signature.accepts !== undefined && !signature.accepts(configPath ?? '', text)) continue
    const fields = signature.read(text, deps)
    return {
      name: signature.name,
      configPath,
      buildDirGuess: signature.buildDirGuess,
      siteUrl: fields.siteUrl ?? null,
      sitemapIntegration: fields.sitemapIntegration ?? null,
      trailingSlash: fields.trailingSlash ?? null,
      sitemapFile: fields.sitemapFile ?? 'sitemap.xml',
    }
  }
  return { ...NONE, sitemapFile: 'sitemap.xml' }
}

// --------------------------------------------------------------------------------- redirect files

const WILDCARD = /[*:(]|\.\*/

const rule = (from, to, status) => ({
  from: String(from).trim(),
  to: String(to).trim(),
  status: Number(status) || 301,
  wildcard: WILDCARD.test(String(from)),
})

function fromVercel(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const list = Array.isArray(parsed?.redirects) ? parsed.redirects : []
  return list
    .filter((r) => typeof r?.source === 'string' && typeof r?.destination === 'string')
    .map((r) => rule(r.source, r.destination, r.permanent === false ? 302 : 301))
}

// `[[redirects]]` blocks, read as a flat key scan between one header and the next. A TOML parser
// would be more correct and would also be a dependency; the three keys that matter are each a
// `key = "value"` line, and anything cleverer in a netlify.toml is out of this tool's scope.
function fromNetlifyToml(text) {
  const rules = []
  const blocks = text.split(/^\s*\[\[redirects\]\]\s*$/m).slice(1)
  for (const block of blocks) {
    const upto = block.split(/^\s*\[/m)[0]
    const from = capture(upto, /^\s*from\s*=\s*["']([^"']+)/m)
    const to = capture(upto, /^\s*to\s*=\s*["']([^"']+)/m)
    const status = capture(upto, /^\s*status\s*=\s*(\d+)/m)
    if (from !== null && to !== null) rules.push(rule(from, to, status ?? 301))
  }
  return rules
}

// The Netlify/Cloudflare `_redirects` format: `from  to  [status]`, one per line, `#` comments.
function fromPlainRedirects(text) {
  const rules = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 2) continue
    const [from, to, status] = parts
    // Netlify writes a forced rule as `301!`; the bang changes who wins, not what the status is.
    const code = String(status ?? '').replace(/!$/, '')
    rules.push(rule(from, to, /^\d{3}$/.test(code) ? code : 301))
  }
  return rules
}

// `source:`/`destination:` pairs anywhere in a next.config, read in written order. The config is
// JavaScript and may compute its redirects, so this finds the literal ones and nothing else —
// which is the honest limit, and why `framework.redirect-targets` reports what it parsed.
function fromNextConfig(text) {
  const rules = []
  const pair = /source\s*:\s*['"`]([^'"`]+)['"`][\s\S]{0,200}?destination\s*:\s*['"`]([^'"`]+)['"`]([\s\S]{0,120}?permanent\s*:\s*(true|false))?/g
  let found
  while ((found = pair.exec(text))) rules.push(rule(found[1], found[2], found[4] === 'false' ? 302 : 301))
  return rules
}

function fromHtaccess(text) {
  const rules = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const redirect = /^Redirect(?:Permanent)?\s+(?:(\d{3})\s+)?(\S+)\s+(\S+)/i.exec(trimmed)
    if (redirect !== null) {
      rules.push(rule(redirect[2], redirect[3], redirect[1] ?? 301))
      continue
    }
    const rewrite = /^RewriteRule\s+(\S+)\s+(\S+)(?:\s+\[([^\]]*)\])?/i.exec(trimmed)
    if (rewrite !== null) {
      const flags = rewrite[3] ?? ''
      if (!/\bR(?:=\d{3})?\b/i.test(flags)) continue
      const status = /R=(\d{3})/i.exec(flags)
      rules.push(rule(rewrite[1], rewrite[2], status === null ? 302 : status[1]))
    }
  }
  return rules
}

// `_redirects` is written to the directory the host serves, which is the build output — but in a
// repository it is authored in whichever directory the generator copies verbatim.
const PLAIN_REDIRECT_PATHS = ['_redirects', 'public/_redirects', 'static/_redirects', 'src/_redirects']

const REDIRECT_SOURCES = [
  { names: ['vercel.json'], parse: fromVercel },
  { names: ['netlify.toml'], parse: fromNetlifyToml },
  { names: PLAIN_REDIRECT_PATHS, parse: fromPlainRedirects },
  { names: configVariants('next.config'), parse: fromNextConfig },
  { names: ['.htaccess', 'public/.htaccess'], parse: fromHtaccess },
]

// The first redirect file the repository has, with its rules. One file wins: a repository with
// both a vercel.json and an .htaccess is deploying to one host, and merging the two would invent
// a rule set that never runs anywhere.
export function parseRedirects(dir) {
  for (const source of REDIRECT_SOURCES) {
    const file = firstExisting(dir, source.names)
    if (file === null) continue
    const text = read(file)
    if (text === null) continue
    const rules = source.parse(text)
    if (rules.length === 0) continue
    return { file, rules }
  }
  return { file: null, rules: [] }
}
