// Cutover redirects: after the new site replaces the old one, does every url anybody already has
// still go somewhere?
//
// This is the one dimension that needs a second site. `--old-url` tells the audit where the old
// site is; _ctx.mjs crawls it the same way it crawls the new one, then asks the NEW origin about
// every path that crawl found, once each. Without it, this dimension emits exactly one finding
// saying so — a launch that replaces an existing site and never checks its old urls is how a
// business loses the search rankings it spent years earning, and silence here would look like a
// pass.
//
// Everything below is pure over the context. The three helpers are exported because the report
// bundle ships a `redirects.csv` a human can edit and hand to whoever owns the server:
//
//   redirectMap(oldCrawl, probes, newOrigin, newPaths) → one row per old url
//   bestMatch(oldPath, newPaths)                       → the new page that url probably became
//   toCsv(rows)                                        → RFC 4180
//
// A row's `status_on_new` is one of five, and the fifth matters as much as the others:
//
//   same-path-200   the same path serves a page on the new site; nothing to do
//   redirect-200    it redirects, and lands on a page
//   redirect-to-404 it redirects, and lands on an error — worse than no redirect, because the
//                   server looks like it handled the url
//   would-404       nothing is there and nothing redirects
//   unknown         the audit did not probe it (the page cap) or the new site did not answer
//
// `unknown` is never reported as a failure. A url the audit did not look at is a url nobody should
// draw a conclusion about, in either direction.
//
// bestMatch is a suggestion, never an instruction. It tokenizes both paths — split on `/` and `-`,
// lowercased, numbers and the smallest stop words dropped — takes the Jaccard overlap of the two
// token sets, and adds credit when one path's last segment contains the other's: a slug that
// survived a rename is the strongest signal a path carries, and an exact slug match earns the
// credit twice. Zero token overlap is `null` rather than a low score, because a bad suggestion in
// a redirect map is worse than none: somebody will paste it in.

import { defineCheck } from '../registry.mjs'
import { oldPageEntries } from './_ctx.mjs'

const PHASE = 'launch-audit'
const DIMENSION = 'redirects'
const TIER = 'http'
const EVIDENCE_LIMIT = 10

// Past this share of the probed old urls landing on one page, the "redirects" are a catch-all rule
// rather than a map, and search engines treat a catch-all to the front page as a soft 404.
const WILDCARD_SHARE = 0.30
// Credit for a last segment that survived the rename, applied once for a substring relation in
// either direction and again when the two segments are identical.
const SLUG_CREDIT = 0.15
// Words that carry no information about which page a path is.
const STOP_TOKENS = new Set(['the', 'a', 'an', 'and', 'of'])

const CSV_COLUMNS = ['old_url', 'status_on_new', 'final_url', 'recommendation', 'confidence']
export const CSV_HEADER = CSV_COLUMNS.join(',')

const url = (value) => ({ type: 'url', value })
const status = (value) => ({ type: 'status', value })
const text = (value) => ({ type: 'text', value })
const metric = (value) => ({ type: 'metric', value })

const define = (def) => defineCheck({ phase: PHASE, dimension: DIMENSION, tier: TIER, ...def })
const emit = (check, overrides) => check.mk({ title: check.title, ...overrides })

const plural = (n, one, many) => (n === 1 ? one : many)

// -------------------------------------------------------------------------------- the pure parts

function tokens(path) {
  const out = new Set()
  for (const raw of String(path ?? '').split(/[/\-]/)) {
    const token = raw.trim().toLowerCase()
    if (token === '') continue
    if (/^\d+$/.test(token)) continue
    if (STOP_TOKENS.has(token)) continue
    out.add(token)
  }
  return out
}

const lastSegment = (path) => {
  const parts = String(path ?? '').split('/').filter((part) => part !== '')
  return parts.length === 0 ? '' : parts[parts.length - 1].toLowerCase()
}

// How much two paths look like the same page. Jaccard over the token sets, plus the slug credit;
// `null` when the token sets do not overlap at all.
function score(oldPath, newPath) {
  const a = tokens(oldPath)
  const b = tokens(newPath)
  if (a.size === 0 || b.size === 0) return null
  let shared = 0
  for (const token of a) if (b.has(token)) shared++
  if (shared === 0) return null
  const union = a.size + b.size - shared
  let value = shared / union
  const lastA = lastSegment(oldPath)
  const lastB = lastSegment(newPath)
  if (lastA !== '' && lastB !== '') {
    if (lastA.includes(lastB) || lastB.includes(lastA)) value += SLUG_CREDIT
    if (lastA === lastB) value += SLUG_CREDIT
  }
  return Math.min(1, value)
}

export function bestMatch(oldPath, newPaths) {
  let best = null
  for (const newPath of newPaths ?? []) {
    const value = score(oldPath, newPath)
    if (value === null) continue
    if (best === null || value > best.confidence) best = { path: newPath, confidence: value }
  }
  if (best === null) return null
  return { path: best.path, confidence: Math.round(best.confidence * 100) / 100 }
}

// Every path the new site serves, for bestMatch to choose from.
export function newSitePaths(crawl) {
  const paths = new Set()
  for (const entry of crawl?.pages ?? []) {
    if (entry.page === null || entry.status < 200 || entry.status >= 300) continue
    try {
      const parsed = new URL(entry.finalUrl ?? entry.url)
      paths.add(parsed.pathname + parsed.search)
    } catch {
      // Not a path anything can redirect to.
    }
  }
  return [...paths]
}

// One row per old url. Rows carry `hops` and `old_path` beyond the five CSV columns, because the
// checks need them and the csv writer only ever reads the five.
export function redirectMap(oldCrawl, probes, newOrigin, newPaths = []) {
  const rows = []
  for (const { url: oldUrl, path } of oldPageEntries(oldCrawl)) {
    const asked = `${newOrigin}${path}`
    const response = probes?.oldPaths?.get(path)
    const row = { old_url: oldUrl, old_path: path, status_on_new: 'unknown', final_url: asked, recommendation: '', confidence: null, hops: 0 }

    if (response === undefined) {
      row.recommendation = 'not probed — the audit stopped at its page limit; check this url by hand'
      rows.push(row)
      continue
    }

    row.hops = Array.isArray(response.chain) ? response.chain.length : 0
    row.final_url = response.finalUrl ?? asked

    if (response.status === 0) {
      row.recommendation = `the new site did not answer (${response.error ?? 'no response'}) — check this url by hand`
      rows.push(row)
      continue
    }

    const served = response.status >= 200 && response.status < 300
    if (served && row.hops === 0) {
      row.status_on_new = 'same-path-200'
      row.recommendation = 'no redirect needed — the same path serves a page on the new site'
    } else if (served) {
      row.status_on_new = 'redirect-200'
      row.recommendation = `already redirects to ${row.final_url}`
    } else {
      row.status_on_new = row.hops > 0 ? 'redirect-to-404' : 'would-404'
      const match = bestMatch(path, newPaths)
      if (match === null) {
        row.recommendation = 'no match — decide manually'
      } else {
        row.recommendation = `redirect to ${match.path}`
        row.confidence = match.confidence
      }
    }
    rows.push(row)
  }
  return rows
}

// RFC 4180: CRLF between records, a field quoted whenever it contains a comma, a quote or a line
// break, and a quote inside a quoted field doubled.
const cell = (value) => {
  const asString = value === null || value === undefined ? '' : String(value)
  return /["\r\n,]/.test(asString) ? `"${asString.replace(/"/g, '""')}"` : asString
}

export function toCsv(rows) {
  const lines = [CSV_HEADER]
  for (const row of rows) lines.push(CSV_COLUMNS.map((column) => cell(row[column])).join(','))
  return `${lines.join('\r\n')}\r\n`
}

// The redirect map for this audit, ready to write to `redirects.csv`; null when the audit was
// never told there was an old site, because an empty csv would read as "nothing to redirect".
export function redirectsCsv(ctx) {
  if (!ctx.oldCrawl) return null
  return toCsv(redirectMap(ctx.oldCrawl, ctx.probes, ctx.target.origin, newSitePaths(ctx.crawl)))
}

// ------------------------------------------------------------------------------------- the checks

const mapFor = (ctx) => (
  ctx.oldCrawl ? redirectMap(ctx.oldCrawl, ctx.probes, ctx.target.origin, newSitePaths(ctx.crawl)) : null
)
const probedRows = (rows) => rows.filter((row) => row.status_on_new !== 'unknown')

const recommendationEvidence = (row) => (
  row.confidence === null
    ? text(row.recommendation)
    : metric(`${row.recommendation} (confidence ${row.confidence})`)
)

export const would404 = define({
  id: 'redirects.would-404',
  severity: 'high',
  title: 'An old url has nothing waiting for it on the new site',
  catches: 'A url the old site served that the new site answers with a 404 and does not redirect — every link and bookmark to it is now dead.',
  run(ctx) {
    const rows = mapFor(ctx)
    if (rows === null) return []
    return rows.filter((row) => row.status_on_new === 'would-404').map((row) => emit(would404, {
      page: row.old_url,
      detail: `${row.old_url} is a page the old site serves. On the new site the same path answers 404 and nothing redirects it. Every link anybody has to that page — from search results, from other sites, from somebody's bookmarks — now lands on an error, and the search ranking that url earned goes with it. Suggested destination: ${row.recommendation}.`,
      evidence: [url(row.old_url), status(404), url(row.final_url), recommendationEvidence(row)],
      fix: `Add a 301 from ${row.old_path} to the page that replaced it${row.confidence === null ? '' : ` — ${row.recommendation} is the closest match the audit found`}.`,
    }))
  },
})

export const to404 = define({
  id: 'redirects.to-404',
  severity: 'high',
  title: 'A redirect sends an old url to an error page',
  catches: 'An old url that does redirect — and lands on a 404. Worse than no redirect, because the server looks like it handled it.',
  run(ctx) {
    const rows = mapFor(ctx)
    if (rows === null) return []
    return rows.filter((row) => row.status_on_new === 'redirect-to-404').map((row) => emit(to404, {
      page: row.old_url,
      detail: `${row.old_url} redirects to ${row.final_url}, which answers 404. Somebody wrote a redirect rule for this url and it points at a page that is not there — so the visitor waits for a redirect and still lands on an error, and nothing in the server logs looks wrong. Suggested destination: ${row.recommendation}.`,
      evidence: [url(row.old_url), url(row.final_url), status(404), recommendationEvidence(row)],
      fix: 'Point the existing redirect rule at a page that exists, or remove it and write the right one.',
    }))
  },
})

export const chain = define({
  id: 'redirects.chain',
  severity: 'medium',
  title: 'An old url takes more than one hop to arrive',
  catches: 'A redirect chain — two or more hops — which costs a round trip each and which some crawlers stop following.',
  run(ctx) {
    const rows = mapFor(ctx)
    if (rows === null) return []
    return rows.filter((row) => row.hops > 1).map((row) => emit(chain, {
      page: row.old_url,
      detail: `${row.old_url} takes ${row.hops} hops to reach ${row.final_url}. Each hop is a full round trip before anything renders, and crawlers give up on long chains, so the ranking the old url carried arrives diluted or not at all. Chains usually grow one rule at a time — an http-to-https rule, then a trailing-slash rule, then the cutover rule.`,
      evidence: [url(row.old_url), metric(`${row.hops} hops`), url(row.final_url)],
      fix: `Collapse the chain: redirect ${row.old_path} straight to ${row.final_url} in one hop.`,
    }))
  },
})

export const wildcardSmell = define({
  id: 'redirects.wildcard-smell',
  severity: 'medium',
  title: 'A catch-all rule is standing in for a redirect map',
  catches: 'More than 30% of the old urls landing on one page — the signature of a wildcard rule that redirects everything to the front page.',
  run(ctx) {
    const rows = mapFor(ctx)
    if (rows === null) return []
    const probed = probedRows(rows)
    if (probed.length === 0) return []
    const byTarget = new Map()
    for (const row of probed) {
      if (row.status_on_new !== 'redirect-200' && row.status_on_new !== 'redirect-to-404') continue
      // A redirect that lands on the old url's own path is a normalization rule — a trailing
      // slash, a case fix — and not a catch-all, however many urls go through it.
      let targetPath = null
      try {
        targetPath = new URL(row.final_url).pathname
      } catch {
        targetPath = null
      }
      if (targetPath !== null && targetPath === row.old_path) continue
      if (!byTarget.has(row.final_url)) byTarget.set(row.final_url, [])
      byTarget.get(row.final_url).push(row)
    }
    const out = []
    for (const [target, group] of byTarget) {
      const share = group.length / probed.length
      if (share <= WILDCARD_SHARE) continue
      out.push(emit(wildcardSmell, {
        page: target,
        detail: `${group.length} of the ${probed.length} old urls the audit probed — ${Math.round(share * 100)}% — all land on ${target}. That is what a catch-all rule looks like, not a redirect map. Search engines treat a redirect to an unrelated page as a soft 404 and drop the ranking anyway, and a visitor following a link to a specific page gets the front page with no explanation.`,
        evidence: [
          url(target),
          metric(`${group.length} of ${probed.length} probed old urls (${Math.round(share * 100)}%) land here`),
          ...group.slice(0, EVIDENCE_LIMIT).map((row) => url(row.old_url)),
        ],
        fix: 'Replace the catch-all with a url-by-url map — redirects.csv in this bundle is the list — and keep the catch-all only as the last resort for urls nothing replaced.',
      }))
    }
    return out
  },
})

export const summary = define({
  id: 'redirects.summary',
  severity: 'info',
  title: 'What the new site does with every old url',
  catches: 'The count of old urls by outcome, and the pointer to the full map in redirects.csv.',
  run(ctx) {
    const rows = mapFor(ctx)
    if (rows === null) return []
    if (rows.length === 0) return []
    const counts = new Map()
    for (const row of rows) counts.set(row.status_on_new, (counts.get(row.status_on_new) ?? 0) + 1)
    const order = ['same-path-200', 'redirect-200', 'redirect-to-404', 'would-404', 'unknown']
    const present = order.filter((name) => counts.has(name))
    return [emit(summary, {
      detail: `${rows.length} old ${plural(rows.length, 'url was', 'urls were')} checked against the new site: ${present.map((name) => `${counts.get(name)} ${name}`).join(', ')}. The full row-by-row map, with a suggested destination for each url that needs one, is in redirects.csv beside this report — edit it and hand it to whoever owns the server.`,
      evidence: [
        ...present.map((name) => metric(`${name}: ${counts.get(name)}`)),
        text(`old site crawled: ${ctx.options.oldUrl}`),
      ],
      fix: 'Work through redirects.csv, decide the rows the audit could not, and put the redirects in place before the DNS changes.',
    })]
  },
})

export const oldUrlRequired = define({
  id: 'redirects.old-url-required',
  severity: 'info',
  title: 'No old site was given, so no old url was checked',
  catches: 'A launch-audit run with no --old-url: if this site replaces an existing one, nothing here says whether its urls survived.',
  run(ctx) {
    if (ctx.oldCrawl) return []
    return [emit(oldUrlRequired, {
      detail: 'This audit was not told about an old site, so it checked no old urls. If the site being launched replaces one that is already live, every url the old site serves needs somewhere to land — a rebuild that drops them loses the search rankings, the inbound links and the bookmarks all at once, and the loss is not visible on the new site at all. If this is a genuinely new site with no predecessor, there is nothing to do.',
      evidence: [text('no --old-url was given, so the redirect map is empty'), text('unchecked: every url of the site this one replaces')],
      fix: 'Run the audit again with --old-url pointing at the old site, and work through the redirects.csv it produces.',
    })]
  },
})

export const checks = [
  would404,
  to404,
  chain,
  wildcardSmell,
  summary,
  oldUrlRequired,
]
