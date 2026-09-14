// Group 4 — the build output: sixteen checks over the files that are about to be uploaded.
//
// This is the stack-agnostic core of the gate. It reads HTML and bytes and knows nothing about the
// generator that produced them, which is deliberate: the same sixteen checks have to be worth
// running on an Astro build, a Hugo build and a folder somebody assembled by hand.
//
// The conventions the whole group shares:
//
// - **The build directory is the world.** A reference resolves if a file in the build would serve
//   it — `/about` is `about.html` or `about/index.html` — and an absolute url to another host is
//   somebody else's problem, not a broken link.
// - **No build directory is a skip, not sixteen failures.** `build.dir-found` already said the
//   directory is missing; repeating it in every check would bury it.
// - **A noindex page is exempt from the checks that only matter to a search engine.** A 404 page
//   with no canonical is correct; a product page with no canonical is not.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineCheck, SkipCheck } from '../../../launch-audit/scripts/lib/registry.mjs'
import { imageDimensions } from '../../../launch-audit/scripts/lib/image-dims.mjs'
import { parseSitemap } from '../../../launch-audit/scripts/lib/sitemap.mjs'
import { parseRobots } from '../../../launch-audit/scripts/lib/robots.mjs'
import { normalizePath, resolveInBuild } from './context.mjs'

const PHASE = 'pre-launch'
const DIMENSION = 'output'
const check = (def) => defineCheck({ phase: PHASE, dimension: DIMENSION, tier: 'repo', severity: 'blocker', ...def })

const file = (value) => ({ type: 'file', value })
const text = (value) => ({ type: 'text', value })
const html = (value) => ({ type: 'html', value })
const url = (value) => ({ type: 'url', value })
const MAX_LISTED = 20

const listed = (values, make = text) => values.slice(0, MAX_LISTED).map(make)

function requireBuild(ctx) {
  if (ctx.buildDirNote !== null) throw new SkipCheck(ctx.buildDirNote)
  if (ctx.buildDir === null) throw new SkipCheck('there is no build output directory to read')
}

// Every HTML page in the build, in path order, with the label a person would open.
function pages(ctx) {
  return [...ctx.html.entries()].map(([rel, entry]) => ({ rel, ...entry }))
}

const isNoindex = (page) => typeof page.head.robots === 'string' && page.head.robots.includes('noindex')

const bytesOf = (ctx, rel) => {
  try {
    return readFileSync(join(ctx.buildDir, rel))
  } catch {
    return null
  }
}

const textOf = (ctx, rel) => {
  try {
    return readFileSync(join(ctx.buildDir, rel), 'utf8')
  } catch {
    return null
  }
}

// ------------------------------------------------------------------------------- references

// Schemes and shapes that are not a path into this build: another origin, a protocol-relative url,
// an in-page anchor, and the four pseudo-schemes a browser handles without fetching anything.
const NOT_A_PATH = /^(#|\/\/|[a-z][a-z0-9+.-]*:)/i

const REF_ATTRIBUTE = /\b(href|src|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi
const SRCSET_ATTRIBUTE = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/gi

// Script bodies are not markup. `window.location.href = d.url;` matches the href pattern, and a
// `href="${p.u}"` written inside a template literal is a string a browser builds at runtime, not a
// file that has to exist — the smoke run found both on one real site and the gate blocked the
// launch over them. `<style>` is left in: the url() references in it are real files.
// The opening tag is kept — a `<script src>` pointing at a file the build does not contain is a
// real broken reference — and only the body between the tags is dropped.
// The attribute run is the tokenizer's (html.mjs TOKEN), so a `>` inside a quoted value — a CSS
// selector in a data attribute, an inline JSON island — does not end the tag early. It used to:
// the opening tag stopped at that `>`, and the lazy body match then ate the rest of the real tag,
// `src` and all, so a `<script src>` pointing at a bundle the build never wrote stopped being a
// broken reference — the exact thing this rule keeps.
const SCRIPT_BODY = /(<script\b(?:\s+[^\s=/><]+(?:\s*=\s*(?:"[^"<]*"|'[^'<]*'|[^\s"'<>]+))?)*\s*>)[\s\S]*?(<\/script\s*>|$)/gi

const withoutScripts = (body) => String(body ?? '').replace(SCRIPT_BODY, '$1$2')

function* rawReferences(source) {
  const body = withoutScripts(source)
  for (const found of body.matchAll(REF_ATTRIBUTE)) yield found[2] ?? found[3] ?? found[4] ?? ''
  for (const found of body.matchAll(SRCSET_ATTRIBUTE)) {
    const value = found[1] ?? found[2] ?? ''
    for (const candidate of value.split(',')) {
      const first = candidate.trim().split(/\s+/)[0]
      if (first) yield first
    }
  }
  for (const found of body.matchAll(CSS_URL)) yield found[1] ?? found[2] ?? found[3] ?? ''
}

// The url path a url points at on this site, or null when it points at another origin. `baseRel`
// is the file the url was written in, so a relative path resolves the way a browser would resolve
// it. An absolute url on the production host resolves too — an `og:image` and a `<loc>` are
// normally written in full, and they are still this build's files.
function sameOriginPath(ctx, reference, baseRel) {
  const raw = String(reference ?? '').trim()
  if (raw === '') return null
  try {
    const resolved = new URL(raw, `${ctx.prodOrigin}/${baseRel}`)
    if (resolved.origin !== ctx.prodOrigin) return null
    return normalizePath(resolved.pathname)
  } catch {
    return null
  }
}

// The same thing for an HTML attribute, where the forms that are not paths at all have to be
// filtered first: an anchor, a protocol-relative url, and the pseudo-schemes a browser handles
// without fetching anything.
function referencePath(ctx, reference, baseRel) {
  const raw = String(reference ?? '').trim()
  if (raw === '' || NOT_A_PATH.test(raw)) return null
  return sameOriginPath(ctx, raw, baseRel)
}

// ------------------------------------------------------------------------------------ the checks

const indexHtml = check({
  id: 'output.index-html',
  title: 'No index.html at the root of the build',
  catches: 'a build whose homepage is not where a host looks for it',
  run(ctx) {
    requireBuild(ctx)
    if (ctx.fileSet.has('index.html')) return []
    return [this.mk({
      title: 'No index.html at the root of the build',
      detail: `${ctx.buildDirName} has no index.html, so the homepage would 404`,
      evidence: [file(`${ctx.buildDirName}/index.html is missing`)],
      fix: 'Check the output directory the generator writes to, and that --build-dir names the one the host serves.',
    })]
  },
})

const FOUR_OH_FOUR = ['404.html', '404/index.html']

const notFoundPage = check({
  id: 'output.404-page',
  title: 'The 404 page is missing, duplicated or indexable',
  catches: 'a missing custom 404, or one that is the homepage, or one search engines will index',
  run(ctx) {
    requireBuild(ctx)
    const rel = FOUR_OH_FOUR.find((candidate) => ctx.fileSet.has(candidate))
    if (rel === undefined) {
      return [this.mk({
        title: 'No 404 page in the build',
        detail: `neither ${FOUR_OH_FOUR.join(' nor ')} exists, so a mistyped url gets the host's default error page`,
        evidence: [file(`${ctx.buildDirName}/404.html is missing`)],
        fix: 'Add a 404 page with navigation back into the site, and mark it noindex.',
      })]
    }
    const entry = ctx.html.get(rel)
    const problems = []
    const index = ctx.html.get('index.html')
    if (index !== undefined && entry !== undefined && index.raw === entry.raw) {
      problems.push(`${rel} is identical to index.html, so a missing page looks like the homepage`)
    }
    if (entry !== undefined && !isNoindex(entry.page)) {
      problems.push(`${rel} has no noindex, so search engines may index the error page`)
    }
    if (problems.length === 0) return []
    return [this.mk({
      title: 'The 404 page is duplicated or indexable',
      detail: problems.join('; '),
      evidence: problems.map(file),
      fix: 'Give the 404 page its own content and a <meta name="robots" content="noindex"> tag.',
    })]
  },
})

const internalRefs = check({
  id: 'output.internal-refs',
  title: 'An internal reference resolves to no file',
  catches: 'a link, image, stylesheet or font that 404s the moment the site is live',
  run(ctx) {
    requireBuild(ctx)
    const broken = []
    const seen = new Set()
    const sources = [
      ...pages(ctx).map((p) => ({ rel: p.rel, body: p.raw })),
      ...ctx.files.filter((rel) => rel.endsWith('.css')).map((rel) => ({ rel, body: textOf(ctx, rel) ?? '' })),
    ]
    for (const { rel, body } of sources) {
      for (const reference of rawReferences(body)) {
        const path = referencePath(ctx, reference, rel)
        if (path === null) continue
        if (resolveInBuild(ctx, path) !== null) continue
        const key = `${rel} -> ${path}`
        if (seen.has(key)) continue
        seen.add(key)
        broken.push(key)
      }
    }
    if (broken.length === 0) return []
    return [this.mk({
      title: 'An internal reference resolves to no file',
      detail: `${broken.length} reference${broken.length === 1 ? '' : 's'} in the build point at paths no file would serve`,
      evidence: listed(broken, file),
      fix: 'Fix each path, or add the missing file. A reference that is meant to be handled at runtime belongs behind a route the host knows about.',
    })]
  },
})

const APPLE_TOUCH = 'apple-touch-icon.png'
const APPLE_TOUCH_SIDE = 180
const MANIFEST_LINK = /<link\b[^>]*\brel\s*=\s*["']?[^"'>]*manifest[^"'>]*["']?[^>]*>/i

const faviconSet = check({
  id: 'output.favicon-set',
  title: 'The favicon set is incomplete',
  catches: 'a browser tab, a bookmark or a phone home screen falling back to a blank page icon',
  run(ctx) {
    requireBuild(ctx)
    const missing = []

    if (!ctx.fileSet.has('favicon.ico')) missing.push('favicon.ico is missing')

    const scalable = ctx.fileSet.has('favicon.svg')
      || ctx.files.some((rel) => /^(favicon|icon)-[\w.]*\.png$/i.test(rel))
    if (!scalable) missing.push('neither favicon.svg nor a favicon-<size>.png / icon-<size>.png exists')

    if (!ctx.fileSet.has(APPLE_TOUCH)) {
      missing.push(`${APPLE_TOUCH} is missing`)
    } else {
      const dims = imageDimensions(bytesOf(ctx, APPLE_TOUCH))
      if (dims.width !== APPLE_TOUCH_SIDE || dims.height !== APPLE_TOUCH_SIDE) {
        missing.push(`${APPLE_TOUCH} is ${dims.width}x${dims.height}, not ${APPLE_TOUCH_SIDE}x${APPLE_TOUCH_SIDE}`)
      }
    }

    // The manifest is checked through the pages, because a manifest nothing links to is a file
    // nobody fetches.
    let manifestPath = null
    for (const page of pages(ctx)) {
      const link = MANIFEST_LINK.exec(page.raw)
      if (link === null) continue
      const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(link[0])
      if (href === null) continue
      manifestPath = referencePath(ctx, href[1] ?? href[2] ?? href[3], page.rel)
      if (manifestPath !== null) break
    }
    if (manifestPath === null) missing.push('no page links to a web app manifest')
    else if (resolveInBuild(ctx, manifestPath) === null) missing.push(`the manifest at ${manifestPath} does not exist in the build`)

    if (missing.length === 0) return []
    return [this.mk({
      title: 'The favicon set is incomplete',
      detail: missing.join('; '),
      evidence: missing.map(file),
      fix: 'Ship favicon.ico, a scalable or sized PNG icon, a 180x180 apple-touch-icon.png, and a manifest every page links to.',
    })]
  },
})

const OG_WIDTH = 1200
const OG_HEIGHT = 630
const OG_TOLERANCE = 0.05
const RETINA_NOTE = `2400x1260 is exactly twice ${OG_WIDTH}x${OG_HEIGHT}: some networks scale it and some crop it, so ship it at ${OG_WIDTH}x${OG_HEIGHT}`

const withinTolerance = (value, target) => Math.abs(value - target) <= target * OG_TOLERANCE

const ogImage = check({
  id: 'output.og-image',
  title: 'The og:image is missing, not raster, or the wrong size',
  catches: 'a social card that renders blank, cropped, or as a grey box on every network',
  run(ctx) {
    requireBuild(ctx)
    const byImage = new Map()
    for (const page of pages(ctx)) {
      const value = page.page.head.metaByProperty.get('og:image')
      if (typeof value !== 'string' || value.trim() === '') continue
      if (!byImage.has(value)) byImage.set(value, [])
      byImage.get(value).push(page.rel)
    }
    // No og:image anywhere is not "nothing to check" — it is every share of every page rendering
    // as a grey box, which is the failure this check exists for.
    if (byImage.size === 0) {
      const all = pages(ctx).map((page) => page.rel)
      return [this.mk({
        title: 'No og:image declared on any page',
        detail: `none of the ${all.length} page${all.length === 1 ? '' : 's'} in the build declares an og:image, so every share of this site renders without a card image`,
        evidence: all.length > 0 ? listed(all, file) : [text(`${ctx.buildDirName} contains no HTML pages`)],
        fix: `Add <meta property="og:image" content="..."> to every page, pointing at a ${OG_WIDTH}x${OG_HEIGHT} raster image on the production host.`,
      })]
    }

    const problems = []
    const notCovered = []
    for (const [image, usedBy] of byImage) {
      const path = sameOriginPath(ctx, image, usedBy[0])
      if (path === null) {
        // The bytes are on another origin and this gate never fetched them, so nothing about this
        // image was verified. Saying so is the difference between a check and a coincidence.
        notCovered.push(`output.og-image: ${image} is hosted off-origin — not verified`)
        continue
      }
      const rel = resolveInBuild(ctx, path)
      if (rel === null) {
        problems.push(`${image} does not exist in the build (used by ${usedBy.join(', ')})`)
        continue
      }
      const dims = imageDimensions(bytesOf(ctx, rel))
      if (dims.type === 'svg' || dims.type === 'unknown') {
        problems.push(`${image} is ${dims.type === 'svg' ? 'an SVG' : 'not a recognised image'}; social networks render raster images only`)
        continue
      }
      if (dims.width === null || dims.height === null) {
        problems.push(`${image} is a ${dims.type} whose dimensions could not be read`)
        continue
      }
      if (withinTolerance(dims.width, OG_WIDTH) && withinTolerance(dims.height, OG_HEIGHT)) continue
      const retina = dims.width === OG_WIDTH * 2 && dims.height === OG_HEIGHT * 2
      problems.push(`${image} is ${dims.width}x${dims.height}, not ${OG_WIDTH}x${OG_HEIGHT}${retina ? ` — ${RETINA_NOTE}` : ''}`)
    }
    if (problems.length === 0) return { findings: [], notCovered }
    return {
      notCovered,
      findings: [this.mk({
        title: 'The og:image is missing, not raster, or the wrong size',
        detail: problems.join('; '),
        evidence: problems.map(url),
        fix: `Export each og:image as a ${OG_WIDTH}x${OG_HEIGHT} PNG or JPEG and reference it with an absolute url on the production host.`,
      })],
    }
  },
})

const robotsTxt = check({
  id: 'output.robots-txt',
  title: 'robots.txt is missing, blocking, or points at another host',
  catches: 'a staging robots.txt shipped to production, which is how a launch gets deindexed on day one',
  run(ctx) {
    requireBuild(ctx)
    if (!ctx.fileSet.has('robots.txt')) {
      return [this.mk({
        title: 'No robots.txt in the build',
        detail: 'nothing tells a crawler where the sitemap is, and the host will serve its own default',
        evidence: [file(`${ctx.buildDirName}/robots.txt is missing`)],
        fix: 'Add a robots.txt with an Allow rule and a Sitemap: line on the production host.',
      })]
    }
    const body = textOf(ctx, 'robots.txt') ?? ''
    const robots = parseRobots(body)
    const problems = []

    // A site-wide Disallow is the single most expensive line a launch can ship, so it is checked
    // on the raw text as well as the parse: the parse is tolerant, and this must not be.
    if (/^\s*Disallow:\s*\/\s*$/im.test(body)) {
      problems.push('robots.txt contains "Disallow: /", which blocks the whole site')
    }
    const sitemaps = robots.sitemaps ?? []
    if (sitemaps.length === 0) {
      problems.push('robots.txt names no Sitemap:')
    }
    for (const sitemap of sitemaps) {
      let host = null
      try {
        host = new URL(sitemap).hostname
      } catch {
        problems.push(`the Sitemap: line "${sitemap}" is not an absolute url`)
        continue
      }
      if (host !== ctx.prodHost) problems.push(`the Sitemap: line points at ${host}, not ${ctx.prodHost}`)
    }
    if (problems.length === 0) return []
    return [this.mk({
      title: 'robots.txt is blocking or points at another host',
      detail: problems.join('; '),
      evidence: problems.map(text),
      fix: `Ship a robots.txt that allows crawling and names the sitemap on ${ctx.prodHost}.`,
    })]
  },
})

const SITEMAP_NAMES = ['sitemap.xml', 'sitemap-index.xml', 'sitemap_index.xml']

const sitemap = check({
  id: 'output.sitemap',
  title: 'The sitemap is missing, off-host, or lists pages the build does not have',
  catches: 'a sitemap that sends crawlers to staging urls or to pages that were never built',
  run(ctx) {
    requireBuild(ctx)
    const rel = SITEMAP_NAMES.find((name) => ctx.fileSet.has(name))
    if (rel === undefined) {
      return [this.mk({
        title: 'No sitemap in the build',
        detail: `none of ${SITEMAP_NAMES.join(', ')} exists, so nothing tells a search engine which pages there are`,
        evidence: [file(`${ctx.buildDirName}/sitemap.xml is missing`)],
        fix: 'Generate a sitemap at build time and reference it from robots.txt.',
      })]
    }

    const problems = []
    const locs = []
    const collect = (from, body) => {
      const parsed = parseSitemap(body ?? '')
      if (parsed.kind === 'invalid') {
        problems.push(`${from}: ${parsed.error}`)
        return
      }
      if (parsed.kind === 'urlset') {
        for (const entry of parsed.entries) locs.push({ loc: entry.loc, from })
        return
      }
      // An index is expanded from disk: the children are files this build wrote, so there is no
      // reason to guess at them and no reason to fetch them.
      for (const entry of parsed.entries) {
        const path = sameOriginPath(ctx, entry.loc, rel)
        const childRel = path === null ? null : resolveInBuild(ctx, path)
        if (childRel === null) {
          problems.push(`${from} lists the child sitemap ${entry.loc}, which is not in the build`)
          continue
        }
        collect(childRel, textOf(ctx, childRel))
      }
    }
    collect(rel, textOf(ctx, rel))

    for (const { loc, from } of locs) {
      let parsed
      try {
        parsed = new URL(loc)
      } catch {
        problems.push(`${from} lists "${loc}", which is not an absolute url`)
        continue
      }
      if (parsed.hostname !== ctx.prodHost) {
        problems.push(`${from} lists ${loc} on ${parsed.hostname}, not ${ctx.prodHost}`)
        continue
      }
      if (resolveInBuild(ctx, parsed.pathname) === null) {
        problems.push(`${from} lists ${parsed.pathname}, which no file in the build would serve`)
      }
    }
    if (locs.length === 0 && problems.length === 0) problems.push(`${rel} lists no urls at all`)
    if (problems.length === 0) return []
    return [this.mk({
      title: 'The sitemap is off-host or lists pages the build does not have',
      detail: `${problems.length} problem${problems.length === 1 ? '' : 's'} in ${rel}`,
      evidence: listed(problems, url),
      fix: `Regenerate the sitemap from the production site url so every <loc> is on ${ctx.prodHost} and resolves in the build.`,
    })]
  },
})

const LLMS = 'llms.txt'
const MARKDOWN_LINK = /\[[^\]]*\]\([^)]+\)/

const llmsTxt = check({
  id: 'output.llms-txt',
  title: 'llms.txt',
  severity: 'info',
  catches: 'an llms.txt that is absent, or present but not in the format the convention specifies',
  run(ctx) {
    requireBuild(ctx)
    if (!ctx.fileSet.has(LLMS)) {
      return [this.mk({
        severity: 'info',
        title: 'No llms.txt',
        detail: 'llms.txt is an emerging convention for telling language models what a site is and which pages matter; it is optional and its absence blocks nothing',
        evidence: [file(`${ctx.buildDirName}/${LLMS} is not present`)],
        fix: 'Optional: add an llms.txt with an H1 title, a short summary, and links to the pages that explain the site.',
      })]
    }
    const body = textOf(ctx, LLMS) ?? ''
    const firstLine = body.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? ''
    const problems = []
    if (!firstLine.startsWith('# ')) problems.push(`${LLMS} does not open with an H1 title line ("# Site name")`)
    if (!MARKDOWN_LINK.test(body)) problems.push(`${LLMS} contains no markdown links, so it points a reader at nothing`)
    if (problems.length === 0) return []
    return [this.mk({
      severity: 'low',
      title: 'llms.txt is present but malformed',
      detail: problems.join('; '),
      evidence: problems.map(file),
      fix: 'Open the file with "# Site name", follow it with a one-line summary, and list the key pages as markdown links.',
    })]
  },
})

const UTILITY_PATH = /thank|thanks|confirm|success|demo|preview|test/i

const noindexUtility = check({
  id: 'output.noindex-utility-pages',
  title: 'A utility page is indexable',
  catches: 'a thank-you or preview page ranking in search, which is how visitors land mid-funnel on an empty page',
  run(ctx) {
    requireBuild(ctx)
    const indexable = pages(ctx)
      .filter((page) => UTILITY_PATH.test(page.path))
      .filter((page) => !isNoindex(page.page))
      .map((page) => `${page.rel} (${page.path}) has no noindex`)
    if (indexable.length === 0) return []
    return [this.mk({
      title: 'A utility page is indexable',
      detail: `${indexable.length} confirmation, preview or demo page${indexable.length === 1 ? '' : 's'} can be indexed`,
      evidence: listed(indexable, file),
      fix: 'Add <meta name="robots" content="noindex, follow"> to each, and keep them out of the sitemap.',
    })]
  },
})

const CANONICAL_LINK = /<link\b[^>]*\brel\s*=\s*["']?canonical["']?[^>]*>/gi
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i

// The literal href, before the parser resolved it against the page url — the difference between a
// canonical that is absolute and one that only looks absolute once a base is applied.
function rawCanonicals(body) {
  const out = []
  for (const tag of body.matchAll(CANONICAL_LINK)) {
    const href = HREF.exec(tag[0])
    out.push(href === null ? '' : (href[1] ?? href[2] ?? href[3] ?? ''))
  }
  return out
}

const canonical = check({
  id: 'output.canonical',
  title: 'A canonical is missing, relative, off-host or not self-referencing',
  catches: 'pages that tell search engines to credit somebody else, or nothing at all',
  run(ctx) {
    requireBuild(ctx)
    const problems = []
    for (const page of pages(ctx)) {
      if (isNoindex(page.page)) continue
      const found = rawCanonicals(page.raw)
      if (found.length === 0) {
        problems.push(`${page.rel} has no canonical link`)
        continue
      }
      if (found.length > 1) {
        problems.push(`${page.rel} has ${found.length} canonical links; a page may declare one`)
        continue
      }
      const href = found[0].trim()
      if (!/^https?:\/\//i.test(href)) {
        problems.push(`${page.rel} has a relative canonical "${href}"; a canonical must be absolute`)
        continue
      }
      let parsed
      try {
        parsed = new URL(href)
      } catch {
        problems.push(`${page.rel} has a canonical that is not a url: "${href}"`)
        continue
      }
      if (parsed.hostname !== ctx.prodHost) {
        problems.push(`${page.rel} canonicalises to ${parsed.hostname}, not ${ctx.prodHost}`)
        continue
      }
      if (normalizePath(parsed.pathname) !== page.path) {
        problems.push(`${page.rel} serves ${page.path} but canonicalises to ${normalizePath(parsed.pathname)}`)
      }
    }
    if (problems.length === 0) return []
    return [this.mk({
      title: 'A canonical is missing, relative, off-host or not self-referencing',
      detail: `${problems.length} ${problems.length === 1 ? 'page declares' : 'pages declare'} a canonical that will not do what it looks like it does`,
      evidence: listed(problems, html),
      fix: `Give every indexable page one absolute canonical on ${ctx.prodHost} pointing at its own url.`,
    })]
  },
})

// Title and description differ in where the value lives and in nothing else, so one factory makes
// both: present on every page, and distinct across the indexable ones.
function uniqueHeadField({ id, label, title, catches, valueOf, fix }) {
  return check({
    id,
    title,
    catches,
    run(ctx) {
      requireBuild(ctx)
      const problems = []
      const byValue = new Map()
      for (const page of pages(ctx)) {
        const value = valueOf(page.page)
        if (typeof value !== 'string' || value.trim() === '') {
          problems.push(`${page.rel} has no ${label}`)
          continue
        }
        if (isNoindex(page.page)) continue
        const key = value.trim().toLowerCase()
        if (!byValue.has(key)) byValue.set(key, { written: value.trim(), pages: [] })
        byValue.get(key).pages.push(page.rel)
      }
      for (const { written, pages: used } of byValue.values()) {
        if (used.length < 2) continue
        problems.push(`${used.join(', ')} share the ${label} "${written}"`)
      }
      if (problems.length === 0) return []
      return [this.mk({
        title,
        detail: `${problems.length} ${label} problem${problems.length === 1 ? '' : 's'} across ${ctx.html.size} page${ctx.html.size === 1 ? '' : 's'}`,
        evidence: listed(problems, html),
        fix,
      })]
    },
  })
}

const titles = uniqueHeadField({
  id: 'output.titles',
  label: 'title',
  title: 'A title is missing or duplicated',
  catches: 'pages with no title, or a whole template sharing one, which is what a search result shows',
  valueOf: (page) => page.head.title,
  fix: 'Give every page a title that describes that page, not the site.',
})

const descriptions = uniqueHeadField({
  id: 'output.descriptions',
  label: 'meta description',
  title: 'A meta description is missing or duplicated',
  catches: 'pages with no description, or a template sharing one, so search engines write their own',
  valueOf: (page) => page.head.metaByName.get('description'),
  fix: 'Write a description per page: one sentence about what is on that page.',
})

// The four per-page facts that are either there or not. Each is one line of HTML, and each breaks
// something specific when it is missing.
function everyPage({ id, title, catches, ok, missing, fix }) {
  return check({
    id,
    title,
    catches,
    run(ctx) {
      requireBuild(ctx)
      const problems = pages(ctx).filter((page) => !ok(page.page)).map((page) => missing(page))
      if (problems.length === 0) return []
      return [this.mk({
        title,
        detail: `${problems.length} of ${ctx.html.size} page${ctx.html.size === 1 ? '' : 's'} affected`,
        evidence: listed(problems, html),
        fix,
      })]
    },
  })
}

const h1 = everyPage({
  id: 'output.h1',
  title: 'A page has no h1, or more than one',
  catches: 'a page with no first-level heading, or several competing for it',
  ok: (page) => page.h1Count === 1,
  missing: (page) => `${page.rel} has ${page.page.h1Count} h1 elements`,
  fix: 'Give every page exactly one h1 naming what the page is about.',
})

const lang = everyPage({
  id: 'output.lang',
  title: 'A page has no lang attribute',
  catches: 'a document whose language screen readers and translators have to guess at',
  ok: (page) => typeof page.htmlAttrs.lang === 'string' && page.htmlAttrs.lang.trim() !== '',
  missing: (page) => `${page.rel} has no <html lang="...">`,
  fix: 'Set lang on the html element of every page.',
})

const viewport = everyPage({
  id: 'output.viewport',
  title: 'A page has no viewport meta',
  catches: 'a page that renders at desktop width on a phone, zoomed out and unreadable',
  ok: (page) => typeof page.head.viewport === 'string' && page.head.viewport.trim() !== '',
  missing: (page) => `${page.rel} has no <meta name="viewport">`,
  fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to every page.',
})

const charset = everyPage({
  id: 'output.charset',
  title: 'A page declares no character encoding',
  catches: 'mojibake in any text that is not plain ASCII, which usually means the apostrophes',
  ok: (page) => typeof page.head.charset === 'string' && page.head.charset.trim() !== '',
  missing: (page) => `${page.rel} declares no charset`,
  fix: 'Put <meta charset="utf-8"> first in the head of every page.',
})

export const checks = [
  indexHtml, notFoundPage, internalRefs, faviconSet, ogImage, robotsTxt, sitemap, llmsTxt,
  noindexUtility, canonical, titles, descriptions, h1, lang, viewport, charset,
]
