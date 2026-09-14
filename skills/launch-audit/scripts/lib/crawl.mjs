// Site crawl: sitemap union BFS over same-origin links, with named caps.
//
// crawlSite(net, opts) is pure over `net` — it never fetches robots.txt or discovers/expands a
// sitemap itself. The orchestrator (elsewhere) does both of those and hands in the results:
// `robots` is an already-parsed robots object (or null), `sitemapUrls` is the flat list of
// sitemap `<loc>` values it already expanded.
//
// The crawl seeds a BFS queue with the start URL and every sitemap URL, all at depth 0, then
// fetches one depth at a time via `net.map` so caps are applied deterministically: within a
// depth, candidates are processed in discovery order, checked against maxDepth then robots then
// the remaining page budget, and anything that doesn't survive is recorded once in `dropped`
// with the first reason that excluded it. A page is only parsed for links when it 200s and looks
// like HTML (a `text/html` content-type, or no content-type at all when the body starts with
// `<`); everything else is recorded with `page: null` and contributes no further discoveries.
//
// `source` on a page result reflects where the URL came from: `sitemap` (only ever named by the
// sitemap), `crawl` (only ever reached by a link — this always includes the start URL itself),
// or `both`. `orphans` are sitemap URLs no fetched page ever linked to (start excluded);
// `unlisted` are fetched HTML pages absent from `sitemapUrls` (start excluded; `[]` whenever
// `sitemapUrls` itself is empty — nothing to be unlisted from). `assets` and `internalLinks` are
// gathered from every parsed page, whether or not that page was ultimately fetched further;
// `externalLinks` catches off-origin links, which are never fetched.

import { parseHtml } from './html.mjs'
import { isAllowed } from './robots.mjs'

// Resolve `href` against `base`, drop the fragment, and return null for anything that isn't
// http(s). WHATWG URL parsing already lowercases scheme+host and drops a default port on
// serialization, and leaves query and trailing slash exactly as given.
export function normalizeUrl(href, base) {
  let u
  try {
    u = base === null || base === undefined ? new URL(href) : new URL(href, base)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  u.hash = ''
  return u.href
}

function originOf(url) {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

function looksLikeHtml(response) {
  const contentType = response.headers ? response.headers['content-type'] : undefined
  if (contentType) return contentType.toLowerCase().includes('text/html')
  return typeof response.body === 'string' && response.body.trimStart().startsWith('<')
}

export async function crawlSite(net, opts) {
  const {
    url,
    maxPages = 200,
    maxDepth = 4,
    ignoreRobots = false,
    robots = null,
    sitemapUrls = [],
  } = opts

  const startUrl = normalizeUrl(url, url)
  if (startUrl === null) throw new Error(`crawlSite: invalid start url: ${url}`)
  const startOrigin = originOf(startUrl)

  const dropped = new Map()
  // `cap` is the bound that refused this url, when the reason has one. A drop that names its own
  // cap lets the report collapse a thousand of them into one line that still says what the limit
  // was, instead of printing a thousand urls to get the number across.
  function recordDrop(u, reason, cap = null) {
    if (dropped.has(u)) return
    dropped.set(u, cap === null ? { url: u, reason } : { url: u, reason, cap })
  }

  // Off-origin sitemap URLs are never fetched — the crawl only ever touches the start origin.
  // Each is recorded once in `dropped` as 'off-origin' and excluded from every other output
  // (pages, orphans, unlisted): it never becomes a seed at all.
  const normalizedSitemapUrls = []
  const sitemapSet = new Set()
  for (const raw of sitemapUrls) {
    const n = normalizeUrl(raw, startUrl)
    if (n === null) continue
    if (originOf(n) !== startOrigin) {
      recordDrop(n, 'off-origin')
      continue
    }
    normalizedSitemapUrls.push(n)
    sitemapSet.add(n)
  }

  // origin flags per url: which of {sitemap, crawl} ever named it, for the `source` field.
  const origins = new Map()
  function markOrigin(u, kind) {
    let flags = origins.get(u)
    if (!flags) {
      flags = { sitemap: false, crawl: false }
      origins.set(u, flags)
    }
    flags[kind] = true
  }

  const depthOf = new Map()
  const visited = new Set()
  const seedOrder = []
  function seed(u) {
    if (visited.has(u)) return
    visited.add(u)
    depthOf.set(u, 0)
    seedOrder.push(u)
  }
  markOrigin(startUrl, 'crawl')
  seed(startUrl)
  for (const s of normalizedSitemapUrls) {
    markOrigin(s, 'sitemap')
    seed(s)
  }

  const internalLinks = new Map()
  const externalLinks = new Map()
  function addReferrer(map, target, referrer) {
    let arr = map.get(target)
    if (!arr) {
      arr = []
      map.set(target, arr)
    }
    arr.push(referrer)
  }

  const assets = { images: new Set(), scripts: new Set(), styles: new Set() }
  const pages = []

  let fetchedCount = 0
  let currentWave = seedOrder
  let currentDepth = 0

  while (currentWave.length > 0) {
    const eligible = []
    for (const u of currentWave) {
      const depth = depthOf.get(u)
      if (depth > maxDepth) {
        recordDrop(u, 'max-depth', maxDepth)
        continue
      }
      if (!ignoreRobots && robots) {
        const parsed = new URL(u)
        if (!isAllowed(robots, '*', parsed.pathname + parsed.search)) {
          recordDrop(u, 'robots')
          continue
        }
      }
      eligible.push(u)
    }

    const budget = Math.max(0, maxPages - fetchedCount)
    const willFetch = eligible.slice(0, budget)
    for (const u of eligible.slice(budget)) recordDrop(u, 'max-pages', maxPages)

    const results = await net.map(willFetch, (u) => net.get(u))
    fetchedCount += willFetch.length

    const nextWave = []
    const depthForWave = currentDepth

    willFetch.forEach((u, i) => {
      const r = results[i]
      const status = r.status
      const finalUrl = r.finalUrl || u
      let page = null
      if (status >= 200 && status < 300 && looksLikeHtml(r) && typeof r.body === 'string') {
        page = parseHtml(r.body, finalUrl)
      }

      const flags = origins.get(u) || { sitemap: false, crawl: false }
      const source = flags.sitemap && flags.crawl ? 'both' : flags.sitemap ? 'sitemap' : 'crawl'

      pages.push({
        url: u,
        status,
        finalUrl,
        depth: depthForWave,
        source,
        title: page ? page.head.title : null,
        page,
        response: r,
      })

      if (page === null) return

      for (const img of page.images) if (img.src) assets.images.add(img.src)
      for (const s of page.scripts) if (s.src) assets.scripts.add(s.src)
      for (const l of page.head.links) {
        if (l.rel && l.rel.split(/\s+/).includes('stylesheet') && l.href) assets.styles.add(l.href)
      }

      for (const link of page.links) {
        const norm = normalizeUrl(link.href, finalUrl)
        if (norm === null) continue
        const linkOrigin = originOf(norm)
        if (linkOrigin === startOrigin) {
          addReferrer(internalLinks, norm, u)
          markOrigin(norm, 'crawl')
          if (!visited.has(norm)) {
            visited.add(norm)
            depthOf.set(norm, depthForWave + 1)
            nextWave.push(norm)
          }
        } else {
          addReferrer(externalLinks, norm, u)
        }
      }
    })

    currentWave = nextWave
    currentDepth = depthForWave + 1
  }

  const orphans = []
  for (const s of normalizedSitemapUrls) {
    if (s === startUrl) continue
    if (!internalLinks.has(s)) orphans.push(s)
  }

  let unlisted = []
  if (normalizedSitemapUrls.length > 0) {
    unlisted = pages
      .filter((p) => p.page !== null && p.url !== startUrl && !sitemapSet.has(p.url))
      .map((p) => p.url)
  }

  return {
    pages,
    dropped: [...dropped.values()],
    orphans,
    unlisted,
    assets,
    externalLinks,
    internalLinks,
  }
}
