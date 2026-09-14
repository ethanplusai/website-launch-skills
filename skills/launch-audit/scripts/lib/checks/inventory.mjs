// Inventory: is the set of pages the site actually has the set of pages it means to have?
//
// Pure over the audit context. The crawl already did all of the work — it seeded from the sitemap
// and from the start url, recorded who linked to what, and kept the reason it refused every url it
// did not fetch — so this dimension only reads `ctx.crawl` and `ctx.probes.caps`.
//
// Two habits shape the findings:
//
// - Everything here is a property of one url, so it is reported once per url. A site with forty
//   orphans has forty pages to decide about, and collapsing them into one finding would hide which
//   ones they are.
// - `inventory.capped` is the exception and the honest one: it is the single finding that says
//   what the audit did not look at, naming every url the crawl dropped and every probe set that
//   ran past its cap. The report's "Not covered" section carries the same list, because a reader
//   who only reads the findings should still learn that the audit stopped short.
//
// A url that never answered is never reported as an error page. `status: 0` means the request
// failed — DNS, TLS, a timeout, a connection refused — and that is a different problem with a
// different fix from a 500, so it gets its own check and a lower severity: the audit cannot prove
// the page is broken, only that it could not reach it.

import { defineCheck } from '../registry.mjs'

const PHASE = 'launch-audit'
const DIMENSION = 'inventory'
const TIER = 'http'

// Three clicks from the front page is the depth most navigation is designed around; past it, a
// page is usually one somebody forgot to link.
const MAX_CLICKS = 3

const DROP_LABEL = {
  'max-pages': 'dropped by the page budget',
  'max-depth': 'dropped by the depth limit',
  robots: 'excluded by robots.txt',
  'off-origin': 'off-origin sitemap entry, never fetched',
}

const CAP_LABEL = {
  externals: 'outbound links',
  images: 'images',
  embeds: 'form embeds',
  headAssets: 'icons, manifests and social images',
  oldPaths: 'old-site paths',
}

const url = (value) => ({ type: 'url', value })
const status = (value) => ({ type: 'status', value })
const text = (value) => ({ type: 'text', value })
const metric = (value) => ({ type: 'metric', value })

const define = (def) => defineCheck({ phase: PHASE, dimension: DIMENSION, tier: TIER, ...def })
const emit = (check, overrides) => check.mk({ title: check.title, ...overrides })

const plural = (n, one, many) => (n === 1 ? one : many)

export const orphanPage = define({
  id: 'inventory.orphan-page',
  severity: 'medium',
  title: 'A page the sitemap advertises that nothing on the site links to',
  catches: 'A sitemap url no crawled page links to — reachable only by typing its address or finding it in search.',
  run(ctx) {
    return ctx.crawl.orphans.map((target) => emit(orphanPage, {
      page: target,
      detail: `${target} is listed in the sitemap, and no page the crawl fetched links to it. A visitor can only reach it from search results or a link somebody saved, so whatever it is for — a service, a landing page, a form — most of the site's traffic will never see it.`,
      evidence: [url(target), text('named by the sitemap, linked from no crawled page')],
      fix: 'Link it from the navigation or from a related page, or take it out of the sitemap if it is deliberately unlisted.',
    }))
  },
})

export const unlistedPage = define({
  id: 'inventory.unlisted-page',
  severity: 'low',
  title: 'A page the site links to that the sitemap leaves out',
  catches: 'A page the crawl reached by following links that no sitemap entry mentions.',
  run(ctx) {
    return ctx.crawl.unlisted.map((target) => emit(unlistedPage, {
      page: target,
      detail: `${target} is a real page of this site — the crawl reached it by following a link — but the sitemap does not list it. Search engines will usually find it anyway, and a sitemap that disagrees with the site is still a sign that the sitemap is generated from something stale.`,
      evidence: [url(target), text('reached by the crawl, absent from the sitemap')],
      fix: 'Regenerate the sitemap from the live route list, or exclude the page deliberately if it should not be indexed.',
    }))
  },
})

export const deepPage = define({
  id: 'inventory.deep-page',
  severity: 'low',
  title: 'A page buried more than three clicks from the front page',
  catches: 'A page the crawl only reached at depth four or deeper — a page nobody browsing the site is likely to find.',
  run(ctx) {
    return ctx.crawl.pages
      .filter((entry) => entry.depth > MAX_CLICKS)
      .map((entry) => emit(deepPage, {
        page: entry.url,
        detail: `The shortest path the crawl found to ${entry.url} is ${entry.depth} clicks from the front page. Visitors who browse rather than search rarely go that deep, and neither do most crawlers' link budgets.`,
        evidence: [url(entry.url), metric(`${entry.depth} clicks from the front page`)],
        fix: 'Link it from a page nearer the front — a hub page, the navigation, or a related-pages block.',
      }))
  },
})

export const capped = define({
  id: 'inventory.capped',
  severity: 'info',
  title: 'The audit stopped short of some urls',
  catches: 'Every url the crawl refused, and every probe set that hit its cap — what this report does not cover.',
  run(ctx) {
    const evidence = []
    for (const drop of ctx.crawl.dropped) {
      evidence.push(text(`${DROP_LABEL[drop.reason] ?? `dropped by ${drop.reason}`}: ${drop.url}`))
    }
    const overCap = []
    for (const [name, cap] of Object.entries(ctx.probes.caps ?? {})) {
      if (!cap || cap.dropped <= 0) continue
      overCap.push(`${cap.dropped} ${CAP_LABEL[name] ?? name} past the cap of ${cap.cap}`)
      evidence.push(metric(`${CAP_LABEL[name] ?? name}: ${cap.dropped} url${plural(cap.dropped, '', 's')} past the cap of ${cap.cap} were not fetched`))
    }
    if (evidence.length === 0) return []
    const dropped = ctx.crawl.dropped.length
    const parts = []
    if (dropped > 0) parts.push(`${dropped} url${plural(dropped, '', 's')} the crawl did not fetch`)
    parts.push(...overCap)
    return [emit(capped, {
      detail: `This audit did not look at everything: ${parts.join(', ')}. Nothing below says anything about those urls, in either direction — they are neither passing nor failing, they are simply not covered.`,
      evidence,
      fix: 'Raise the limits (--max-pages, --max-depth) and run again if any of these urls matter, or accept the gap knowingly.',
    })]
  },
})

export const non200Page = define({
  id: 'inventory.non-200-page',
  severity: 'high',
  title: 'A page of this site answers with an error',
  catches: 'A crawled url whose final response is a 4xx or a 5xx — a page that is linked or listed but does not load.',
  run(ctx) {
    return ctx.crawl.pages
      .filter((entry) => entry.status >= 400)
      .map((entry) => emit(non200Page, {
        page: entry.url,
        detail: `${entry.url} answers ${entry.status}. It is part of this site — the sitemap lists it or a page links to it — and every visitor and crawler that follows it lands on an error instead of a page.`,
        evidence: [url(entry.url), status(entry.status), text(`reached as a ${entry.source} url at depth ${entry.depth}`)],
        fix: entry.status >= 500
          ? 'Fix the server error, or remove the url from the sitemap and the links that point at it.'
          : 'Restore the page, redirect the url to whatever replaced it, or remove the links and sitemap entry.',
      }))
  },
})

export const unreachablePage = define({
  id: 'inventory.unreachable-page',
  severity: 'medium',
  title: 'A page of this site never answered at all',
  catches: 'A crawled url whose request failed outright — DNS, TLS, a refused connection or a timeout — rather than returning a status.',
  run(ctx) {
    return ctx.crawl.pages
      .filter((entry) => entry.status === 0)
      .map((entry) => {
        const why = entry.response?.timedOut === true
          ? 'the request timed out'
          : `the request failed (${entry.response?.error ?? 'no response'})`
        return emit(unreachablePage, {
          page: entry.url,
          detail: `${entry.url} never answered: ${why}. This is not proof the page is broken — the audit could not reach it — but nothing here proves it works either, and a url the crawl cannot reach is one a visitor may not be able to reach.`,
          evidence: [url(entry.url), status(entry.status), text(why)],
          fix: 'Open the url yourself. If it loads, the failure was transient; if it does not, fix the host or remove the url.',
        })
      })
  },
})

export const checks = [
  orphanPage,
  unlistedPage,
  deepPage,
  capped,
  non200Page,
  unreachablePage,
]
