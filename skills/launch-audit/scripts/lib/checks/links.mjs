// Links: does every link go somewhere, and does its label say where?
//
// Pure over the audit context. The crawl already fetched every same-origin url it reached and
// recorded who linked to it (`crawl.internalLinks`), and _ctx.mjs already HEADed every off-origin
// url the crawl saw into `probes.externals`, so nothing here fetches.
//
// Three habits decide how a finding is shaped:
//
// - A dead target is reported once per target, naming the pages that link to it, because the fix
//   is one fix. Everything else is a property of the page that wrote the markup, and is reported
//   once per page listing the offending links.
// - An unknown answer is never a failure. An internal target the crawl never fetched (dropped by a
//   cap, or excluded by robots) is skipped; an external that timed out, refused a bot or asked for
//   credentials is `links.external-unverifiable` at info, never `links.external-broken`. A launch
//   is not blocked by a firewall the audit cannot see past.
// - A skip link is a property of the layout rather than of any one page, so the pages that lack one
//   are listed in a single finding instead of producing one per page on a 200-page site.
//
// `links.to-dev-host` is the one check whose severity moves: pointing at localhost from production
// is a blocker, and doing it from a staging target is a high — the same markup has to be fixed
// before it ships, but the staging build is not the thing being launched.

import { defineCheck } from '../registry.mjs'
import { normalizeUrl } from '../crawl.mjs'
import { DEV_HOSTS, scanText } from '../detect/placeholders.mjs'

const PHASE = 'launch-audit'
const DIMENSION = 'links'
const TIER = 'http'
const EVIDENCE_LIMIT = 10

// Statuses that prove an off-origin target is gone, and statuses that only prove the audit was not
// allowed to look. A 401 or a 403 to an anonymous HEAD is far more often bot protection or a login
// wall than a dead url, and a 429 is the opposite of evidence.
const EXTERNAL_GONE = (status) => status === 404 || status === 410 || status >= 500
const EXTERNAL_UNKNOWN = (status) => status === 0 || status === 401 || status === 403 || status === 429

// Anchor text that describes the act of clicking rather than the destination. A screen-reader user
// listing the links on the page hears only these words, and a search engine reads them as the
// description of the target.
const GENERIC_TEXT = new Set([
  'click here', 'click', 'here', 'read more', 'learn more', 'more', 'more info', 'more information',
  'this', 'this page', 'this link', 'link', 'details', 'see more', 'find out more', 'continue',
  'go', 'view', 'download',
])

const EMAIL = /^[^\s@,]+@[^\s@,.]+(?:\.[^\s@,.]+)+$/
const TEL_STRIP = /[\s().-]/g

const url = (value) => ({ type: 'url', value })
const status = (value) => ({ type: 'status', value })
const html = (value) => ({ type: 'html', value })
const text = (value) => ({ type: 'text', value })
const metric = (value) => ({ type: 'metric', value })

const define = (def) => defineCheck({ phase: PHASE, dimension: DIMENSION, tier: TIER, ...def })
const emit = (check, overrides) => check.mk({ title: check.title, ...overrides })

const htmlPages = (ctx) => ctx.crawl.pages.filter((p) => p.page !== null && p.status >= 200 && p.status < 300)
const baseOf = (entry) => entry.finalUrl ?? entry.url
const webLinks = (entry) => entry.page.links.filter((link) => link.href !== null && (link.scheme === 'http' || link.scheme === 'https'))
const rels = (link) => (link.rel === null ? [] : link.rel.split(/\s+/))
const label = (link) => (link.text !== '' ? link.text : (link.ariaLabel ?? ''))
const normalizedText = (link) => label(link).toLowerCase().replace(/\s+/g, ' ').replace(/[.!?:;,…]+$/, '').trim()
const hostOf = (href) => {
  try {
    return new URL(href).hostname.toLowerCase()
  } catch {
    return null
  }
}
const uniq = (values) => [...new Set(values)]

// decodeURIComponent throws a URIError on a stray percent sign — and a stray percent sign in an
// href is exactly the kind of malformed link this dimension exists to find, so a decode failure
// must hand back the raw text rather than take the whole audit down with it. The raw text is also
// the right thing to judge: `mailto:jo%e@` is not a usable address either way.
const safeDecode = (value) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

// The hosts that are this site. A production site can perfectly well live on a preview domain —
// `acme.vercel.app` is a real address a real business hands out — and a staging run is pointed at
// a staging host on purpose. Reporting every internal link, or the site's own form action, as a
// reference to a development host would make both of those audits unusable, so the audited host
// (with its apex and www counterparts, and the host of the url the audit was given) is exempt. A
// *different* host matching the same pattern is still reported.
function ownHosts(ctx) {
  const hosts = new Set()
  const add = (host) => { if (typeof host === 'string' && host !== '') hosts.add(host.toLowerCase()) }
  add(ctx.target.host)
  add(ctx.target.apex)
  if (ctx.target.hasWwwCounterpart) add(ctx.target.www)
  try {
    add(new URL(ctx.target.url).hostname)
  } catch {
    // target.url is the url the audit parsed to build the context; if it will not parse here there
    // is nothing to add and nothing to exempt.
  }
  return hosts
}


// Every crawled url, reachable by the url the crawl asked for and by the url it landed on, so a
// link written to either spelling finds the same result. The url-keyed pass runs first and wins:
// a redirect target that was also crawled in its own right keeps its own entry.
function pageIndex(ctx) {
  const byUrl = new Map()
  for (const entry of ctx.crawl.pages) byUrl.set(entry.url, entry)
  for (const entry of ctx.crawl.pages) {
    const final = entry.finalUrl
    if (typeof final === 'string' && final !== '' && !byUrl.has(final)) byUrl.set(final, entry)
  }
  return byUrl
}

// One finding per page, built from whatever the page's own links turned up. `select` returns the
// offending links for a page; `describe` turns them into the finding body.
function perPage(ctx, check, select, describe) {
  const out = []
  for (const entry of htmlPages(ctx)) {
    const hits = select(entry)
    if (hits.length === 0) continue
    out.push(emit(check, { page: entry.url, ...describe(hits, entry) }))
  }
  return out
}

export const internalBroken = define({
  id: 'links.internal-broken',
  severity: 'high',
  title: 'A link points at a page of this site that is not there',
  catches: 'A same-origin link to a url that answers 404 or 500 — a renamed page, a typo, a deleted draft.',
  run(ctx) {
    const byUrl = pageIndex(ctx)
    const out = []
    for (const [target, referrers] of ctx.crawl.internalLinks) {
      const entry = byUrl.get(target)
      // A target the crawl never fetched is unknown, not broken.
      if (entry === undefined || entry.status < 400) continue
      const pages = uniq(referrers)
      out.push(emit(internalBroken, {
        page: pages[0],
        detail: `${target} answers ${entry.status}, and ${pages.length} page${pages.length === 1 ? '' : 's'} on this site link${pages.length === 1 ? 's' : ''} to it. Every visitor who follows one of those links lands on an error.`,
        evidence: [url(target), status(entry.status), ...pages.slice(0, EVIDENCE_LIMIT).map((page) => text(`linked from ${page}`))],
        fix: 'Point the link at the page that replaced it, or remove the link.',
      }))
    }
    return out
  },
})

export const externalBroken = define({
  id: 'links.external-broken',
  severity: 'medium',
  title: 'A link points at a page on another site that is not there',
  catches: 'An outbound link whose target answers 404, 410 or a server error.',
  run(ctx) {
    const out = []
    for (const [target, referrers] of ctx.crawl.externalLinks) {
      const response = ctx.probes.externals.get(target)
      if (response === undefined || !EXTERNAL_GONE(response.status)) continue
      const pages = uniq(referrers)
      out.push(emit(externalBroken, {
        page: pages[0],
        detail: `${target} answers ${response.status}. The page it used to hold is gone, and the link now sends visitors to an error on someone else's site.`,
        evidence: [url(target), status(response.status), ...pages.slice(0, EVIDENCE_LIMIT).map((page) => text(`linked from ${page}`))],
        fix: 'Find where that page moved to, link there instead, or drop the link.',
      }))
    }
    return out
  },
})

export const externalUnverifiable = define({
  id: 'links.external-unverifiable',
  severity: 'info',
  title: 'An outbound link could not be checked',
  catches: 'An external target that timed out, refused an anonymous request, or rate-limited the audit — checked by hand, not by this tool.',
  run(ctx) {
    const out = []
    for (const [target, referrers] of ctx.crawl.externalLinks) {
      const response = ctx.probes.externals.get(target)
      if (response === undefined || !EXTERNAL_UNKNOWN(response.status)) continue
      const pages = uniq(referrers)
      const why = response.status === 0
        ? (response.timedOut === true ? 'the request timed out' : `the request failed (${response.error ?? 'no response'})`)
        : `the server answered ${response.status}, which is what bot protection and login walls answer`
      out.push(emit(externalUnverifiable, {
        page: pages[0],
        detail: `${target} could not be checked: ${why}. This is not a failure — the link may be perfectly fine — but nothing here proves it works.`,
        evidence: [url(target), status(response.status), text(why), ...pages.slice(0, EVIDENCE_LIMIT).map((page) => text(`linked from ${page}`))],
        fix: 'Open the link yourself once, and move on if it loads.',
      }))
    }
    return out
  },
})

export const toDevHost = define({
  id: 'links.to-dev-host',
  severity: 'blocker',
  title: 'A link points at a development host',
  catches: 'localhost, a preview deployment or the staging host, linked from a page that shipped.',
  run(ctx) {
    const staging = ctx.target.staging
    const extraHosts = ctx.target.devHosts
    const own = ownHosts(ctx)
    return perPage(ctx, toDevHost, (entry) => webLinks(entry).filter((link) => {
      const host = hostOf(link.href)
      if (host === null || own.has(host)) return false
      return scanText(host, DEV_HOSTS, { extraHosts }).length > 0
    }), (hits, entry) => ({
      severity: staging ? 'high' : 'blocker',
      title: staging ? 'A staging page links to a development host' : 'A link points at a development host',
      detail: staging
        ? `This staging page carries ${hits.length} link${hits.length === 1 ? '' : 's'} to a development host. Fix the markup before it reaches production, where nobody but you can follow them.`
        : `This page carries ${hits.length} link${hits.length === 1 ? '' : 's'} to a development host. Nobody but the developer can load them, so for every visitor the link is simply dead.`,
      evidence: [url(entry.url), ...hits.slice(0, EVIDENCE_LIMIT).map((link) => html(`<a href="${link.href}">${label(link) || '(no text)'}</a>`))],
      fix: 'Point the links at the production urls, and check the build for a hardcoded base url.',
    }))
  },
})

export const toHttpOnHttps = define({
  id: 'links.to-http-on-https',
  severity: 'medium',
  title: 'An https page links to a plain-http url',
  catches: 'A link left on http from a page served over https — a downgrade, and often a redirect or a dead host.',
  run(ctx) {
    return perPage(ctx, toHttpOnHttps, (entry) => {
      if (!baseOf(entry).startsWith('https://')) return []
      return webLinks(entry).filter((link) => link.href.startsWith('http://'))
    }, (hits, entry) => ({
      detail: `This page is served over https and links to ${hits.length} plain-http url${hits.length === 1 ? '' : 's'}. Following one drops the visitor out of https, and a browser may block or rewrite the request without saying so.`,
      evidence: [url(entry.url), ...hits.slice(0, EVIDENCE_LIMIT).map((link) => url(link.href))],
      fix: 'Rewrite the links to https, and confirm each target actually serves it.',
    }))
  },
})

export const toRedirectingInternal = define({
  id: 'links.to-redirecting-internal',
  severity: 'low',
  title: 'An internal link goes through a redirect',
  catches: 'A same-origin link written to the old url, so every visit costs an extra round trip.',
  run(ctx) {
    const byUrl = pageIndex(ctx)
    const out = []
    for (const [target, referrers] of ctx.crawl.internalLinks) {
      const entry = byUrl.get(target)
      if (entry === undefined || entry.url !== target) continue
      const chain = entry.response?.chain ?? []
      if (chain.length === 0) continue
      const pages = uniq(referrers)
      out.push(emit(toRedirectingInternal, {
        page: pages[0],
        detail: `${target} redirects to ${entry.finalUrl} before anything renders. The link works, but every visitor pays for a redirect the site could just write out of the markup.`,
        evidence: [url(target), url(entry.finalUrl), metric(`${chain.length} redirect${chain.length === 1 ? '' : 's'}`), ...pages.slice(0, EVIDENCE_LIMIT).map((page) => text(`linked from ${page}`))],
        fix: 'Link straight to the final url.',
      }))
    }
    return out
  },
})

export const noopenerMissing = define({
  id: 'links.noopener-missing',
  severity: 'low',
  title: 'A new-tab link has no rel="noopener"',
  catches: 'target="_blank" without noopener, which hands the opened page a handle back to this one.',
  run(ctx) {
    return perPage(ctx, noopenerMissing, (entry) => webLinks(entry).filter((link) => {
      if (String(link.target ?? '').toLowerCase() !== '_blank') return false
      const tokens = rels(link)
      return !tokens.includes('noopener') && !tokens.includes('noreferrer')
    }), (hits, entry) => ({
      detail: `${hits.length} link${hits.length === 1 ? '' : 's'} on this page open${hits.length === 1 ? 's' : ''} in a new tab without rel="noopener". Current browsers imply it, older ones do not, and the opened page can then navigate this one.`,
      evidence: [url(entry.url), ...hits.slice(0, EVIDENCE_LIMIT).map((link) => html(`<a href="${link.href}" target="_blank">`))],
      fix: 'Add rel="noopener" (or "noopener noreferrer") to every target="_blank" link.',
    }))
  },
})

export const mailtoInvalid = define({
  id: 'links.mailto-invalid',
  severity: 'medium',
  title: 'A mailto: link has no usable address',
  catches: 'mailto: with an empty or malformed address — a contact link that opens an empty mail window.',
  run(ctx) {
    return perPage(ctx, mailtoInvalid, (entry) => entry.page.links.filter((link) => {
      if (link.scheme !== 'mailto' || link.href === null) return false
      const addresses = link.href.slice('mailto:'.length).split('?')[0].split(',').map((a) => safeDecode(a).trim())
      return addresses.length === 0 || addresses.some((address) => !EMAIL.test(address))
    }), (hits, entry) => ({
      detail: `${hits.length} mailto: link${hits.length === 1 ? '' : 's'} on this page carr${hits.length === 1 ? 'ies' : 'y'} an address that is not an address. Clicking one opens a mail window with nothing to send to.`,
      evidence: [url(entry.url), ...hits.slice(0, EVIDENCE_LIMIT).map((link) => html(`<a href="${link.href}">`))],
      fix: 'Write the full address, including its domain.',
    }))
  },
})

export const telInvalid = define({
  id: 'links.tel-invalid',
  severity: 'medium',
  title: 'A tel: link is not a phone number',
  catches: 'tel: carrying words or too few digits, so tapping it on a phone dials nothing.',
  run(ctx) {
    return perPage(ctx, telInvalid, (entry) => entry.page.links.filter((link) => {
      if (link.scheme !== 'tel' || link.href === null) return false
      const value = safeDecode(link.href.slice('tel:'.length)).split(/[;,]/)[0].replace(TEL_STRIP, '')
      const digits = value.startsWith('+') ? value.slice(1) : value
      return !/^\d{7,15}$/.test(digits)
    }), (hits, entry) => ({
      detail: `${hits.length} tel: link${hits.length === 1 ? '' : 's'} on this page do${hits.length === 1 ? 'es' : ''} not hold a dialable number. On a phone the tap does nothing.`,
      evidence: [url(entry.url), ...hits.slice(0, EVIDENCE_LIMIT).map((link) => html(`<a href="${link.href}">`))],
      fix: 'Write the number in the href in full international form, e.g. tel:+15551234567.',
    }))
  },
})

export const emptyAnchor = define({
  id: 'links.empty-anchor',
  severity: 'low',
  title: 'A link has no text and no accessible name',
  catches: 'An icon or wrapper link with no text, no image alt and no aria-label — unreadable to a screen reader.',
  run(ctx) {
    return perPage(ctx, emptyAnchor, (entry) => entry.page.links.filter((link) => label(link).trim() === ''), (hits, entry) => ({
      detail: `${hits.length} link${hits.length === 1 ? '' : 's'} on this page ha${hits.length === 1 ? 's' : 've'} nothing to announce: no text, no image alt, no aria-label. A screen reader reads out the url instead.`,
      evidence: [url(entry.url), ...hits.slice(0, EVIDENCE_LIMIT).map((link) => html(`<a href="${link.href}"></a>`))],
      fix: 'Give the link visible text, or an aria-label, or an image with alt text inside it.',
    }))
  },
})

export const hashHref = define({
  id: 'links.hash-href',
  severity: 'low',
  title: 'A link points at nothing but "#"',
  catches: 'href="#", a placeholder that jumps to the top of the page instead of going anywhere.',
  run(ctx) {
    return perPage(ctx, hashHref, (entry) => entry.page.links.filter((link) => link.href !== null && link.href.endsWith('#')), (hits, entry) => ({
      detail: `${hits.length} link${hits.length === 1 ? '' : 's'} on this page point${hits.length === 1 ? 's' : ''} at "#". A visitor who clicks one is thrown back to the top of the page, which is not what the label promised.`,
      evidence: [url(entry.url), ...hits.slice(0, EVIDENCE_LIMIT).map((link) => html(`<a href="#">${label(link) || '(no text)'}</a>`))],
      fix: 'Point each one at its real destination, or make it a <button> if it only runs script.',
    }))
  },
})

export const javascriptHref = define({
  id: 'links.javascript-href',
  severity: 'medium',
  title: 'A link runs script instead of going somewhere',
  catches: 'href="javascript:…", which is dead without JavaScript and is not a link to anything.',
  run(ctx) {
    return perPage(ctx, javascriptHref, (entry) => entry.page.links.filter((link) => link.scheme === 'javascript'), (hits, entry) => ({
      detail: `${hits.length} link${hits.length === 1 ? '' : 's'} on this page use${hits.length === 1 ? 's' : ''} a javascript: href. It has no destination to open in a new tab, to bookmark or to crawl, and it does nothing at all if the script fails to load.`,
      evidence: [url(entry.url), ...hits.slice(0, EVIDENCE_LIMIT).map((link) => html(`<a href="${link.href}">${label(link) || '(no text)'}</a>`))],
      fix: 'Use a <button> for an action, and a real href for a destination.',
    }))
  },
})

export const sameTextDifferentTarget = define({
  id: 'links.same-text-different-target',
  severity: 'info',
  title: 'One link label is used for two different destinations',
  catches: 'Two links reading the same thing and going to different places, which a screen-reader link list cannot tell apart.',
  run(ctx) {
    const groups = new Map()
    for (const entry of htmlPages(ctx)) {
      const self = normalizeUrl(baseOf(entry), baseOf(entry))
      for (const link of webLinks(entry)) {
        const key = normalizedText(link)
        if (key === '') continue
        const target = normalizeUrl(link.href, baseOf(entry))
        // A fragment link into the page it sits on is the same link on every page that carries it.
        if (target === null || target === self) continue
        if (!groups.has(key)) groups.set(key, { label: label(link), targets: new Map() })
        const group = groups.get(key)
        if (!group.targets.has(target)) group.targets.set(target, entry.url)
      }
    }
    const out = []
    for (const group of groups.values()) {
      if (group.targets.size < 2) continue
      const targets = [...group.targets.entries()]
      out.push(emit(sameTextDifferentTarget, {
        page: targets[0][1],
        detail: `"${group.label}" is used as the label for ${targets.size} different destinations. Anyone reading the links out of context — a screen reader's link list, a search engine — sees the same promise leading to different places.`,
        evidence: [text(`link text: ${group.label}`), ...targets.slice(0, EVIDENCE_LIMIT).map(([target, page]) => text(`${target} (on ${page})`))],
        fix: 'Give each link a label describing its own destination.',
      }))
    }
    return out
  },
})

export const genericAnchorText = define({
  id: 'links.generic-anchor-text',
  severity: 'info',
  title: 'A link is labelled "click here"',
  catches: 'Anchor text that describes clicking rather than the destination.',
  run(ctx) {
    return perPage(ctx, genericAnchorText, (entry) => webLinks(entry).filter((link) => GENERIC_TEXT.has(normalizedText(link))), (hits, entry) => ({
      detail: `${hits.length} link${hits.length === 1 ? '' : 's'} on this page are labelled with the act of clicking rather than with where they go. Read out of context the label says nothing, and search engines treat anchor text as the description of the target.`,
      evidence: [url(entry.url), ...hits.slice(0, EVIDENCE_LIMIT).map((link) => html(`<a href="${link.href}">${label(link)}</a>`))],
      fix: 'Label each link with its destination — "our pricing", not "click here".',
    }))
  },
})

export const skipLinkMissing = define({
  id: 'links.skip-link-missing',
  severity: 'low',
  title: 'Pages have no skip link',
  catches: 'No "skip to content" link, so a keyboard user tabs through the whole navigation on every page.',
  run(ctx) {
    // One finding for the site: a skip link belongs to the layout, and listing every page that
    // shares that layout would bury the point under its own repetition.
    const missing = htmlPages(ctx).filter((entry) => entry.page.skipLink !== true).map((entry) => entry.url)
    if (missing.length === 0) return []
    return [emit(skipLinkMissing, {
      page: missing[0],
      detail: `${missing.length} page${missing.length === 1 ? '' : 's'} offer no way to jump past the navigation. A keyboard or screen-reader user tabs through every menu item before reaching the content, on every page.`,
      evidence: [metric(`${missing.length} pages without a skip link`), ...missing.slice(0, EVIDENCE_LIMIT).map(url)],
      fix: 'Add a first-in-the-body link to #main — visually hidden until it takes focus — and give the main content that id.',
    })]
  },
})

export const checks = [
  internalBroken,
  externalBroken,
  externalUnverifiable,
  toDevHost,
  toHttpOnHttps,
  toRedirectingInternal,
  noopenerMissing,
  mailtoInvalid,
  telInvalid,
  emptyAnchor,
  hashHref,
  javascriptHref,
  sameTextDifferentTarget,
  genericAnchorText,
  skipLinkMissing,
]
