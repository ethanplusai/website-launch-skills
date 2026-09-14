// Analytics: is the site measured, measured once, and measured into one property?
//
// Pure over the audit context. detect/analytics.mjs reads the *raw response body* of each crawled
// page rather than its extracted text, because every signature lives in markup a reader never
// sees — a script src, a data- attribute, a call inside an inline script. Running these over
// `page.text` would report a correctly instrumented site as having no analytics at all.
//
// What "the same tool twice" means is the one subtle thing here. A single correct install matches
// more than once on purpose: a GA4 snippet loads gtag.js and then calls `gtag('config', …)`, and
// Plausible's signature matches both its script host and its `data-domain` attribute. So a
// duplicate is not "more than one match" — it is either the same property id configured twice, or
// the exact same snippet text appearing twice. Two halves of one install never trigger it.
//
// What this dimension cannot tell you: whether the tag actually *fires*. A script tag in the
// markup proves the markup, not the request; consent banners, ad blockers and script errors all
// sit between the two. Confirming a real-time hit is a cutover job, and the report says so.

import { defineCheck } from '../registry.mjs'
import { detectAnalytics } from '../detect/analytics.mjs'

const PHASE = 'launch-audit'
const DIMENSION = 'analytics'
const TIER = 'http'
const EVIDENCE_LIMIT = 10

// The tools whose id names a property the data lands in. A second id for one of these means half
// the traffic is being reported somewhere nobody is looking.
const ID_BEARING = new Set(['GA4', 'GTM'])

const url = (value) => ({ type: 'url', value })
const html = (value) => ({ type: 'html', value })
const text = (value) => ({ type: 'text', value })
const metric = (value) => ({ type: 'metric', value })

const define = (def) => defineCheck({ phase: PHASE, dimension: DIMENSION, tier: TIER, ...def })
const emit = (check, overrides) => check.mk({ title: check.title, ...overrides })

const htmlPages = (ctx) => ctx.crawl.pages.filter((p) => p.page !== null && p.status >= 200 && p.status < 300)
const plural = (n, one, many) => (n === 1 ? one : many)
const bodyOf = (entry) => (typeof entry.response?.body === 'string' ? entry.response.body : '')

// Every crawled page with what was detected on it, grouped by tool. Computed once per check rather
// than once per site because the check modules are independent by design; the work is a handful of
// regex passes over bodies the context already holds.
function scan(ctx) {
  return htmlPages(ctx).map((entry) => {
    const hits = detectAnalytics(bodyOf(entry))
    const tools = new Map()
    for (const hit of hits) {
      if (!tools.has(hit.name)) tools.set(hit.name, { name: hit.name, hits: [], ids: new Set() })
      const tool = tools.get(hit.name)
      tool.hits.push(hit)
      if (hit.id !== null) tool.ids.add(hit.id)
    }
    return { entry, hits, tools }
  })
}

// Which tools appear anywhere, in first-seen order.
function toolsAcross(scanned) {
  const names = []
  for (const page of scanned) for (const name of page.tools.keys()) if (!names.includes(name)) names.push(name)
  return names
}

export const noneDetected = define({
  id: 'analytics.none-detected',
  severity: 'high',
  title: 'No analytics tag anywhere on the site',
  catches: 'A launch with no measurement at all: no baseline, and no way to tell afterwards whether it worked.',
  run(ctx) {
    const scanned = scan(ctx)
    if (scanned.length === 0 || scanned.some((page) => page.hits.length > 0)) return []
    return [emit(noneDetected, {
      page: scanned[0].entry.url,
      detail: `None of the ${scanned.length} crawled ${plural(scanned.length, 'page carries', 'pages carry')} a recognised analytics tag. From the moment this launches there is no record of how many people arrive, where from, or what they do — and no way to reconstruct it later.`,
      evidence: [metric(`${scanned.length} pages, 0 with a tag`), ...scanned.slice(0, EVIDENCE_LIMIT).map((page) => url(page.entry.url))],
      fix: 'Install one analytics tool site-wide before launch, and confirm a real-time hit from your own browser.',
    })]
  },
})

export const missingOnPages = define({
  id: 'analytics.missing-on-pages',
  severity: 'medium',
  title: 'The analytics tag is missing from some pages',
  catches: 'A tag in the main layout but not in a landing page or checkout template, so those visits are never counted.',
  run(ctx) {
    const scanned = scan(ctx)
    const out = []
    for (const name of toolsAcross(scanned)) {
      const missing = scanned.filter((page) => !page.tools.has(name))
      if (missing.length === 0) continue
      const present = scanned.length - missing.length
      out.push(emit(missingOnPages, {
        page: missing[0].entry.url,
        detail: `${name} is installed on ${present} of ${scanned.length} pages and absent from ${missing.length}. Those pages are invisible in the reports, which is most misleading exactly where it matters — a landing page with no data reads as a page nobody visits.`,
        evidence: [text(`${name}: present on ${present}, missing on ${missing.length}`), ...missing.slice(0, EVIDENCE_LIMIT).map((page) => url(page.entry.url))],
        fix: 'Move the tag into the shared layout every template uses, rather than into each page.',
      }))
    }
    return out
  },
})

export const duplicateInstall = define({
  id: 'analytics.duplicate-install',
  severity: 'medium',
  title: 'A page installs the same analytics tool twice',
  catches: 'A tag in both the layout and a page template, which doubles pageviews and halves the bounce rate.',
  run(ctx) {
    const out = []
    for (const page of scan(ctx)) {
      for (const tool of page.tools.values()) {
        // Two ids configured, or the same snippet written twice. Either is one install too many;
        // two different alternatives of one signature are not.
        const configured = tool.hits.filter((hit) => hit.id !== null)
        const counts = new Map()
        for (const hit of tool.hits) counts.set(hit.match, (counts.get(hit.match) ?? 0) + 1)
        const repeated = [...counts.entries()].filter(([, count]) => count > 1)
        if (configured.length < 2 && repeated.length === 0) continue
        const times = Math.max(configured.length, ...repeated.map(([, count]) => count))
        out.push(emit(duplicateInstall, {
          page: page.entry.url,
          detail: `${tool.name} is installed ${times} times on this page. Every visit is counted ${times} times over, so pageviews are inflated, bounce rate collapses, and every conversion rate computed from them is wrong.`,
          evidence: [
            url(page.entry.url),
            metric(`${tool.name} × ${times}`),
            ...(configured.length > 0 ? [text(`ids configured: ${configured.map((hit) => hit.id).join(', ')}`)] : []),
            ...repeated.slice(0, EVIDENCE_LIMIT).map(([match, count]) => html(`${match} × ${count}`)),
          ],
          fix: 'Keep the tag in one place — the shared layout — and remove the copy in the page template.',
        }))
      }
    }
    return out
  },
})

export const inconsistentIds = define({
  id: 'analytics.inconsistent-ids',
  severity: 'high',
  title: 'Pages report to different analytics properties',
  catches: 'Two measurement ids across one site — usually an old property left in a template after a rebuild.',
  run(ctx) {
    const scanned = scan(ctx)
    const out = []
    for (const name of toolsAcross(scanned)) {
      if (!ID_BEARING.has(name)) continue
      const byId = new Map()
      for (const page of scanned) {
        const tool = page.tools.get(name)
        if (tool === undefined) continue
        for (const id of tool.ids) {
          if (!byId.has(id)) byId.set(id, [])
          byId.get(id).push(page.entry.url)
        }
      }
      if (byId.size < 2) continue
      const ids = [...byId.entries()]
      out.push(emit(inconsistentIds, {
        page: ids[0][1][0],
        detail: `${name} reports to ${ids.length} different properties across this site. The traffic is split between them, so no single report describes the site and both look like a site with half the visitors it has.`,
        evidence: ids.slice(0, EVIDENCE_LIMIT).map(([id, pages]) => text(`${id} — on ${pages.slice(0, 3).join(', ')}`)),
        fix: 'Decide which property is the real one, put that id everywhere, and archive the other.',
      }))
    }
    return out
  },
})

export const summary = define({
  id: 'analytics.summary',
  severity: 'info',
  title: 'The analytics tools installed on this site',
  catches: 'Nothing — this is the list of what is measuring the site, so an unexpected entry is visible.',
  run(ctx) {
    const scanned = scan(ctx)
    const names = toolsAcross(scanned)
    if (names.length === 0) return []
    const lines = names.map((name) => {
      const pages = scanned.filter((page) => page.tools.has(name))
      const ids = new Set()
      for (const page of pages) for (const id of page.tools.get(name).ids) ids.add(id)
      return { name, count: pages.length, ids: [...ids] }
    })
    return [emit(summary, {
      page: scanned[0].entry.url,
      detail: `${names.length} analytics ${plural(names.length, 'tool was', 'tools were')} found in the markup: ${lines.map((line) => `${line.name}${line.ids.length > 0 ? ` (${line.ids.join(', ')})` : ''} on ${line.count} of ${scanned.length} pages`).join('; ')}. This is what the markup declares — it does not prove a tag fires, which a consent banner or a blocked script can prevent.`,
      evidence: lines.slice(0, EVIDENCE_LIMIT).map((line) => text(
        `${line.name}${line.ids.length > 0 ? ` — ${line.ids.join(', ')}` : ''} — ${line.count} of ${scanned.length} pages`,
      )),
      fix: 'Nothing to fix. Confirm each of these is a tool you meant to install, and check one real-time hit per tool.',
    })]
  },
})

export const checks = [
  noneDetected,
  missingOnPages,
  duplicateInstall,
  inconsistentIds,
  summary,
]
