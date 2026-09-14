// The audit context every launch-audit check reads.
//
// buildAuditContext(net, dns, options) does all of the fetching for the launch-audit phase, once,
// and hands the result to the check modules as a frozen-in-spirit `ctx`. Checks are pure over it:
// a check never fetches, so everything a check could want is probed here, in this order:
//
//   1. robots.txt          — parsed when it 200s, `parsed: null` otherwise (a 404 is not a parse)
//   2. sitemaps            — discovery, then one-level expansion of the FIRST sitemap found
//   3. crawl               — seeded with the start url and every expanded sitemap loc
//   4. root variants       — http://host/, https://host/, the apex root, the www counterpart when
//                            the host is one that could have one (`probes.wwwRoot` is null for a
//                            subdomain target, which is never probed), plus the trailing-slash
//                            variant of the start path when it isn't "/"
//   5. notFound            — /this-page-should-not-exist-<random>, for soft-404 detection
//   6. llms.txt            — presence and shape
//   7. static asset sample — up to two stylesheets, scripts and images the crawl actually saw
//   8. head assets         — every og:image, icon, apple-touch-icon and manifest url the crawled
//                            pages declare, deduped across the whole crawl and fetched once each
//   9. cert                — net.cert(host)
//
// The 404 probe's random suffix comes from `options.random`, which defaults to crypto randomness;
// tests pin it (`random: () => 'deadbeef'`) so a recorded fixture can hold that exact path. Time
// is pinned the same way through `options.now`, so "is this lastmod in the future" never drifts.
//
// `ctx.dns` is the adapter from dns.mjs, not resolved records: nothing in the launch-audit phase
// resolves DNS eagerly, and the dimensions that do need it own the host list they care about.

import { randomBytes } from 'node:crypto'
import { parseRobots } from '../robots.mjs'
import { discoverSitemaps, expandSitemap } from '../sitemap.mjs'
import { crawlSite } from '../crawl.mjs'

const EMPTY_EXPANSION = { urls: [], children: [], errors: [], failedClosed: false }

// Registrable-domain suffixes that occupy two labels, so `example.co.uk` is a site the way
// `example.test` is. Enough of the common ones to keep the www question honest; this is not a
// public suffix list and is not trying to be one.
const TWO_LABEL_SUFFIXES = new Set(['co.uk', 'org.uk', 'com.au', 'co.nz', 'com.br', 'co.jp', 'co.za', 'com.mx'])

// Does a `www.` counterpart of this host even make sense? It does for `example.test` and for
// `www.example.test`, and it does not for `app.example.test` — nobody serves `www.app.example.test`,
// so probing it would invent a broken host and then report it.
function hasWwwCounterpart(host) {
  if (/^www\./i.test(host)) return true
  const labels = host.split('.')
  if (labels.length === 2) return true
  if (labels.length === 3 && TWO_LABEL_SUFFIXES.has(labels.slice(1).join('.').toLowerCase())) return true
  return false
}

const ASSET_SAMPLE_PER_KIND = 2
// The head-asset set is a handful of urls on a normal site — one favicon, one touch icon, one
// manifest, one og:image per template — but a page builder that stamps a per-page og:image makes
// it grow with the crawl, so it is capped. A url past the cap is simply absent from the map, and
// the checks treat an absent url as unknown rather than broken.
const HEAD_ASSET_LIMIT = 100
const HEAD_ASSET_RELS = ['icon', 'apple-touch-icon', 'manifest']
const HEAD_ASSET_META = ['og:image', 'og:image:secure_url']

function sampleAssets(assets, origin) {
  const picked = []
  for (const kind of ['styles', 'scripts', 'images']) {
    const set = assets?.[kind]
    if (!set) continue
    let taken = 0
    for (const url of set) {
      if (taken >= ASSET_SAMPLE_PER_KIND) break
      let parsed
      try {
        parsed = new URL(url)
      } catch {
        continue
      }
      if (parsed.origin !== origin) continue
      picked.push({ url, kind })
      taken++
    }
  }
  return picked
}

// The urls a check like `head.favicon-broken` or `head.og-image-small` has to see a response for.
// Collected from the pages the crawl actually parsed, so nothing here invents a url the site does
// not declare; `page.head.links` and the og meta values are already absolute by the time they get
// here, and anything that is not http(s) (a data: icon, say) has no response to fetch.
function headAssetUrls(crawl) {
  const urls = new Set()
  const add = (href) => {
    if (typeof href !== 'string' || href === '' || urls.size >= HEAD_ASSET_LIMIT) return
    let parsed
    try {
      parsed = new URL(href)
    } catch {
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    urls.add(parsed.href)
  }
  for (const entry of crawl.pages) {
    if (entry.page === null) continue
    for (const key of HEAD_ASSET_META) add(entry.page.head.metaByProperty.get(key))
    for (const link of entry.page.head.links) {
      if (link.rel === null) continue
      const rels = link.rel.split(/\s+/)
      if (rels.some((rel) => HEAD_ASSET_RELS.some((wanted) => rel.includes(wanted)))) add(link.href)
    }
  }
  return [...urls]
}

export async function buildAuditContext(net, dns, options = {}) {
  if (!options || typeof options.url !== 'string' || options.url === '') throw new Error('buildAuditContext: options.url is required')
  const start = new URL(options.url)
  const url = start.href
  const origin = start.origin
  const host = start.hostname
  const apex = host.replace(/^www\./i, '')
  const www = `www.${apex}`
  const random = typeof options.random === 'function' ? options.random : () => randomBytes(4).toString('hex')
  const now = options.now === undefined ? new Date() : new Date(options.now)

  const wwwCounterpart = hasWwwCounterpart(host)
  const target = {
    url,
    origin,
    host,
    apex,
    www,
    hasWwwCounterpart: wwwCounterpart,
    staging: options.staging === true,
    devHosts: [...(options.devHosts ?? [])],
  }

  // 1. robots.txt
  const robotsUrl = `${origin}/robots.txt`
  const robotsResponse = await net.get(robotsUrl)
  const robotsText = robotsResponse.status === 200 && typeof robotsResponse.body === 'string' ? robotsResponse.body : null
  const robots = {
    url: robotsUrl,
    status: robotsResponse.status,
    text: robotsText,
    parsed: robotsText === null ? null : parseRobots(robotsText),
    response: robotsResponse,
  }

  // 2. sitemaps
  const { candidates, found } = await discoverSitemaps(net, origin, robots.parsed)
  const expanded = found.length > 0 ? await expandSitemap(net, found[0].url) : { ...EMPTY_EXPANSION }
  const sitemaps = { candidates, found, expanded, urls: expanded.urls.map((entry) => entry.loc) }

  // 3. crawl
  const crawl = await crawlSite(net, {
    url,
    maxPages: options.maxPages ?? 200,
    maxDepth: options.maxDepth ?? 4,
    ignoreRobots: options.ignoreRobots === true,
    robots: robots.parsed,
    sitemapUrls: sitemaps.urls,
  })

  // 4. root variants
  const wwwUrl = wwwCounterpart ? `${start.protocol}//${www}/` : null
  const variantUrls = [
    `http://${host}/`,
    `https://${host}/`,
    ...(wwwUrl === null ? [] : [wwwUrl]),
    `${start.protocol}//${apex}/`,
  ]
  const slashPath = start.pathname === '/'
    ? null
    : (start.pathname.endsWith('/') ? start.pathname.slice(0, -1) : `${start.pathname}/`)
  const slashUrl = slashPath === null ? null : `${origin}${slashPath}${start.search}`

  // 5/6. the 404 probe and llms.txt
  const notFoundUrl = `${origin}/this-page-should-not-exist-${random()}`
  const llmsUrl = `${origin}/llms.txt`

  // An apex https target makes httpsRoot and apexRoot the same url; fetch each distinct url once.
  const probeUrls = [...new Set([...variantUrls, ...(slashUrl === null ? [] : [slashUrl]), notFoundUrl, llmsUrl])]
  const probeResponses = await net.map(probeUrls, (probeUrl) => net.get(probeUrl))
  const byProbeUrl = new Map(probeUrls.map((probeUrl, i) => [probeUrl, probeResponses[i]]))
  const at = (probeUrl) => byProbeUrl.get(probeUrl)

  // 7. a sample of the static assets the crawl actually saw
  const assetPicks = sampleAssets(crawl.assets, origin)
  const fetchAsset = typeof net.head === 'function' ? (u) => net.head(u) : (u) => net.get(u)
  const assetResponses = await net.map(assetPicks.map((a) => a.url), fetchAsset)
  const assets = assetPicks.map((pick, i) => ({ ...pick, response: assetResponses[i] }))

  // 8. every head asset the crawl saw, fetched once each. net.get rather than net.head, because
  // the og:image checks read the response bytes to measure the image.
  const headAssetList = headAssetUrls(crawl)
  const headAssetResponses = await net.map(headAssetList, (assetUrl) => net.get(assetUrl))
  const headAssets = new Map(headAssetList.map((assetUrl, i) => [assetUrl, headAssetResponses[i]]))

  const probes = {
    httpRoot: at(variantUrls[0]),
    httpsRoot: at(variantUrls[1]),
    wwwRoot: wwwUrl === null ? null : at(wwwUrl),
    apexRoot: at(`${start.protocol}//${apex}/`),
    slashVariant: slashUrl === null ? null : at(slashUrl),
    notFound: { url: notFoundUrl, response: at(notFoundUrl) },
    llmsTxt: at(llmsUrl),
    assets,
    headAssets,
  }

  // 9. cert
  const cert = typeof net.cert === 'function' ? await net.cert(host) : null

  return { target, crawl, robots, sitemaps, probes, cert, dns, net, options, now }
}
