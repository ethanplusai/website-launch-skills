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
import { normalizeUrl } from '../crawl.mjs'

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

// Which urls count as "the start url" inside the crawl.
//
// `ctx.target.url` is what the operator typed; the crawl seeds through `normalizeUrl()`, which
// strips the fragment. A person who pastes `https://example.com/#top` out of a browser's address
// bar therefore had the two compared by equality and never matched — and a perfectly healthy site
// was reported as never having answered, as a blocker. A redirect is the other spelling of the
// same question: the start url can be the url a page was *asked* for or the url it settled on.
function startUrls(ctx) {
  const normalized = normalizeUrl(ctx.target.url, ctx.target.url)
  return new Set(normalized === null ? [ctx.target.url] : [normalized, ctx.target.url])
}

// The crawled page for the start url, preferring the url that was requested over one that merely
// redirected to it, or undefined when the crawl never fetched it at all.
function startPage(ctx) {
  const wanted = startUrls(ctx)
  return ctx.crawl.pages.find((entry) => wanted.has(entry.url))
    ?? ctx.crawl.pages.find((entry) => wanted.has(entry.finalUrl))
}

const NOT_FETCHED_REASON = {
  robots: 'robots.txt disallows it',
  'max-depth': 'the depth limit dropped it',
  'max-pages': 'the page budget dropped it',
  'off-origin': 'it is not on the origin being crawled',
}

// What went wrong before any check could read anything, or null when nothing did. Three states,
// and they are three different facts about three different failures:
//
//   not-fetched  the crawl never asked. There is no status, because nothing answered *or*
//                declined to — "the request failed" would describe a request nobody made.
//   no-answer    the crawl asked and got nothing back. `status` is 0, which is a real recorded
//                status and belongs in the evidence.
//   no-html      the start url answered, and nothing the crawl fetched parsed as a page.
//
// `parsed`/`total` are carried out because they decide a separate question the states do not:
// whether this report is *empty* or merely *narrow*. Only a crawl that parsed nothing at all can
// honestly say every HTTP-tier check ran against no content.
export function unreachableTarget(ctx) {
  const pages = ctx.crawl.pages
  const parsed = pages.filter((entry) => entry.page !== null).length
  const total = pages.length
  const start = startPage(ctx)

  if (start === undefined) {
    const wanted = startUrls(ctx)
    const drop = (ctx.crawl.dropped ?? []).find((d) => wanted.has(d.url))
    const because = drop === undefined
      ? 'the crawl never reached it'
      : NOT_FETCHED_REASON[drop.reason] ?? `the crawl dropped it (${drop.reason})`
    return { state: 'not-fetched', status: null, parsed, total, why: `the start url was not fetched: ${because}` }
  }

  if (start.status === 0) {
    const because = start.response?.timedOut === true
      ? 'the request timed out'
      : `the request failed (${start.response?.error ?? 'no response'})`
    return { state: 'no-answer', status: 0, parsed, total, why: `the start url never answered: ${because}` }
  }

  if (parsed === 0) {
    return {
      state: 'no-html',
      status: start.status,
      parsed,
      total,
      why: `${ctx.target.url} answered HTTP ${start.status}, and the crawl parsed no HTML page at all`,
    }
  }

  return null
}

// What the rest of the report is worth, given that gap: nothing, or only what did parse.
export function unreachableScope({ parsed, total }) {
  if (parsed === 0) {
    return 'Every HTTP-tier check ran against no content, so every one of them found nothing to report. Nothing else in this report is evidence that anything works; it is evidence that nothing was read.'
  }
  return `${parsed} of ${total} crawled urls did parse — findings below reflect those pages only, and nothing here covers the start url itself.`
}

const UNREACHABLE_TITLE = {
  'not-fetched': 'The start url was never fetched',
  'no-answer': 'The start url never answered',
  'no-html': 'The start url answered, and nothing the crawl fetched was a page',
}

const UNREACHABLE_FIX = {
  'not-fetched': 'Audit a url the crawl is allowed to fetch, or change the rule that excluded this one — for robots.txt, --ignore-robots re-runs it and says so in Not covered.',
  'no-answer': 'Check the url, the DNS for its host, and that the host is serving, then run the audit again.',
  'no-html': 'Point the audit at an HTML page. A url that serves a PDF, a JSON document or an empty body is not a page this tool can read.',
}

// The one finding that says the rest of the report is empty rather than clean.
//
// Every HTTP-tier check in this repository reads `ctx.crawl`, and a crawl that fetched nothing
// gives every one of them nothing to object to. Without this check, auditing a host that does not
// exist prints `blocker 0`, a handful of medium findings and a page of green — the single most
// misleading output this tool can produce, because it is indistinguishable from a site that
// passed. So the absence of content is itself the blocker, and it is the only blocker the
// inventory dimension raises.
export const targetUnreachable = define({
  id: 'inventory.target-unreachable',
  severity: 'blocker',
  title: 'The audit never read the url it was pointed at',
  catches: 'A start url that was never fetched, one that never answered, or a crawl that parsed no HTML at all — an audit with no content under it.',
  run(ctx) {
    const gap = unreachableTarget(ctx)
    if (gap === null) return []
    return [emit(targetUnreachable, {
      page: ctx.target.url,
      title: UNREACHABLE_TITLE[gap.state],
      detail: `${gap.why}. ${unreachableScope(gap)}`,
      evidence: [
        url(ctx.target.url),
        // A url nobody requested has no status. Printing `0` for it would be inventing the one
        // piece of evidence this finding is about not having.
        ...(gap.status === null ? [] : [status(gap.status)]),
        text(gap.why),
        metric(`${gap.parsed} of ${gap.total} crawled urls parsed as HTML`),
      ],
      fix: UNREACHABLE_FIX[gap.state],
    })]
  },
})

export const unreachablePage = define({
  id: 'inventory.unreachable-page',
  severity: 'medium',
  title: 'A page of this site never answered at all',
  catches: 'A crawled url whose request failed outright — DNS, TLS, a refused connection or a timeout — rather than returning a status.',
  run(ctx) {
    // The start url answering nothing is `inventory.target-unreachable`'s business, and a blocker
    // and a medium about the same url would read as two separate problems. Both use the same
    // normalized notion of "the start url", or they would disagree about which url that is.
    const start = startUrls(ctx)
    return ctx.crawl.pages
      .filter((entry) => entry.status === 0 && !start.has(entry.url))
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
  targetUnreachable,
  orphanPage,
  unlistedPage,
  deepPage,
  capped,
  non200Page,
  unreachablePage,
]
