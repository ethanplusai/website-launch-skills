// Accessibility, as far as HTML alone can answer it.
//
// Pure over the audit context: every page the crawl parsed is already a `Page`, and nothing here
// fetches. This is the http tier, which means it sees markup and nothing else — no computed
// styles, no contrast, no focus order as rendered, no live region behaviour, no keyboard traps.
// Everything it does report is a fact about the source that no rendering can talk it out of: a
// control with no accessible name has no accessible name however the page looks.
//
// That gap is the reason `a11y.browser-tier-required` exists. It is not a finding about the site;
// it is a finding about the audit, and it ships on every run where the browser tier did not, so a
// clean accessibility section can never be read as "this site is accessible".
//
// The document language lives in the head dimension (`head.lang-missing`) and is deliberately not
// re-reported here: one fact, one finding, one place to fix it.
//
// Shape of the findings:
//
// - A property of one page's markup — a skipped heading level, an unlabelled control, an untitled
//   frame — is one finding per page, listing everything at fault on it.
// - A missing `<main>` is a property of the layout rather than of any one page's content, so the
//   pages that lack one are listed in a single finding, the way links.mjs lists the pages with no
//   skip link. A template fixed once fixes all of them.
// - Alt coverage is a number about the site, reported once. The pages that are actually missing an
//   alt are `images.alt-missing`'s business; this is the headline figure, so a reader can tell
//   "two images on one page" from "nothing on this site is described".

import { defineCheck } from '../registry.mjs'

const PHASE = 'launch-audit'
const DIMENSION = 'a11y'
const TIER = 'http'
const EVIDENCE_LIMIT = 10

const url = (value) => ({ type: 'url', value })
const html = (value) => ({ type: 'html', value })
const text = (value) => ({ type: 'text', value })
const metric = (value) => ({ type: 'metric', value })

const define = (def) => defineCheck({ phase: PHASE, dimension: DIMENSION, tier: TIER, ...def })
const emit = (check, overrides) => check.mk({ title: check.title, ...overrides })

const htmlPages = (ctx) => ctx.crawl.pages.filter((p) => p.page !== null && p.status >= 200 && p.status < 300)
const plural = (n, one, many) => (n === 1 ? one : many)
const blank = (value) => value === null || value === undefined || String(value).trim() === ''

// One finding per page, built from whatever that page's own markup turned up.
function perPage(ctx, check, select, describe) {
  const out = []
  for (const entry of htmlPages(ctx)) {
    const hits = select(entry.page, entry)
    if (hits.length === 0) continue
    out.push(emit(check, { page: entry.url, ...describe(hits, entry) }))
  }
  return out
}

// The controls on a page that need an accessible name and do not have one. html.mjs already
// decided which controls need one: a hidden input, a submit button and a control hidden from
// assistive technology all report `needsLabel: false`, so this list is exactly the violations.
function unnamedControls(page) {
  const out = []
  for (const form of page.forms) {
    for (const input of form.inputs) {
      if (input.needsLabel && !input.labelled) out.push({ form, input })
    }
  }
  return out
}

const describeControl = (input) => {
  const parts = [`type=${input.type}`]
  if (input.name !== null) parts.push(`name=${input.name}`)
  if (input.id !== null) parts.push(`id=${input.id}`)
  return parts.join(' ')
}

export const formLabels = define({
  id: 'a11y.form-labels',
  severity: 'high',
  title: 'A form control has no accessible name',
  catches: 'An input, select or textarea with no <label>, aria-label or aria-labelledby — a field a screen reader announces as nothing at all.',
  run(ctx) {
    return perPage(ctx, formLabels, (page) => unnamedControls(page), (hits, entry) => ({
      detail: `${hits.length} form ${plural(hits.length, 'control', 'controls')} on ${entry.url} ${plural(hits.length, 'has', 'have')} no accessible name. A screen reader announces the field as "edit text" and nothing more, so the person filling it in has to guess what it wants. A placeholder is not a name: it disappears the moment they start typing.`,
      evidence: [
        url(entry.url),
        ...hits.slice(0, EVIDENCE_LIMIT).map(({ input }) => html(`<${input.type === 'select' || input.type === 'textarea' ? input.type : 'input'} ${describeControl(input)}> — no label, no aria-label`)),
      ],
      fix: 'Give each control a <label for="its-id">, or an aria-label when no visible label is wanted.',
    }))
  },
})

export const headingOrder = define({
  id: 'a11y.heading-order',
  severity: 'low',
  title: 'A page skips a heading level',
  catches: 'A heading that jumps more than one level below the heading before it — an h1 followed by an h3, say.',
  run(ctx) {
    return perPage(ctx, headingOrder, (page) => {
      const hits = []
      let previous = null
      for (const heading of page.headings) {
        if (previous !== null && heading.level > previous + 1) hits.push({ from: previous, to: heading.level, text: heading.text })
        previous = heading.level
      }
      return hits
    }, (hits, entry) => ({
      detail: `${entry.url} skips ${plural(hits.length, 'a heading level', 'heading levels')}: ${hits.map((hit) => `h${hit.from} straight to h${hit.to}`).join(', ')}. Headings are how a screen-reader user skims a page, and a gap in the sequence reads as a missing section rather than a styling choice.`,
      evidence: [
        url(entry.url),
        ...hits.slice(0, EVIDENCE_LIMIT).map((hit) => html(`h${hit.from} → h${hit.to}${hit.text === '' ? '' : ` ("${hit.text}")`}`)),
      ],
      fix: 'Use the level the outline calls for and style it to look how you want, rather than picking the level by size.',
    }))
  },
})

export const linkTextEmpty = define({
  id: 'a11y.link-text-empty',
  severity: 'medium',
  title: 'A link announces nothing at all',
  catches: 'An anchor with no text, no image alt and no aria-label — a link a screen reader can only read out as its url.',
  run(ctx) {
    return perPage(ctx, linkTextEmpty, (page) => page.links.filter(
      (link) => blank(link.text) && blank(link.ariaLabel),
    ), (hits, entry) => ({
      detail: `${hits.length} ${plural(hits.length, 'link', 'links')} on ${entry.url} ${plural(hits.length, 'has', 'have')} nothing to announce — no text, no image description, no aria-label. In a screen reader's list of links they appear as the url, or as nothing.`,
      evidence: [
        url(entry.url),
        ...hits.slice(0, EVIDENCE_LIMIT).map((link) => html(`<a href="${link.href ?? ''}"></a>`)),
      ],
      fix: 'Put text in the link, give the image inside it an alt, or add an aria-label saying where it goes.',
    }))
  },
})

export const tabindexPositive = define({
  id: 'a11y.tabindex-positive',
  severity: 'low',
  title: 'A page overrides the tab order with a positive tabindex',
  catches: 'tabindex="1" or higher, which pulls an element out of the document order and in front of everything else.',
  run(ctx) {
    return perPage(ctx, tabindexPositive, (page) => (page.tabindexPositive > 0 ? [page.tabindexPositive] : []), (hits, entry) => ({
      detail: `${entry.url} carries ${hits[0]} ${plural(hits[0], 'element', 'elements')} with a positive tabindex. Those jump to the front of the tab order regardless of where they sit on the page, so keyboard users land somewhere unexpected and then tab back through everything they already passed.`,
      evidence: [url(entry.url), metric(`${hits[0]} element${plural(hits[0], '', 's')} with tabindex greater than 0`)],
      fix: 'Use tabindex="0" to make something focusable and let the document order do the rest.',
    }))
  },
})

export const autofocus = define({
  id: 'a11y.autofocus',
  severity: 'low',
  title: 'A page takes focus away on load',
  catches: 'An autofocus attribute, which moves the cursor before the visitor has read anything.',
  run(ctx) {
    return perPage(ctx, autofocus, (page) => (page.autofocus > 0 ? [page.autofocus] : []), (hits, entry) => ({
      detail: `${entry.url} autofocuses ${hits[0]} ${plural(hits[0], 'element', 'elements')}. A screen reader starts reading from wherever focus lands, so the visitor misses the heading, the navigation and the first paragraph; on a phone the keyboard opens over the page before anybody asked for it.`,
      evidence: [url(entry.url), metric(`${hits[0]} element${plural(hits[0], '', 's')} with autofocus`)],
      fix: 'Drop the attribute, unless the page exists to be typed into and nothing else (a search page, a login form).',
    }))
  },
})

export const mainLandmarkMissing = define({
  id: 'a11y.main-landmark-missing',
  severity: 'medium',
  title: 'Pages with no main region',
  catches: 'A page with no <main> and no role="main" — nothing for "skip to content" to skip to.',
  run(ctx) {
    const all = htmlPages(ctx)
    const pages = all.filter((entry) => entry.page.hasMain === false)
    if (pages.length === 0) return []
    return [emit(mainLandmarkMissing, {
      page: pages[0].url,
      detail: `${pages.length} ${plural(pages.length, 'page has', 'pages have')} no <main> region. Screen-reader users navigate by landmark before they navigate by anything else, and without one they have to tab through the header and the navigation on every page to reach the content.`,
      evidence: [
        metric(`${pages.length} of ${all.length} crawled pages have no main landmark`),
        ...pages.slice(0, EVIDENCE_LIMIT).map((entry) => url(entry.url)),
      ],
      fix: 'Wrap the page content in <main> in the layout template. It is one element, and it fixes every page at once.',
    })]
  },
})

export const iframeTitleMissing = define({
  id: 'a11y.iframe-title-missing',
  severity: 'medium',
  title: 'An embedded frame has no title',
  catches: 'An <iframe> with no title attribute — a map, a video or a form a screen reader can only announce as "frame".',
  run(ctx) {
    return perPage(ctx, iframeTitleMissing, (page) => page.iframes.filter((frame) => blank(frame.title)), (hits, entry) => ({
      detail: `${hits.length} ${plural(hits.length, 'frame', 'frames')} on ${entry.url} ${plural(hits.length, 'has', 'have')} no title. A screen reader announces an untitled frame as "frame", so the visitor has to enter it to find out whether it is the map, the booking form or an advert.`,
      evidence: [
        url(entry.url),
        ...hits.slice(0, EVIDENCE_LIMIT).map((frame) => html(`<iframe src="${frame.src ?? ''}"> — no title`)),
      ],
      fix: 'Add title="…" saying what the frame contains ("Map of the shop", "Booking form").',
    }))
  },
})

export const imageAltCoverage = define({
  id: 'a11y.image-alt-coverage',
  severity: 'info',
  title: 'How much of this site is described for screen readers',
  catches: 'The share of images across the crawled pages that carry an alt attribute at all.',
  run(ctx) {
    const pages = htmlPages(ctx)
    let total = 0
    let described = 0
    for (const entry of pages) {
      for (const image of entry.page.images) {
        total++
        if (image.alt !== null) described++
      }
    }
    if (total === 0) return []
    const percent = Math.round((described / total) * 100)
    const missing = total - described
    return [emit(imageAltCoverage, {
      detail: `${described} of ${total} images across ${pages.length} crawled pages carry an alt attribute — ${percent}%. ${missing === 0 ? 'Every image is described or deliberately marked decorative; whether the descriptions are any good is a judgement no tool makes.' : `${missing} ${plural(missing, 'image is', 'images are')} announced as a filename, or skipped entirely.`}`,
      evidence: [
        metric(`${percent}% alt coverage (${described} of ${total} images)`),
        text(missing === 0 ? 'no image is missing an alt attribute' : `${missing} image${plural(missing, '', 's')} with no alt attribute — see images.alt-missing for which`),
      ],
      fix: missing === 0
        ? 'Nothing to fix. Read a handful of the alt texts aloud and check each says what the picture is for.'
        : 'Describe each image, or give it alt="" when it is purely decorative.',
    })]
  },
})

export const browserTierRequired = define({
  id: 'a11y.browser-tier-required',
  severity: 'info',
  title: 'The accessibility audit is only as deep as HTML goes',
  catches: 'The gap this tier cannot cover: colour contrast, focus order as rendered, keyboard traps and everything axe would have found in a real browser.',
  run(ctx) {
    if (ctx.browser?.available === true) return []
    const reason = ctx.browser?.reason ?? 'no browser adapter was supplied to this run'
    return [emit(browserTierRequired, {
      detail: `The axe accessibility scan did not run: ${reason}. Everything above is what HTML alone can prove. Colour contrast, focus order as the page actually renders, keyboard traps, ARIA that lies about state, and anything a script builds after load are all unchecked — so a clean section here does not mean the site is accessible.`,
      evidence: [text(`browser tier not run: ${reason}`), text('unchecked: colour contrast, rendered focus order, keyboard traps, live regions, script-built content')],
      fix: 'Run the audit again with the browser tier available, and test the main journeys with a keyboard and a screen reader.',
    })]
  },
})

export const checks = [
  formLabels,
  headingOrder,
  linkTextEmpty,
  tabindexPositive,
  autofocus,
  mainLandmarkMissing,
  iframeTitleMissing,
  imageAltCoverage,
  browserTierRequired,
]
