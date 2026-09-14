// Indexability: can a search engine find, crawl, and index this site the way it was meant to?
//
// Every check here is pure over the audit context built by _ctx.mjs — nothing fetches. Unless a
// check is inherently site-wide (the AI-crawler table, llms.txt, "no x-default anywhere"), it
// reports one finding per offending page and cites the tag, header, status or url that proves it.
//
// Two ids sit close enough together to be worth spelling out:
// - `page-noindex-in-sitemap` is a sitemap-listed page whose HTML carries `<meta name="robots"
//   content="noindex">`.
// - `sitemap-noindexed-url` is a sitemap-listed url kept out of the index by something other than
//   that tag: an `X-Robots-Tag: noindex` response header, or a robots.txt `Disallow` that stops a
//   crawler reaching it at all.
//
// The canonical checks read the raw `href` out of the response body as well as the resolved one,
// because "the canonical is relative" is invisible once html.mjs has resolved it against the page
// url. `canonical-to-redirect-or-404` only judges canonical targets the crawl already fetched; a
// target it never saw is left alone rather than fetched here, and a target the crawl reached
// through a redirect of its own is clean — what matters is whether the canonical url itself
// redirects.

import { defineCheck, SkipCheck } from '../registry.mjs'
import { aiPolicy, blocksAssets, isAllowed } from '../robots.mjs'

const PHASE = 'launch-audit'
const DIMENSION = 'indexability'
const TIER = 'http'
const SITEMAP_URL_LIMIT = 50_000
const HREFLANG_CODE = /^([a-z]{2,3}(-[a-z]{2,4})?|x-default)$/i
const LINK_TAG = /<link\b[^>]*>/gi

const url = (value) => ({ type: 'url', value })
const status = (value) => ({ type: 'status', value })
const header = (value) => ({ type: 'header', value })
const html = (value) => ({ type: 'html', value })
const text = (value) => ({ type: 'text', value })

const define = (def) => defineCheck({ phase: PHASE, dimension: DIMENSION, tier: TIER, ...def })
// mk() prebinds id/phase/dimension/severity/tier but not the title, which most findings inherit
// from their check and a few (the staging downgrade, the llms.txt states) override per finding.
const emit = (check, overrides) => check.mk({ title: check.title, ...overrides })

// Fetched, 2xx, parsed-as-HTML pages: the only ones any page-level check has an opinion about.
const htmlPages = (ctx) => ctx.crawl.pages.filter((p) => p.page !== null && p.status >= 200 && p.status < 300)

const pageByUrl = (ctx) => {
  const map = new Map()
  for (const entry of ctx.crawl.pages) {
    map.set(entry.url, entry)
    if (entry.finalUrl && !map.has(entry.finalUrl)) map.set(entry.finalUrl, entry)
  }
  return map
}

const metaRobots = (entry) => entry.page?.head.robots ?? ''
const xRobotsTag = (entry) => String(entry.response?.headers?.['x-robots-tag'] ?? '')
const directive = (value, name) => new RegExp(`(^|[,\\s])${name}([,\\s]|$)`, 'i').test(value)

function hostOf(value) {
  try {
    return new URL(value).hostname
  } catch {
    return null
  }
}

const sameSite = (ctx, host) => host !== null && (host === ctx.target.host || host === ctx.target.apex || host === ctx.target.www)

function pathOf(value) {
  try {
    const parsed = new URL(value)
    return parsed.pathname + parsed.search
  } catch {
    return null
  }
}

// The canonical exactly as it was written, so "relative" is still visible.
function rawCanonical(body) {
  if (typeof body !== 'string') return null
  for (const match of body.matchAll(LINK_TAG)) {
    const tag = match[0]
    if (!/\brel\s*=\s*["']?\s*canonical\b/i.test(tag)) continue
    const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag)
    if (href) return href[2] ?? href[3] ?? href[4] ?? null
  }
  return null
}

function headerCanonical(entry) {
  const link = entry.response?.headers?.link
  if (!link) return null
  for (const part of String(link).split(/,(?=\s*<)/)) {
    if (!/rel\s*=\s*"?canonical"?/i.test(part)) continue
    const found = /<([^>]+)>/.exec(part)
    if (found) return found[1].trim()
  }
  return null
}

function normalizeUrl(value, base) {
  try {
    return new URL(value, base).href
  } catch {
    return null
  }
}

// Every `<link rel="alternate" hreflang="...">` a page declares, absolute href included.
function hreflangLinks(entry) {
  return entry.page.head.links.filter(
    (link) => link.hreflang && link.rel !== null && link.rel.split(/\s+/).includes('alternate'),
  )
}

export const siteNoindex = define({
  id: 'indexability.site-noindex',
  severity: 'blocker',
  title: 'The site tells search engines not to index it',
  catches: 'A staging noindex left behind on the production launch.',
  run(ctx) {
    const evidence = []
    const home = ctx.crawl.pages.find((p) => p.url === ctx.target.url)
    if (home) {
      const meta = metaRobots(home)
      if (directive(meta, 'noindex')) evidence.push(html(`<meta name="robots" content="${meta}">`))
      const headerValue = xRobotsTag(home)
      if (directive(headerValue, 'noindex')) evidence.push(header(`x-robots-tag: ${headerValue}`))
    }
    if (ctx.robots.parsed && !isAllowed(ctx.robots.parsed, '*', '/')) {
      evidence.push(text(`${ctx.robots.url} blocks every crawler at the site root: "Disallow: /"`))
    }
    if (evidence.length === 0) return []
    const staging = ctx.target.staging
    return [emit(siteNoindex, {
      severity: staging ? 'info' : 'blocker',
      page: ctx.target.url,
      title: staging ? 'Staging target is noindexed, as expected' : 'The site tells search engines not to index it',
      detail: staging
        ? 'This staging target asks search engines to stay away, which is what a staging target should do. Confirm production does not carry the same instruction.'
        : 'Search engines are being told not to index this site, so it will never appear in results. This is almost always a staging setting that shipped to production.',
      evidence: [url(ctx.target.url), ...evidence],
      fix: 'Remove the noindex meta tag, the X-Robots-Tag header, or the blanket robots.txt Disallow from the production deployment.',
    })]
  },
})

export const pageNoindexInSitemap = define({
  id: 'indexability.page-noindex-in-sitemap',
  severity: 'high',
  title: 'A sitemap page is noindexed',
  catches: 'A page advertised in the sitemap that its own markup tells Google to drop.',
  run(ctx) {
    const byUrl = pageByUrl(ctx)
    const out = []
    for (const loc of ctx.sitemaps.urls) {
      const entry = byUrl.get(loc)
      if (!entry || entry.page === null) continue
      const meta = metaRobots(entry)
      if (!directive(meta, 'noindex')) continue
      out.push(emit(pageNoindexInSitemap, {
        page: loc,
        detail: 'This url is listed in the sitemap, which asks search engines to index it, while the page itself asks them not to. The two instructions contradict each other and the noindex wins.',
        evidence: [url(loc), html(`<meta name="robots" content="${meta}">`), text(`listed in ${ctx.sitemaps.found[0]?.url ?? 'the sitemap'}`)],
        fix: 'Decide whether the page should be indexed: drop the noindex, or remove the url from the sitemap.',
      }))
    }
    return out
  },
})

export const nosnippetUnintended = define({
  id: 'indexability.nosnippet-unintended',
  severity: 'low',
  title: 'A page suppresses its search snippet',
  catches: 'A nosnippet directive that silently strips the description from search results.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      const meta = metaRobots(entry)
      const headerValue = xRobotsTag(entry)
      const source = directive(meta, 'nosnippet') || /max-snippet:\s*0/i.test(meta)
        ? html(`<meta name="robots" content="${meta}">`)
        : directive(headerValue, 'nosnippet') || /max-snippet:\s*0/i.test(headerValue)
          ? header(`x-robots-tag: ${headerValue}`)
          : null
      if (source === null) continue
      out.push(emit(nosnippetUnintended, {
        page: entry.url,
        detail: 'Search engines are told not to show a text snippet for this page, so its result will be a bare title. That is rarely what anyone intended.',
        evidence: [url(entry.url), source],
        fix: 'Remove the nosnippet directive unless the page is deliberately withheld from result previews.',
      }))
    }
    return out
  },
})

export const robotsUnfetchable = define({
  id: 'indexability.robots-unfetchable',
  severity: 'high',
  title: 'robots.txt cannot be fetched',
  catches: 'A robots.txt that errors, which some crawlers read as "stay out entirely".',
  run(ctx) {
    if (ctx.robots.status === 200 || ctx.robots.status === 404) return []
    return [emit(robotsUnfetchable, {
      page: ctx.robots.url,
      detail: 'robots.txt answered with neither content nor a clean 404. Crawlers that see a 5xx here often treat the whole site as disallowed until it recovers.',
      evidence: [url(ctx.robots.url), status(`HTTP ${ctx.robots.status}${ctx.robots.response?.error ? ` (${ctx.robots.response.error})` : ''}`)],
      fix: 'Serve robots.txt with a 200 and a body, or a plain 404 if the site deliberately has none.',
    })]
  },
})

export const robotsSitemapLineMissing = define({
  id: 'indexability.robots-sitemap-line-missing',
  severity: 'medium',
  title: 'robots.txt names no sitemap',
  catches: 'A sitemap that exists but is never advertised where crawlers look first.',
  run(ctx) {
    if (ctx.robots.status !== 200 || ctx.robots.parsed === null) return []
    if (ctx.robots.parsed.sitemaps.length > 0) return []
    return [emit(robotsSitemapLineMissing, {
      page: ctx.robots.url,
      detail: 'robots.txt carries no Sitemap: line, so crawlers have to guess where the sitemap lives.',
      evidence: [url(ctx.robots.url), text('no "Sitemap:" directive in robots.txt')],
      fix: `Add "Sitemap: ${ctx.target.origin}/sitemap.xml" to robots.txt.`,
    })]
  },
})

export const robotsSitemapOtherHost = define({
  id: 'indexability.robots-sitemap-other-host',
  severity: 'high',
  title: 'robots.txt points at a sitemap on another host',
  catches: 'A sitemap url left pointing at the old domain or the staging host.',
  run(ctx) {
    if (ctx.robots.parsed === null) return []
    const out = []
    for (const sitemapUrl of ctx.robots.parsed.sitemaps) {
      const host = hostOf(sitemapUrl)
      if (sameSite(ctx, host)) continue
      out.push(emit(robotsSitemapOtherHost, {
        page: ctx.robots.url,
        detail: `robots.txt advertises a sitemap on ${host ?? 'an unparseable host'}, not on ${ctx.target.host}. Crawlers ignore sitemaps announced for a host they were not fetched from.`,
        evidence: [url(ctx.robots.url), text(`Sitemap: ${sitemapUrl}`)],
        fix: `Point the Sitemap: line at ${ctx.target.origin}.`,
      }))
    }
    return out
  },
})

export const robotsBlocksAssets = define({
  id: 'indexability.robots-blocks-assets',
  severity: 'high',
  title: 'robots.txt blocks CSS or JavaScript',
  catches: 'A disallow rule that stops Google rendering the page it is trying to rank.',
  run(ctx) {
    if (ctx.robots.parsed === null) return []
    const blocked = blocksAssets(ctx.robots.parsed, '*')
    if (blocked.length === 0) return []
    return [emit(robotsBlocksAssets, {
      page: ctx.robots.url,
      detail: 'robots.txt disallows paths that stylesheets and scripts normally live under. A crawler that cannot fetch them renders the page without its layout and judges it accordingly.',
      evidence: [url(ctx.robots.url), ...blocked.map((path) => text(`disallowed asset path: ${path}`))],
      fix: 'Narrow the Disallow rules so stylesheets, scripts and images stay crawlable.',
    })]
  },
})

export const aiCrawlerPolicy = define({
  id: 'indexability.ai-crawler-policy',
  severity: 'info',
  title: 'AI crawler policy',
  catches: 'An AI crawler stance nobody chose on purpose.',
  run(ctx) {
    // An absent robots.txt and an unfetched one mean the same thing to a crawler and opposite
    // things to a reader. `aiPolicy` over an empty robots object reports all twelve crawlers as
    // "allowed", which is a statement about a file this run never read — so the only honest answer
    // when it could not be read is that this was not checked.
    if (ctx.robots.parsed === null) {
      throw new SkipCheck(`robots.txt could not be fetched (${ctx.robots.url} answered HTTP ${ctx.robots.status})`)
    }
    const rows = aiPolicy(ctx.robots.parsed)
    const blocked = rows.filter((row) => !row.allowed)
    return [emit(aiCrawlerPolicy, {
      page: ctx.robots.url,
      title: blocked.length === 0
        ? `AI crawler policy: all ${rows.length} known crawlers are allowed`
        : `AI crawler policy: ${blocked.length} of ${rows.length} known crawlers are blocked`,
      detail: 'What robots.txt currently says to the AI crawlers worth naming. This is a decision to make deliberately, not a defect: training, user-fetch and search crawlers can be treated differently.',
      evidence: rows.map((row) => text(`${row.ua} (${row.vendor}, ${row.purpose}): ${row.allowed ? 'allowed' : 'blocked'}`)),
      fix: 'Confirm this matches the intended policy; add or remove User-agent groups in robots.txt to change it.',
    })]
  },
})

export const sitemapMissing = define({
  id: 'indexability.sitemap-missing',
  severity: 'high',
  title: 'No sitemap could be found',
  catches: 'A launch with no sitemap at any conventional path and none named in robots.txt.',
  run(ctx) {
    if (ctx.sitemaps.found.length > 0) return []
    return [emit(sitemapMissing, {
      page: ctx.target.origin,
      detail: 'Neither robots.txt nor any conventional path produced a parseable sitemap, so search engines have to discover every page by following links.',
      evidence: [url(ctx.target.origin), ...ctx.sitemaps.candidates.slice(0, 5).map((candidate) => text(`tried: ${candidate}`))],
      fix: `Publish a sitemap at ${ctx.target.origin}/sitemap.xml and name it from robots.txt.`,
    })]
  },
})

export const sitemapInvalid = define({
  id: 'indexability.sitemap-invalid',
  severity: 'high',
  title: 'The sitemap did not fully parse',
  catches: 'A sitemap index whose child is missing, unreachable, or not XML.',
  run(ctx) {
    if (ctx.sitemaps.found.length === 0) return []
    const { errors, failedClosed } = ctx.sitemaps.expanded
    if (!failedClosed && errors.length === 0) return []
    return [emit(sitemapInvalid, {
      page: ctx.sitemaps.found[0].url,
      detail: 'Part of the sitemap could not be read, so the url list this audit worked from is incomplete — and so is the one search engines get.',
      evidence: [url(ctx.sitemaps.found[0].url), ...errors.slice(0, 5).map((message) => text(message))],
      fix: 'Fix or remove the broken sitemap entries so the whole index parses.',
    })]
  },
})

export const sitemapTooLarge = define({
  id: 'indexability.sitemap-too-large',
  severity: 'medium',
  title: 'The sitemap exceeds 50,000 urls',
  catches: 'A single sitemap file past the limit crawlers will read.',
  run(ctx) {
    const count = ctx.sitemaps.urls.length
    if (count <= SITEMAP_URL_LIMIT) return []
    return [emit(sitemapTooLarge, {
      page: ctx.sitemaps.found[0]?.url ?? ctx.target.origin,
      detail: `The sitemap expands to ${count} urls. The sitemaps protocol caps one file at ${SITEMAP_URL_LIMIT} urls (and 50MB uncompressed); past that, crawlers stop reading.`,
      evidence: [
        url(ctx.sitemaps.found[0]?.url ?? ctx.target.origin),
        { type: 'metric', value: `${count} urls (limit ${SITEMAP_URL_LIMIT})` },
      ],
      fix: 'Split the sitemap into several files and list them from a sitemap index.',
    })]
  },
})

export const sitemapUrlNot200 = define({
  id: 'indexability.sitemap-url-not-200',
  severity: 'high',
  title: 'A sitemap url does not return 200',
  catches: 'A sitemap still advertising pages that have been deleted or moved.',
  run(ctx) {
    const byUrl = pageByUrl(ctx)
    const out = []
    for (const loc of ctx.sitemaps.urls) {
      const entry = byUrl.get(loc)
      if (!entry || entry.status === 200) continue
      out.push(emit(sitemapUrlNot200, {
        page: loc,
        detail: `The sitemap asks search engines to index this url, and it answers ${entry.status || 'nothing at all'}.`,
        evidence: [url(loc), status(`HTTP ${entry.status}`), text(`listed in ${ctx.sitemaps.found[0]?.url ?? 'the sitemap'}`)],
        fix: 'Remove dead urls from the sitemap, or restore the pages they point at.',
      }))
    }
    return out
  },
})

export const sitemapNoindexedUrl = define({
  id: 'indexability.sitemap-noindexed-url',
  severity: 'high',
  title: 'A sitemap url is kept out of the index',
  catches: 'A sitemap url blocked by robots.txt or by an X-Robots-Tag header.',
  run(ctx) {
    const byUrl = pageByUrl(ctx)
    const out = []
    for (const loc of ctx.sitemaps.urls) {
      if (!sameSite(ctx, hostOf(loc))) continue
      const evidence = [url(loc)]
      const path = pathOf(loc)
      if (ctx.robots.parsed !== null && path !== null && !isAllowed(ctx.robots.parsed, '*', path)) {
        evidence.push(text(`robots.txt disallows ${path}`))
      }
      const entry = byUrl.get(loc)
      const headerValue = entry ? xRobotsTag(entry) : ''
      if (directive(headerValue, 'noindex')) evidence.push(header(`x-robots-tag: ${headerValue}`))
      if (evidence.length === 1) continue
      out.push(emit(sitemapNoindexedUrl, {
        page: loc,
        detail: 'This url is in the sitemap, so something wants it indexed, but robots.txt or the response headers keep it out of the index.',
        evidence,
        fix: 'Remove the url from the sitemap, or lift the block that keeps it out of the index.',
      }))
    }
    return out
  },
})

export const sitemapOtherHost = define({
  id: 'indexability.sitemap-other-host',
  severity: 'high',
  title: 'The sitemap lists urls on another host',
  catches: 'A sitemap generated against the staging or pre-migration domain.',
  run(ctx) {
    const byHost = new Map()
    for (const loc of ctx.sitemaps.urls) {
      const host = hostOf(loc)
      if (sameSite(ctx, host)) continue
      const key = host ?? 'unparseable'
      if (!byHost.has(key)) byHost.set(key, [])
      byHost.get(key).push(loc)
    }
    return [...byHost.entries()].map(([host, locs]) => emit(sitemapOtherHost, {
      page: ctx.sitemaps.found[0]?.url ?? ctx.target.origin,
      detail: `${locs.length} sitemap url${locs.length === 1 ? '' : 's'} point at ${host} rather than ${ctx.target.host}. A sitemap may only list urls on the host that served it.`,
      evidence: [text(`other host: ${host} (${locs.length} url${locs.length === 1 ? '' : 's'})`), ...locs.slice(0, 5).map(url)],
      fix: `Regenerate the sitemap against ${ctx.target.origin}.`,
    }))
  },
})

export const sitemapLastmodFuture = define({
  id: 'indexability.sitemap-lastmod-future',
  severity: 'low',
  title: 'A sitemap lastmod is in the future',
  catches: 'A generator stamping lastmod from a clock nobody set.',
  run(ctx) {
    const out = []
    for (const entry of ctx.sitemaps.expanded.urls) {
      if (!entry.lastmod) continue
      const when = new Date(entry.lastmod)
      if (Number.isNaN(when.getTime()) || when.getTime() <= ctx.now.getTime()) continue
      out.push(emit(sitemapLastmodFuture, {
        page: entry.loc,
        detail: 'A lastmod dated in the future tells crawlers this page changed after the moment they are reading it. Most simply stop trusting the field.',
        evidence: [url(entry.loc), text(`lastmod: ${entry.lastmod} (now: ${ctx.now.toISOString()})`)],
        fix: 'Stamp lastmod from the real modification time, in UTC.',
      }))
    }
    return out
  },
})

export const canonicalMissing = define({
  id: 'indexability.canonical-missing',
  severity: 'medium',
  title: 'A page declares no canonical url',
  catches: 'Pages reachable at several urls with nothing saying which one counts.',
  run(ctx) {
    return htmlPages(ctx)
      .filter((entry) => entry.page.head.canonicalCount === 0)
      .map((entry) => emit(canonicalMissing, {
        page: entry.url,
        detail: 'Without a canonical, every url that serves this content competes with the others for the same ranking.',
        evidence: [url(entry.url), html('no <link rel="canonical"> in the document')],
        fix: `Add <link rel="canonical" href="${entry.finalUrl}"> to the page head.`,
      }))
  },
})

export const canonicalRelative = define({
  id: 'indexability.canonical-relative',
  severity: 'medium',
  title: 'A canonical url is relative',
  catches: 'A canonical written as a path, which resolves differently on www, apex and staging.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      const raw = rawCanonical(entry.response?.body)
      if (raw === null || /^https?:\/\//i.test(raw)) continue
      out.push(emit(canonicalRelative, {
        page: entry.url,
        detail: 'The canonical is written as a relative reference, so it resolves against whichever host served the page — including www, staging, or a preview deployment.',
        evidence: [url(entry.url), html(`<link rel="canonical" href="${raw}">`), text(`resolves here to ${entry.page.head.canonical ?? 'nothing'}`)],
        fix: 'Write the canonical as a fully qualified https url.',
      }))
    }
    return out
  },
})

export const canonicalOtherHost = define({
  id: 'indexability.canonical-other-host',
  severity: 'high',
  title: 'A canonical points at another host',
  catches: 'A canonical left pointing at the staging or pre-migration domain.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      const canonical = entry.page.head.canonical
      if (!canonical) continue
      const host = hostOf(canonical)
      if (sameSite(ctx, host)) continue
      out.push(emit(canonicalOtherHost, {
        page: entry.url,
        detail: `This page hands its ranking to ${host ?? 'an unparseable host'}. Unless that is a deliberate cross-domain canonical, the page will not rank on ${ctx.target.host} at all.`,
        evidence: [url(entry.url), html(`<link rel="canonical" href="${canonical}">`)],
        fix: `Point the canonical at the ${ctx.target.host} url for this page.`,
      }))
    }
    return out
  },
})

export const canonicalToRedirectOr404 = define({
  id: 'indexability.canonical-to-redirect-or-404',
  severity: 'high',
  title: 'A canonical points at a redirect or a dead url',
  catches: 'A canonical left behind by a url change.',
  run(ctx) {
    const byUrl = pageByUrl(ctx)
    const out = []
    for (const entry of htmlPages(ctx)) {
      const canonical = entry.page.head.canonical
      if (!canonical) continue
      if (!sameSite(ctx, hostOf(canonical))) continue
      if (canonical === entry.finalUrl) continue
      const target = byUrl.get(canonical)
      if (!target) continue // never fetched by the crawl; not worth a request of its own
      // The canonical is only a redirect when the canonical url ITSELF redirects. A crawl entry
      // whose chain is non-empty may simply be how the crawl reached this url — /blog → /blog/ —
      // and a canonical naming the /blog/ it landed on is correct, not a redirect.
      const redirected = target.url === canonical && target.finalUrl !== canonical
      if (target.status === 200 && !redirected) continue
      out.push(emit(canonicalToRedirectOr404, {
        page: entry.url,
        detail: redirected
          ? 'The canonical points at a url that redirects. A canonical has to name the url that actually serves the content.'
          : `The canonical points at a url that answers ${target.status || 'nothing at all'}.`,
        evidence: [
          url(entry.url),
          html(`<link rel="canonical" href="${canonical}">`),
          status(`${canonical} → HTTP ${target.status}${redirected ? ` after ${target.response?.chain?.length ?? 1} redirect(s), landing on ${target.finalUrl}` : ''}`),
        ],
        fix: 'Point the canonical at the final, 200-answering url.',
      }))
    }
    return out
  },
})

export const canonicalMultiple = define({
  id: 'indexability.canonical-multiple',
  severity: 'high',
  title: 'A page declares more than one canonical',
  catches: 'Two canonical tags, usually one from the theme and one from the SEO plugin.',
  run(ctx) {
    return htmlPages(ctx)
      .filter((entry) => entry.page.head.canonicalCount > 1)
      .map((entry) => emit(canonicalMultiple, {
        page: entry.url,
        detail: 'Search engines see conflicting canonical instructions and typically ignore all of them, falling back to their own guess.',
        evidence: [url(entry.url), html(`${entry.page.head.canonicalCount} <link rel="canonical"> tags, first: ${entry.page.head.canonical}`)],
        fix: 'Emit exactly one canonical per page.',
      }))
  },
})

export const canonicalHeaderMismatch = define({
  id: 'indexability.canonical-header-mismatch',
  severity: 'medium',
  title: 'The canonical header and tag disagree',
  catches: 'A Link: rel=canonical header fighting the one in the markup.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      const fromHeader = headerCanonical(entry)
      if (fromHeader === null) continue
      const fromTag = entry.page.head.canonical
      if (fromTag === null) continue
      const resolved = normalizeUrl(fromHeader, entry.finalUrl)
      if (resolved === fromTag) continue
      out.push(emit(canonicalHeaderMismatch, {
        page: entry.url,
        detail: 'The response header and the markup name different canonical urls. Which one wins is up to the crawler.',
        evidence: [url(entry.url), header(`link: <${fromHeader}>; rel="canonical"`), html(`<link rel="canonical" href="${fromTag}">`)],
        fix: 'Serve one canonical url, from the header or the markup, not both with different values.',
      }))
    }
    return out
  },
})

export const hreflangInvalid = define({
  id: 'indexability.hreflang-invalid',
  severity: 'medium',
  title: 'A page declares an invalid hreflang code',
  catches: 'en_US, english, or a region code in the wrong half of the pair.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      const bad = hreflangLinks(entry).map((link) => link.hreflang).filter((code) => !HREFLANG_CODE.test(code.trim()))
      if (bad.length === 0) continue
      out.push(emit(hreflangInvalid, {
        page: entry.url,
        detail: 'An hreflang value has to be an ISO 639-1 language, optionally a hyphen and an ISO 3166-1 region, or the literal x-default. Anything else is dropped silently.',
        evidence: [url(entry.url), ...bad.map((code) => html(`<link rel="alternate" hreflang="${code}">`))],
        fix: 'Use codes like "en", "en-gb" or "x-default" — a hyphen, never an underscore.',
      }))
    }
    return out
  },
})

export const hreflangNotReciprocal = define({
  id: 'indexability.hreflang-not-reciprocal',
  severity: 'medium',
  title: 'An hreflang alternate does not point back',
  catches: 'A one-way hreflang cluster, which search engines discard entirely.',
  run(ctx) {
    const pages = htmlPages(ctx)
    const declared = new Map()
    for (const entry of pages) {
      const hrefs = new Set()
      for (const link of hreflangLinks(entry)) if (link.href) hrefs.add(link.href)
      for (const key of [entry.url, entry.finalUrl]) declared.set(key, hrefs)
    }
    const out = []
    for (const entry of pages) {
      const missing = []
      for (const link of hreflangLinks(entry)) {
        if (link.hreflang.trim().toLowerCase() === 'x-default') continue
        if (!link.href) continue
        const theirs = declared.get(link.href)
        if (theirs === undefined) continue // not crawled, so nothing to judge
        if (theirs.has(entry.url) || theirs.has(entry.finalUrl)) continue
        missing.push(link.href)
      }
      if (missing.length === 0) continue
      out.push(emit(hreflangNotReciprocal, {
        page: entry.url,
        detail: 'Every page in an hreflang cluster has to list every other one, itself included. These alternates do not list this page back, so the cluster is ignored.',
        evidence: [url(entry.url), ...missing.map((href) => text(`${href} does not link back to ${entry.url}`))],
        fix: 'Emit the same complete set of hreflang links on every page in the cluster.',
      }))
    }
    return out
  },
})

export const hreflangNoXDefault = define({
  id: 'indexability.hreflang-no-x-default',
  severity: 'low',
  title: 'The hreflang cluster has no x-default',
  catches: 'A multi-language site with nothing to serve a language it does not cover.',
  run(ctx) {
    const pages = htmlPages(ctx)
    const codes = []
    for (const entry of pages) for (const link of hreflangLinks(entry)) codes.push(link.hreflang.trim().toLowerCase())
    if (codes.length === 0) return []
    if (codes.includes('x-default')) return []
    return [emit(hreflangNoXDefault, {
      page: ctx.target.url,
      detail: 'The site declares language alternates but never an x-default, so a visitor whose language is not covered gets whichever version the crawler guesses.',
      evidence: [url(ctx.target.url), text(`hreflang codes in use: ${[...new Set(codes)].join(', ')}`)],
      fix: 'Add <link rel="alternate" hreflang="x-default" href="..."> pointing at the fallback version.',
    })]
  },
})

export const llmsTxt = define({
  id: 'indexability.llms-txt',
  severity: 'info',
  title: 'llms.txt',
  catches: 'Whether the site offers an llms.txt, and whether it is shaped like one.',
  run(ctx) {
    const response = ctx.probes.llmsTxt
    const present = response.status === 200 && typeof response.body === 'string' && response.body.trim() !== ''
    const firstLine = present ? response.body.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? '' : ''
    const wellFormed = present && /^#\s+\S/.test(firstLine)
    const title = !present
      ? 'llms.txt is absent'
      : wellFormed
        ? 'llms.txt is present and well-formed'
        : 'llms.txt is present but malformed'
    const detail = !present
      ? 'There is no llms.txt at the site root. It is an emerging, entirely optional convention: a short markdown file telling language models what the site is and where its best documentation lives.'
      : wellFormed
        ? 'An llms.txt is served and starts with a single H1, the way the convention describes.'
        : 'An llms.txt is served, but it does not start with an H1 title, so a reader following the convention cannot tell what the file describes.'
    return [emit(llmsTxt, {
      page: ctx.probes.llmsTxt.url,
      title,
      detail,
      evidence: [
        url(ctx.probes.llmsTxt.url),
        status(`HTTP ${response.status}`),
        ...(present ? [text(`first line: ${firstLine}`)] : []),
      ],
      fix: present && !wellFormed
        ? 'Start llms.txt with a single "# Site name" H1, followed by an optional blockquote summary and link sections.'
        : 'No action required; publishing an llms.txt is optional.',
    })]
  },
})

export const checks = [
  siteNoindex,
  pageNoindexInSitemap,
  nosnippetUnintended,
  robotsUnfetchable,
  robotsSitemapLineMissing,
  robotsSitemapOtherHost,
  robotsBlocksAssets,
  aiCrawlerPolicy,
  sitemapMissing,
  sitemapInvalid,
  sitemapTooLarge,
  sitemapUrlNot200,
  sitemapNoindexedUrl,
  sitemapOtherHost,
  sitemapLastmodFuture,
  canonicalMissing,
  canonicalRelative,
  canonicalOtherHost,
  canonicalToRedirectOr404,
  canonicalMultiple,
  canonicalHeaderMismatch,
  hreflangInvalid,
  hreflangNotReciprocal,
  hreflangNoXDefault,
  llmsTxt,
]
