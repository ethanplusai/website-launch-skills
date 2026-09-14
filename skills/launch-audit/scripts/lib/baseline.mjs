// Baseline snapshot and diff: a pure projection of a crawl (plus a few side-channel facts the
// orchestrator gathers separately — security headers, cert, robots hash, sitemap) into a stable
// shape that can be recorded before a launch and compared against after.

function firstH1(page) {
  const h = page.headings.find((h) => h.level === 1)
  return h ? h.text : null
}

// `@type` may be a single string or an array of strings (schema.org allows multi-typing, e.g.
// `["Organization","LocalBusiness"]`). Flattens both shapes into one deduped, first-seen-order
// list of strings; a non-string entry (number, object, null) is silently dropped rather than
// stringified, since it isn't a real type name.
function jsonldTypesOf(page) {
  const seen = new Set()
  const types = []
  for (const entry of page.jsonld) {
    const raw = entry.parsed && entry.parsed['@type']
    const values = Array.isArray(raw) ? raw : [raw]
    for (const v of values) {
      if (typeof v !== 'string' || v === '' || seen.has(v)) continue
      seen.add(v)
      types.push(v)
    }
  }
  return types
}

function headersOf(response) {
  const h = response && response.headers ? response.headers : {}
  return {
    'content-type': h['content-type'] ?? null,
    'cache-control': h['cache-control'] ?? null,
    'x-robots-tag': h['x-robots-tag'] ?? null,
  }
}

function pageSnapshot(p, analyticsByPage) {
  const page = p.page
  return {
    url: p.url,
    status: p.status,
    finalUrl: p.finalUrl,
    redirectChain: (p.response && p.response.chain) || [],
    title: page ? page.head.title : null,
    description: page ? (page.head.metaByName.get('description') ?? null) : null,
    canonical: page ? page.head.canonical : null,
    robotsMeta: page ? page.head.robots : null,
    h1: page ? firstH1(page) : null,
    jsonldTypes: page ? jsonldTypesOf(page) : [],
    analyticsTags: analyticsByPage.get(p.url) ?? [],
    headers: headersOf(p.response),
    imageCount: page ? page.images.length : 0,
    linkCount: page ? page.links.length : 0,
  }
}

// Builds a Baseline from a crawl result. Pure: `generatedAt` comes from the `now` option (default
// `new Date()`) rather than reading the clock internally, so a caller can pin it and get the same
// output back — nothing here reads from disk or the network either way.
export function makeBaseline(
  crawlResult,
  { securityHeaders = {}, cert = null, robotsHash = null, sitemapUrls = [], analyticsByPage = new Map(), now = new Date() } = {}
) {
  const pages = [...crawlResult.pages]
    .map((p) => pageSnapshot(p, analyticsByPage))
    .sort((a, b) => a.url.localeCompare(b.url))

  let host = null
  let https = false
  if (crawlResult.pages.length > 0) {
    try {
      const u = new URL(crawlResult.pages[0].url)
      host = u.host
      https = u.protocol === 'https:'
    } catch {
      host = null
    }
  }

  const generatedAt = now instanceof Date ? now : new Date(now)

  return {
    generatedAt: generatedAt.toISOString(),
    host,
    https,
    hsts: securityHeaders['strict-transport-security'] ?? null,
    cert: cert ? { expires: cert.expires, daysLeft: cert.daysLeft } : null,
    robotsTxtHash: robotsHash,
    sitemapUrls,
    securityHeaders,
    pages,
  }
}

function normalize(v) {
  if (Array.isArray(v)) return [...v].sort().join(',')
  return v ?? null
}

const CHANGED_FIELDS = ['title', 'description', 'canonical', 'robotsMeta', 'h1', 'jsonldTypes']

// Diffs two baselines, keyed by page url.
export function diffBaseline(before, after) {
  const beforeByUrl = new Map(before.pages.map((p) => [p.url, p]))
  const afterByUrl = new Map(after.pages.map((p) => [p.url, p]))

  const missingPages = []
  const newPages = []
  const statusChanges = []
  const newRedirects = []
  const changed = []
  const analyticsLost = []

  for (const url of beforeByUrl.keys()) if (!afterByUrl.has(url)) missingPages.push(url)
  for (const url of afterByUrl.keys()) if (!beforeByUrl.has(url)) newPages.push(url)
  missingPages.sort()
  newPages.sort()

  for (const [url, b] of beforeByUrl) {
    const a = afterByUrl.get(url)
    if (!a) continue

    if (b.status !== a.status) statusChanges.push({ url, before: b.status, after: a.status })

    if ((b.redirectChain?.length ?? 0) === 0 && (a.redirectChain?.length ?? 0) > 0) {
      newRedirects.push({ url, before: [], after: a.redirectChain })
    }

    for (const field of CHANGED_FIELDS) {
      if (normalize(b[field]) !== normalize(a[field])) changed.push({ url, field, before: b[field], after: a[field] })
    }

    const beforeTags = new Set(b.analyticsTags ?? [])
    const afterTags = new Set(a.analyticsTags ?? [])
    const lost = [...beforeTags].filter((t) => !afterTags.has(t))
    if (lost.length > 0) analyticsLost.push({ url, tags: lost })
  }

  return { missingPages, newPages, statusChanges, newRedirects, changed, analyticsLost }
}
