// Performance, as far as HTTP alone can answer it.
//
// Pure over the audit context. Nothing here is a measurement: the http tier never renders a page,
// so it cannot know when the largest element painted, how much the layout shifted, or how long the
// main thread was busy. What it can do is weigh what the page asks the browser to download and
// point at the four or five shapes of markup that reliably make a page slow before anybody has
// measured anything. `perf.browser-tier-required` ships on every run without the browser tier, so
// a clean section here is never mistaken for a fast site.
//
// The weight estimate is deliberately an estimate, and says so. `probes.assets` is a *sample* —
// two stylesheets, two scripts, two images, by design, because an audit that downloads every
// bundle on a large site is an audit nobody runs twice — so most scripts and stylesheets have no
// recorded size. An asset with no size contributes zero rather than a guess, and every finding
// reports how many of those there were: an under-estimate the reader can see the shape of beats a
// confident number built on invented bytes.
//
// Shape of the findings: everything is a property of one page's markup and is reported once per
// page, except the two site-level ones — the third-party inventory, which is a question about the
// site, and a linked stylesheet's missing font-display, which is a property of the file and is
// reported against the file so one fix closes it everywhere.

import { defineCheck } from '../registry.mjs'

const PHASE = 'launch-audit'
const DIMENSION = 'perf'
const TIER = 'http'
const EVIDENCE_LIMIT = 10

// Three megabytes is roughly ten seconds on the mobile connection a good part of the world has.
const WEIGHT_LIMIT = 3 * 1024 * 1024
// Past a hundred requests a page spends more time in connection overhead than in content.
const REQUEST_LIMIT = 100

// `@font-face { ... }` — no nesting to worry about inside a font-face block, so the naive scan is
// the right one, and a block with a `font-display` descriptor anywhere in it is fine.
const FONT_FACE = /@font-face\s*\{([^}]*)\}/gi
const FONT_FAMILY = /font-family\s*:\s*([^;]+)/i

const url = (value) => ({ type: 'url', value })
const html = (value) => ({ type: 'html', value })
const text = (value) => ({ type: 'text', value })
const metric = (value) => ({ type: 'metric', value })

const define = (def) => defineCheck({ phase: PHASE, dimension: DIMENSION, tier: TIER, ...def })
const emit = (check, overrides) => check.mk({ title: check.title, ...overrides })

const htmlPages = (ctx) => ctx.crawl.pages.filter((p) => p.page !== null && p.status >= 200 && p.status < 300)
const plural = (n, one, many) => (n === 1 ? one : many)
const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`
// Bytes a reader can hold in their head: a 400-byte document is "400 B", not "0 KB".
const size = (bytes) => {
  if (bytes >= 1024 * 1024) return mb(bytes)
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

// The hosts that are this site, so its own bundle is never reported as somebody else's code.
function ownHosts(ctx) {
  const hosts = new Set()
  const add = (host) => { if (typeof host === 'string' && host !== '') hosts.add(host.toLowerCase()) }
  add(ctx.target.host)
  add(ctx.target.apex)
  if (ctx.target.hasWwwCounterpart) add(ctx.target.www)
  return hosts
}

const hostOf = (href) => {
  try {
    return new URL(href).hostname.toLowerCase()
  } catch {
    return null
  }
}

// Every response the context holds for an asset a page could reference, keyed by url. Images come
// from the image probe (all of them) and stylesheets and scripts from the sampled asset probe
// (two per kind), which is why the weight estimate is an estimate.
function assetIndex(ctx) {
  const byUrl = new Map()
  for (const [assetUrl, response] of ctx.probes.images) byUrl.set(assetUrl, response)
  for (const asset of ctx.probes.assets ?? []) byUrl.set(asset.url, asset.response)
  return byUrl
}

// The bytes an asset costs, as the server declared them. content-length is what a browser plans
// around; the bytes actually read are the fallback for a response recorded without the header. An
// asset that did not answer 2xx has no size to contribute and is counted as unknown instead.
function declaredBytes(response) {
  if (!response || response.status < 200 || response.status >= 300) return null
  const declared = Number(response.headers?.['content-length'])
  if (Number.isFinite(declared) && declared > 0) return declared
  if (typeof response.bytes === 'number' && response.bytes > 0) return response.bytes
  return null
}

// The urls one page asks the browser to fetch, by kind, deduped — a browser fetches a repeated url
// once, so the weight estimate must too.
function referencedAssets(page) {
  const images = new Set()
  const scripts = new Set()
  const styles = new Set()
  for (const image of page.images) if (image.src !== null) images.add(image.src)
  for (const script of page.scripts) if (script.src !== null) scripts.add(script.src)
  for (const style of page.styles) if (!style.inline && style.src !== null) styles.add(style.src)
  return { images: [...images], scripts: [...scripts], styles: [...styles] }
}

// The bytes of the HTML itself: what the response weighed on the wire, falling back to the body it
// kept, which is what a recorded fixture usually carries.
function htmlBytes(entry) {
  const response = entry.response
  const declared = Number(response?.headers?.['content-length'])
  if (Number.isFinite(declared) && declared > 0) return declared
  if (typeof response?.bytes === 'number' && response.bytes > 0) return response.bytes
  return typeof response?.body === 'string' ? response.body.length : 0
}

// The @font-face blocks in a stylesheet that never say what to do while the font loads.
function fontFacesWithoutDisplay(css) {
  const hits = []
  if (typeof css !== 'string' || css === '') return hits
  FONT_FACE.lastIndex = 0
  let match
  while ((match = FONT_FACE.exec(css)) !== null) {
    const block = match[1]
    if (/font-display\s*:/i.test(block)) continue
    // A face that fetches nothing cannot keep anybody waiting. `src: local(Arial)` with
    // ascent-override and size-adjust is the metric-matched fallback every modern font pipeline
    // writes beside the real face; font-display has nothing to govern on it, and reporting it says
    // "text waits for this" about a font already on the machine.
    if (!/\burl\s*\(/i.test(block)) continue
    const family = FONT_FAMILY.exec(block)
    hits.push(family === null ? '@font-face' : family[1].trim().replace(/^["']|["']$/g, ''))
  }
  return hits
}

export const pageWeight = define({
  id: 'perf.page-weight',
  severity: 'medium',
  title: 'A page weighs more than three megabytes',
  catches: 'A page whose HTML plus the assets the audit could size already exceeds 3 MB — before anything it could not size.',
  run(ctx) {
    const byUrl = assetIndex(ctx)
    const out = []
    for (const entry of htmlPages(ctx)) {
      const referenced = referencedAssets(entry.page)
      const all = [...referenced.images, ...referenced.scripts, ...referenced.styles]
      const documentBytes = htmlBytes(entry)
      let total = documentBytes
      let unknown = 0
      const heaviest = []
      for (const assetUrl of all) {
        const bytes = declaredBytes(byUrl.get(assetUrl))
        if (bytes === null) {
          unknown++
          continue
        }
        total += bytes
        heaviest.push({ url: assetUrl, bytes })
      }
      if (total <= WEIGHT_LIMIT) continue
      heaviest.sort((a, b) => b.bytes - a.bytes)
      out.push(emit(pageWeight, {
        page: entry.url,
        detail: `${entry.url} weighs at least ${mb(total)}: ${size(documentBytes)} of HTML plus ${all.length - unknown} sized ${plural(all.length - unknown, 'asset', 'assets')}. ${unknown === 0 ? 'Everything it references was sized.' : `${unknown} further ${plural(unknown, 'asset', 'assets')} could not be sized — the audit samples stylesheets and scripts rather than downloading all of them — so the real figure is higher.`} On a mid-range phone that is several seconds of staring at nothing.`,
        evidence: [
          url(entry.url),
          metric(`${mb(total)} estimated, against a 3 MB budget`),
          metric(`${size(documentBytes)} of HTML, ${all.length} referenced asset${plural(all.length, '', 's')}, ${unknown} of them unknown`),
          ...heaviest.slice(0, EVIDENCE_LIMIT).map((hit) => metric(`${hit.url} — ${size(hit.bytes)}`)),
        ],
        fix: 'Compress and resize the heaviest assets first — the list above is in order — and serve images in a modern format at the size they are displayed.',
      }))
    }
    return out
  },
})

export const requestCount = define({
  id: 'perf.request-count',
  severity: 'low',
  title: 'A page asks the browser for more than a hundred things',
  catches: 'More than 100 referenced images, scripts, stylesheets and frames on a single page.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      const page = entry.page
      const images = page.images.filter((image) => image.src !== null).length
      const scripts = page.scripts.filter((script) => script.src !== null).length
      const styles = page.styles.filter((style) => !style.inline && style.src !== null).length
      const frames = page.iframes.filter((frame) => frame.src !== null).length
      const total = images + scripts + styles + frames
      if (total <= REQUEST_LIMIT) continue
      out.push(emit(requestCount, {
        page: entry.url,
        detail: `${entry.url} references ${total} separate files: ${images} ${plural(images, 'image', 'images')}, ${scripts} ${plural(scripts, 'script', 'scripts')}, ${styles} ${plural(styles, 'stylesheet', 'stylesheets')} and ${frames} ${plural(frames, 'frame', 'frames')}. Each is a request the browser has to queue, and on a slow connection the queue is the page's speed.`,
        evidence: [
          url(entry.url),
          metric(`${total} referenced files, against a budget of ${REQUEST_LIMIT}`),
          metric(`${images} images, ${scripts} scripts, ${styles} stylesheets, ${frames} frames`),
        ],
        fix: 'Lazy-load what is below the fold, bundle what can be bundled, and cut what nobody looks at.',
      }))
    }
    return out
  },
})

export const renderBlockingScript = define({
  id: 'perf.render-blocking-script',
  severity: 'medium',
  title: 'The head waits for a script before showing anything',
  catches: 'A <script src> in the head with no defer, no async, no nomodule and no type="module" — the browser stops parsing until it has fetched and run it.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      const hits = entry.page.scripts.filter(
        (script) => script.src !== null && script.inHead && !script.defer && !script.async
          && script.type !== 'module' && script.nomodule !== true,
      )
      if (hits.length === 0) continue
      out.push(emit(renderBlockingScript, {
        page: entry.url,
        detail: `${hits.length} ${plural(hits.length, 'script', 'scripts')} in the head of ${entry.url} ${plural(hits.length, 'blocks', 'block')} rendering. The browser stops parsing the document, fetches the file, runs it, and only then carries on — so the visitor sees a blank page for as long as that takes, however fast the rest of the site is.`,
        evidence: [
          url(entry.url),
          ...hits.slice(0, EVIDENCE_LIMIT).map((script) => html(`<script src="${script.src}"> — in head, no defer, no async, not a module`)),
        ],
        fix: 'Add defer (or async when order does not matter), or move the script to the end of the body.',
      }))
    }
    return out
  },
})

export const heroPreloadMissing = define({
  id: 'perf.hero-preload-missing',
  severity: 'info',
  title: 'Nothing tells the browser which image matters most',
  catches: "A page whose first <img> is neither preloaded nor marked fetchpriority=\"high\" — the browser finds it only after parsing.",
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      const first = entry.page.images.find((image) => image.src !== null)
      if (first === undefined) continue
      if (first.fetchpriority === 'high') continue
      const preloaded = entry.page.head.links.some((link) => (
        link.rel !== null && link.rel.split(/\s+/).includes('preload') && link.as === 'image' && link.href === first.src
      ))
      if (preloaded) continue
      out.push(emit(heroPreloadMissing, {
        page: entry.url,
        detail: `The first image on ${entry.url} is ${first.src}, and nothing tells the browser it is important. The browser discovers it while parsing, after the stylesheets, so the largest thing on the screen is usually the last thing to arrive. This is a hint rather than a fault: if that image is not the main one, nothing here needs changing.`,
        evidence: [url(entry.url), html(`<img src="${first.src}"> — no matching <link rel="preload" as="image">, no fetchpriority="high"`)],
        fix: 'Add <link rel="preload" as="image" href="…"> for the hero image, or fetchpriority="high" on the <img> itself.',
      }))
    }
    return out
  },
})

export const fontDisplayMissing = define({
  id: 'perf.font-display-missing',
  severity: 'low',
  title: 'A web font has no font-display, so text waits for it',
  catches: 'An @font-face block that fetches a font file and declares no font-display — by default the browser hides the text for up to three seconds while it loads.',
  run(ctx) {
    const out = []
    const seenSheets = new Set()
    const byUrl = assetIndex(ctx)
    for (const entry of htmlPages(ctx)) {
      const inline = []
      for (const style of entry.page.styles) {
        if (style.inline) {
          inline.push(...fontFacesWithoutDisplay(style.text))
          continue
        }
        if (style.src === null || seenSheets.has(style.src)) continue
        const response = byUrl.get(style.src)
        const css = typeof response?.body === 'string' ? response.body : null
        if (css === null) continue
        seenSheets.add(style.src)
        const families = fontFacesWithoutDisplay(css)
        if (families.length === 0) continue
        out.push(emit(fontDisplayMissing, {
          page: style.src,
          detail: `${style.src} declares ${families.length} @font-face ${plural(families.length, 'block', 'blocks')} with no font-display: ${families.join(', ')}. Until the font arrives the browser shows nothing where that text should be — up to three seconds of invisible headings and body copy on a slow connection.`,
          evidence: [url(style.src), ...families.slice(0, EVIDENCE_LIMIT).map((family) => html(`@font-face { font-family: ${family}; /* no font-display */ }`))],
          fix: 'Add font-display: swap (or optional) to each @font-face block, so the text shows in a fallback face immediately.',
        }))
      }
      if (inline.length === 0) continue
      out.push(emit(fontDisplayMissing, {
        page: entry.url,
        detail: `The inline styles on ${entry.url} declare ${inline.length} @font-face ${plural(inline.length, 'block', 'blocks')} with no font-display: ${inline.join(', ')}. Until the font arrives the browser shows nothing where that text should be.`,
        evidence: [url(entry.url), ...inline.slice(0, EVIDENCE_LIMIT).map((family) => html(`@font-face { font-family: ${family}; /* no font-display */ }`))],
        fix: 'Add font-display: swap (or optional) to each @font-face block, so the text shows in a fallback face immediately.',
      }))
    }
    return out
  },
})

export const thirdPartyScripts = define({
  id: 'perf.third-party-scripts',
  severity: 'info',
  title: 'Code this site loads from somebody else',
  catches: 'Every script served from a host that is not this site, grouped by host — each one a connection, a dependency and a privacy question.',
  run(ctx) {
    const own = ownHosts(ctx)
    const pages = htmlPages(ctx)
    const byHost = new Map()
    for (const entry of pages) {
      for (const script of entry.page.scripts) {
        if (script.src === null) continue
        const host = hostOf(script.src)
        if (host === null || own.has(host)) continue
        if (!byHost.has(host)) byHost.set(host, { urls: new Set(), pages: new Set() })
        const group = byHost.get(host)
        group.urls.add(script.src)
        group.pages.add(entry.url)
      }
    }
    if (byHost.size === 0) return []
    const hosts = [...byHost.entries()].sort((a, b) => b[1].urls.size - a[1].urls.size || a[0].localeCompare(b[0]))
    const scripts = hosts.reduce((sum, [, group]) => sum + group.urls.size, 0)
    return [emit(thirdPartyScripts, {
      page: pages[0]?.url ?? null,
      detail: `This site loads ${scripts} ${plural(scripts, 'script', 'scripts')} from ${hosts.length} outside ${plural(hosts.length, 'host', 'hosts')}: ${hosts.map(([host, group]) => `${host} (${group.urls.size} on ${group.pages.size} ${plural(group.pages.size, 'page', 'pages')})`).join('; ')}. Each host is a fresh connection before anything downloads, code you do not control running on your pages, and — usually — a record of your visitors kept somewhere else.`,
      evidence: hosts.slice(0, EVIDENCE_LIMIT).map(([host, group]) => text(
        `${host} — ${group.urls.size} script${plural(group.urls.size, '', 's')} on ${group.pages.size} page${plural(group.pages.size, '', 's')}`,
      )),
      fix: 'Check every host is one you meant to add, self-host what you can, and load the rest after the page has rendered.',
    })]
  },
})

export const browserTierRequired = define({
  id: 'perf.browser-tier-required',
  severity: 'info',
  title: 'Nothing here is a measurement',
  catches: 'The gap this tier cannot cover: the page was never rendered, so no Core Web Vital was measured.',
  run(ctx) {
    if (ctx.browser?.available === true) return []
    const reason = ctx.browser?.reason ?? 'no browser adapter was supplied to this run'
    return [emit(browserTierRequired, {
      detail: `No page was rendered: ${reason}. Everything above is read off the markup and the sizes the server declared — it is a description of what the page asks for, not of how fast it is. LCP, CLS and INP, the cost of the JavaScript once it runs, and anything a script adds after load are all unmeasured here.`,
      evidence: [text(`browser tier not run: ${reason}`), text('unmeasured: LCP, CLS, INP, main-thread cost, script-built content')],
      fix: 'Run the audit again with the browser tier available, or check the page in PageSpeed Insights and in your own field data.',
    })]
  },
})

export const checks = [
  pageWeight,
  requestCount,
  renderBlockingScript,
  heroPreloadMissing,
  fontDisplayMissing,
  thirdPartyScripts,
  browserTierRequired,
]
