// Sitemap discovery, parsing, and one-level index expansion.
//
// parseSitemap(xml) is a regex scan, not a real XML parser: it recognizes `<urlset>` or
// `<sitemapindex>` as the document root, then pulls `<loc>`/`<lastmod>` pairs out of each
// `<url>`/`<sitemap>` block. Anything else is `invalid`. Both fields are trimmed; a value wrapped
// in `<![CDATA[ ... ]]>` has that wrapper stripped before its content is entity-decoded, so a
// `<loc>` written either way comes out the same. `lastmod` is the raw (decoded) string, or null
// when absent.
//
// discoverSitemaps(net, origin, robots) tries robots' `Sitemap:` lines first, then the four
// conventional paths. When robots gave none, fetching conventional paths stops at the first one
// that both 200s and parses, to avoid hammering a site with requests it never advertised.
//
// expandSitemap(net, url) fails closed: any problem — a fetch error, invalid XML, a child sitemap
// that doesn't parse or doesn't 200, or a child that is itself an index — sets `failedClosed:
// true` and records what went wrong in `errors`, but still returns whatever urls it did manage to
// collect. Indexes are only ever followed one level; a nested index is reported as an error
// rather than expanded.

const ENTITY_MAP = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }
const decodeEntities = (s) => s.replace(/&amp;|&lt;|&gt;|&quot;|&apos;/g, (m) => ENTITY_MAP[m])
const CDATA = /^<!\[CDATA\[([\s\S]*?)\]\]>$/

// Trim, strip a wrapping CDATA section if present, then entity-decode what's left.
function cleanValue(raw) {
  const trimmed = raw.trim()
  const cdata = CDATA.exec(trimmed)
  return decodeEntities(cdata ? cdata[1].trim() : trimmed)
}

const CONVENTIONAL_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/wp-sitemap.xml']

function extractEntries(xml, blockTag) {
  const blockRe = new RegExp(`<${blockTag}\\b[\\s\\S]*?<\\/${blockTag}>`, 'gi')
  const entries = []
  let m
  while ((m = blockRe.exec(xml))) {
    const block = m[0]
    const locMatch = /<loc>([\s\S]*?)<\/loc>/i.exec(block)
    if (!locMatch) continue
    const lastmodMatch = /<lastmod>([\s\S]*?)<\/lastmod>/i.exec(block)
    entries.push({
      loc: cleanValue(locMatch[1]),
      lastmod: lastmodMatch ? cleanValue(lastmodMatch[1]) : null,
    })
  }
  return entries
}

export function parseSitemap(xml) {
  const text = String(xml ?? '')
  const isIndex = /<sitemapindex[\s>]/i.test(text)
  const isUrlset = /<urlset[\s>]/i.test(text)
  if (!isIndex && !isUrlset) {
    return { kind: 'invalid', entries: [], error: 'not a sitemap: missing <urlset> or <sitemapindex> root element' }
  }
  const entries = isIndex ? extractEntries(text, 'sitemap') : extractEntries(text, 'url')
  return { kind: isIndex ? 'index' : 'urlset', entries, error: null }
}

export async function discoverSitemaps(net, origin, robots) {
  const fromRobots = [...new Set(robots?.sitemaps ?? [])]
  const conventional = CONVENTIONAL_PATHS.map((p) => new URL(p, origin).href)
  const candidates = []
  const found = []

  async function tryUrl(url) {
    candidates.push(url)
    const r = await net.get(url)
    if (r.status !== 200 || !r.body) return false
    const parsed = parseSitemap(r.body)
    if (parsed.kind !== 'index' && parsed.kind !== 'urlset') return false
    found.push({ url, status: r.status, kind: parsed.kind })
    return true
  }

  for (const url of fromRobots) await tryUrl(url)

  const stopAtFirstHit = fromRobots.length === 0
  for (const url of conventional) {
    const hit = await tryUrl(url)
    if (hit && stopAtFirstHit) break
  }

  return { candidates, found }
}

export async function expandSitemap(net, url) {
  const top = await net.get(url)
  if (top.status !== 200) {
    return { urls: [], children: [], errors: [`${url}: ${top.error || `status ${top.status}`}`], failedClosed: true }
  }
  const parsed = parseSitemap(top.body || '')
  if (parsed.kind === 'invalid') {
    return { urls: [], children: [], errors: [`${url}: ${parsed.error}`], failedClosed: true }
  }
  if (parsed.kind === 'urlset') {
    return {
      urls: parsed.entries.map((e) => ({ loc: e.loc, lastmod: e.lastmod, from: url })),
      children: [],
      errors: [],
      failedClosed: false,
    }
  }

  // parsed.kind === 'index': fetch each child once, one level deep only.
  const childUrls = parsed.entries.map((e) => e.loc)
  const results = await net.map(childUrls, (childUrl) => net.get(childUrl))

  const urls = []
  const children = []
  const errors = []
  let failedClosed = false

  childUrls.forEach((childUrl, i) => {
    const cr = results[i]
    if (!cr || cr.status !== 200) {
      children.push({ url: childUrl, status: cr ? cr.status : 0, ok: false })
      errors.push(`${childUrl}: ${cr && cr.error ? cr.error : `status ${cr ? cr.status : 0}`}`)
      failedClosed = true
      return
    }
    const childParsed = parseSitemap(cr.body || '')
    if (childParsed.kind === 'invalid') {
      children.push({ url: childUrl, status: cr.status, ok: false })
      errors.push(`${childUrl}: ${childParsed.error}`)
      failedClosed = true
      return
    }
    if (childParsed.kind === 'index') {
      children.push({ url: childUrl, status: cr.status, ok: false })
      errors.push('nested index not expanded')
      failedClosed = true
      return
    }
    children.push({ url: childUrl, status: cr.status, ok: true })
    for (const e of childParsed.entries) urls.push({ loc: e.loc, lastmod: e.lastmod, from: childUrl })
  })

  return { urls, children, errors, failedClosed }
}
