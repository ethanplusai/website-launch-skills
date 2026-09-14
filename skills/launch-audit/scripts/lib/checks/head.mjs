// Head and metadata: does every page say what it is, to a search engine, a social network and a
// browser?
//
// Pure over the audit context, like every check module. The crawl has already parsed each page's
// head, and _ctx.mjs has already fetched every icon, manifest and og:image the crawl saw into
// `probes.headAssets`, so nothing here fetches — an og:image is measured from the bytes that
// probe brought back, through image-dims.mjs, rather than by asking the network again.
//
// Three habits are worth knowing before reading the checks:
//
// - Site-wide facts are reported site-wide. A title used on two pages is one finding naming both
//   pages, not two findings each pointing at the other; the same goes for descriptions and for
//   the structured-data summary, which groups pages by the set of types they ship (a template,
//   effectively) so a 200-page blog does not produce 200 info findings.
// - Everything else is one finding per offending page, citing the tag or the value that proves
//   it. A page the crawl could not parse (`page: null`) is skipped everywhere.
// - An asset the context has no response for is unknown, not broken. `probes.headAssets` is
//   capped, and a check that cannot see a response says nothing rather than guessing.
//
// `head.twitter-card-missing` is the one check whose severity moves: without a Twitter card and
// without Open Graph a shared link has no card at all (low), while a page that already has Open
// Graph gets a card anyway, so the missing tag is only a lost choice of layout (info).

import { defineCheck } from '../registry.mjs'
import { imageDimensions } from '../image-dims.mjs'
import { checkJsonLd } from '../schema/required.mjs'

const PHASE = 'launch-audit'
const DIMENSION = 'head'
const TIER = 'http'

const TITLE_MIN = 10
const TITLE_MAX = 60
const DESCRIPTION_MIN = 50
const DESCRIPTION_MAX = 160
const OG_IMAGE_MIN_WIDTH = 1200
const OG_IMAGE_MIN_HEIGHT = 630
const EVIDENCE_LIMIT = 10

// The titles a framework ships in its starter template. An empty title is title-missing rather
// than one of these; `Home` and `Untitled` are here because a CMS writes them when nobody chose.
// `Home` is deliberately absent: it is a plausible title for a real home page, and a high finding
// on it would be a false positive more often than a catch.
const FRAMEWORK_TITLES = new Set([
  'astro', 'vite app', 'vite + react', 'vite + vue', 'vite + svelte', 'react app', 'document',
  'create next app', 'nuxt', 'sveltekit app', 'welcome to gatsby', 'site title', 'untitled',
])

const OG_REQUIRED = ['og:title', 'og:description', 'og:image', 'og:url', 'og:type']

// Properties a page is meant to repeat: several card images, several alternate locales, several
// article tags. Everything else in the head is a single value, and a second one is dead markup.
const REPEATABLE_META = new Set(['og:image', 'og:locale:alternate', 'article:tag'])
const REPEATABLE_PREFIX = 'og:image:'

const url = (value) => ({ type: 'url', value })
const status = (value) => ({ type: 'status', value })
const header = (value) => ({ type: 'header', value })
const html = (value) => ({ type: 'html', value })
const text = (value) => ({ type: 'text', value })
const metric = (value) => ({ type: 'metric', value })

const define = (def) => defineCheck({ phase: PHASE, dimension: DIMENSION, tier: TIER, ...def })
// mk() prebinds id/phase/dimension/severity/tier but not the title; twitter-card-missing is the
// only finding here that overrides anything beyond it.
const emit = (check, overrides) => check.mk({ title: check.title, ...overrides })

const htmlPages = (ctx) => ctx.crawl.pages.filter((p) => p.page !== null && p.status >= 200 && p.status < 300)

const trimmed = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
const titleOf = (entry) => trimmed(entry.page.head.title)
const metaOf = (entry, name) => trimmed(entry.page.head.metaByName.get(name))
const ogOf = (entry, property) => trimmed(entry.page.head.metaByProperty.get(property))
const hasAnyOg = (entry) => [...entry.page.head.metaByProperty.keys()].some((key) => key.startsWith('og:'))
const rels = (link) => (link.rel === null ? [] : link.rel.split(/\s+/))
// Substring, for "is any icon of any kind declared here" — `apple-touch-icon` and `mask-icon` both
// count, because a broken one of those is still a broken icon.
const linksMatching = (entry, needle) => entry.page.head.links.filter((link) => rels(link).some((rel) => rel.includes(needle)))
// Exact token, for "is the favicon itself declared" — `rel="shortcut icon"` is the favicon and
// `rel="apple-touch-icon"` is not, so only a whole-token match can answer that.
const linksWithRel = (entry, wanted) => entry.page.head.links.filter((link) => rels(link).includes(wanted))
const contentTypeOf = (response) => String(response?.headers?.['content-type'] ?? '').toLowerCase()

// One finding per group of pages that share a value, rather than one per page: the defect is the
// sharing, and naming every page once is what an author needs to fix it.
function sharedValues(entries, valueOf) {
  const groups = new Map()
  for (const entry of entries) {
    const value = valueOf(entry)
    if (value === null) continue
    // Collapsed, because two descriptions differing only by a stray double space are the same
    // description to a reader and to a search engine. html.mjs already collapses a <title> this
    // way; meta content it leaves verbatim, so the normalisation has to happen here.
    const key = value.toLowerCase().replace(/\s+/g, ' ')
    if (!groups.has(key)) groups.set(key, { value, pages: [] })
    groups.get(key).pages.push(entry.url)
  }
  return [...groups.values()].filter((group) => group.pages.length > 1)
}

// The bytes of a response, whichever way net recorded them: an image arrives as bodyBytes, and a
// text/* body (an SVG served as text/plain, say) arrives as a string that still has to be measured.
function bytesOf(response) {
  if (response?.bodyBytes instanceof Uint8Array && response.bodyBytes.length > 0) return response.bodyBytes
  if (typeof response?.body === 'string' && response.body !== '') return new TextEncoder().encode(response.body)
  return null
}

// The og:image url and whatever the context fetched for it. `null` when the page declares none,
// or when the url is not one the head-asset probe covered.
function ogImage(ctx, entry) {
  const src = ogOf(entry, 'og:image')
  if (src === null) return null
  const response = ctx.probes.headAssets.get(src)
  return response === undefined ? null : { src, response }
}

const ok200 = (response) => response?.status === 200

// Every typed node on a page, with the block it came from, for the structured-data checks.
function jsonldNodes(entry) {
  const out = []
  for (const block of entry.page.jsonld) {
    if (block.error !== null || block.parsed === null) continue
    for (const node of checkJsonLd(block.parsed)) out.push(node)
  }
  return out
}

export const titleMissing = define({
  id: 'head.title-missing',
  severity: 'high',
  title: 'A page has no title',
  catches: 'A page shipped without a <title>, which search results and browser tabs fall back to the url for.',
  run(ctx) {
    return htmlPages(ctx).filter((entry) => titleOf(entry) === null).map((entry) => emit(titleMissing, {
      page: entry.url,
      detail: 'This page has no <title>. Search results show the url instead, the browser tab is unlabelled, and a bookmark saves nothing readable.',
      evidence: [url(entry.url), html('<title> absent or empty')],
      fix: 'Give the page a unique title that says what the page is.',
    }))
  },
})

export const titleDuplicate = define({
  id: 'head.title-duplicate',
  severity: 'high',
  title: 'Several pages share one title',
  catches: 'A template that writes the same <title> onto every page it renders.',
  run(ctx) {
    return sharedValues(htmlPages(ctx), titleOf).map((group) => emit(titleDuplicate, {
      page: group.pages[0],
      detail: `${group.pages.length} pages carry the title "${group.value}". A search engine cannot tell them apart, and neither can anyone reading a list of results or open tabs.`,
      evidence: [text(`shared title: ${group.value}`), ...group.pages.slice(0, EVIDENCE_LIMIT).map(url)],
      fix: 'Give each page a title describing that page, not the site.',
    }))
  },
})

export const titleLength = define({
  id: 'head.title-length',
  severity: 'low',
  title: 'A title is too short or too long',
  catches: 'A title under ten characters or past the sixty a search result shows.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      const title = titleOf(entry)
      if (title === null) continue
      const length = title.length
      if (length >= TITLE_MIN && length <= TITLE_MAX) continue
      const short = length < TITLE_MIN
      out.push(emit(titleLength, {
        page: entry.url,
        detail: short
          ? `The title is ${length} characters, too short to say what the page is or to carry a search term anyone types.`
          : `The title is ${length} characters. A search result shows roughly ${TITLE_MAX}, so the rest is cut off.`,
        evidence: [url(entry.url), html(`<title>${title}</title>`), metric(`${length} characters`)],
        fix: `Write a title between ${TITLE_MIN} and ${TITLE_MAX} characters, with the distinctive part first.`,
      }))
    }
    return out
  },
})

export const titleFrameworkDefault = define({
  id: 'head.title-framework-default',
  severity: 'high',
  title: 'A title is still the framework default',
  catches: 'A starter-template title ("Astro", "Create Next App", "Document") that shipped to production.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      const title = titleOf(entry)
      if (title === null || !FRAMEWORK_TITLES.has(title.toLowerCase())) continue
      out.push(emit(titleFrameworkDefault, {
        page: entry.url,
        detail: `The title is "${title}", the value a starter template ships with. It tells a visitor nothing and tells a search engine the page was never finished.`,
        evidence: [url(entry.url), html(`<title>${title}</title>`)],
        fix: 'Replace it with a title describing this page.',
      }))
    }
    return out
  },
})

export const descriptionMissing = define({
  id: 'head.description-missing',
  severity: 'medium',
  title: 'A page has no meta description',
  catches: 'A page with no description, leaving the search snippet to whatever text the crawler picks.',
  run(ctx) {
    return htmlPages(ctx).filter((entry) => metaOf(entry, 'description') === null).map((entry) => emit(descriptionMissing, {
      page: entry.url,
      detail: 'This page has no meta description, so the snippet under it in search results is assembled from whatever body text the crawler thinks fits.',
      evidence: [url(entry.url), html('<meta name="description"> absent or empty')],
      fix: 'Write a description of this page in one or two sentences.',
    }))
  },
})

export const descriptionDuplicate = define({
  id: 'head.description-duplicate',
  severity: 'medium',
  title: 'Several pages share one description',
  catches: 'One description copied across pages, usually the site tagline.',
  run(ctx) {
    return sharedValues(htmlPages(ctx), (entry) => metaOf(entry, 'description')).map((group) => emit(descriptionDuplicate, {
      page: group.pages[0],
      detail: `${group.pages.length} pages carry the same meta description, so every one of them offers the same snippet and none of them describes itself.`,
      evidence: [text(`shared description: ${group.value}`), ...group.pages.slice(0, EVIDENCE_LIMIT).map(url)],
      fix: 'Write a description per page, about that page.',
    }))
  },
})

export const descriptionLength = define({
  id: 'head.description-length',
  severity: 'low',
  title: 'A description is too short or too long',
  catches: 'A description under fifty characters or past the hundred and sixty a snippet shows.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      const description = metaOf(entry, 'description')
      if (description === null) continue
      const length = description.length
      if (length >= DESCRIPTION_MIN && length <= DESCRIPTION_MAX) continue
      const short = length < DESCRIPTION_MIN
      out.push(emit(descriptionLength, {
        page: entry.url,
        detail: short
          ? `The description is ${length} characters — too little for a search engine to prefer it over text it picks itself.`
          : `The description is ${length} characters. A snippet shows roughly ${DESCRIPTION_MAX}, so it is cut off mid-sentence.`,
        evidence: [url(entry.url), html(`<meta name="description" content="${description}">`), metric(`${length} characters`)],
        fix: `Write between ${DESCRIPTION_MIN} and ${DESCRIPTION_MAX} characters, with the point in the first sentence.`,
      }))
    }
    return out
  },
})

export const h1Missing = define({
  id: 'head.h1-missing',
  severity: 'medium',
  title: 'A page has no h1',
  catches: 'A page whose main heading was styled as a div, leaving nothing to announce it.',
  run(ctx) {
    return htmlPages(ctx).filter((entry) => entry.page.h1Count === 0).map((entry) => emit(h1Missing, {
      page: entry.url,
      detail: 'This page has no first-level heading, so a screen reader has nothing to announce as the page topic and a search engine loses its clearest signal of what the page is about.',
      evidence: [url(entry.url), html('no <h1> element')],
      fix: 'Mark the main heading of the page as <h1>.',
    }))
  },
})

export const h1Multiple = define({
  id: 'head.h1-multiple',
  severity: 'low',
  title: 'A page has more than one h1',
  catches: 'A template where both the site name and the page heading are h1.',
  run(ctx) {
    return htmlPages(ctx).filter((entry) => entry.page.h1Count > 1).map((entry) => emit(h1Multiple, {
      page: entry.url,
      detail: `This page has ${entry.page.h1Count} first-level headings, so the document says it is about ${entry.page.h1Count} things at once.`,
      evidence: [
        url(entry.url),
        metric(`${entry.page.h1Count} <h1> elements`),
        ...entry.page.headings.filter((h) => h.level === 1).slice(0, EVIDENCE_LIMIT).map((h) => html(`<h1>${h.text}</h1>`)),
      ],
      fix: 'Keep one <h1> per page and demote the rest to <h2>.',
    }))
  },
})

export const headingSkip = define({
  id: 'head.heading-skip',
  severity: 'low',
  title: 'A heading level is skipped',
  catches: 'An h1 followed by an h3, where the level was chosen for its font size.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      const skips = []
      let previous = null
      for (const heading of entry.page.headings) {
        if (previous !== null && heading.level - previous > 1) skips.push(`h${previous} → h${heading.level}: "${heading.text}"`)
        previous = heading.level
      }
      if (skips.length === 0) continue
      out.push(emit(headingSkip, {
        page: entry.url,
        detail: `This page jumps ${skips.length === 1 ? 'a heading level' : 'heading levels'} rather than stepping down one at a time. Anyone navigating by headings hears a section that appears to belong to a parent that is not there.`,
        evidence: [url(entry.url), ...skips.slice(0, EVIDENCE_LIMIT).map(html)],
        fix: 'Step heading levels down one at a time and set the size with CSS.',
      }))
    }
    return out
  },
})

export const headingEmpty = define({
  id: 'head.heading-empty',
  severity: 'low',
  title: 'A heading has no text',
  catches: 'An empty heading left behind as a spacer or by a CMS field nobody filled in.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      const empty = entry.page.headings.filter((heading) => heading.empty)
      if (empty.length === 0) continue
      out.push(emit(headingEmpty, {
        page: entry.url,
        detail: `This page has ${empty.length} empty heading${empty.length === 1 ? '' : 's'}. A heading list read aloud includes ${empty.length === 1 ? 'a blank entry' : 'blank entries'}, and the document outline gains a section with no name.`,
        evidence: [url(entry.url), ...empty.slice(0, EVIDENCE_LIMIT).map((heading) => html(`<h${heading.level}></h${heading.level}>`))],
        fix: 'Delete the empty heading, or give it the text it was meant to have.',
      }))
    }
    return out
  },
})

export const langMissing = define({
  id: 'head.lang-missing',
  severity: 'medium',
  title: 'The html element declares no language',
  catches: 'A document with no lang attribute, which a screen reader has to guess a voice for.',
  run(ctx) {
    return htmlPages(ctx).filter((entry) => trimmed(entry.page.htmlAttrs.lang) === null).map((entry) => emit(langMissing, {
      page: entry.url,
      detail: 'The <html> element has no lang attribute. A screen reader picks a pronunciation from its own default, and a browser offers to translate a page it cannot identify.',
      evidence: [url(entry.url), html('<html> with no lang attribute')],
      fix: 'Set lang on <html> — lang="en", or whatever the page is written in.',
    }))
  },
})

export const charsetMissing = define({
  id: 'head.charset-missing',
  severity: 'low',
  title: 'The page declares no character encoding',
  catches: 'A document with no charset, where anything but ASCII renders as mojibake.',
  run(ctx) {
    return htmlPages(ctx).filter((entry) => entry.page.head.charset === null).map((entry) => emit(charsetMissing, {
      page: entry.url,
      detail: 'Nothing in the head declares an encoding. A browser falls back to a guess, and every accented character, curly quote and dash is a gamble.',
      evidence: [url(entry.url), html('<meta charset> absent')],
      fix: 'Put <meta charset="utf-8"> first in the head.',
    }))
  },
})

export const viewportMissing = define({
  id: 'head.viewport-missing',
  severity: 'high',
  title: 'The page declares no viewport',
  catches: 'A page with no viewport meta, which a phone renders at desktop width and shrinks.',
  run(ctx) {
    return htmlPages(ctx).filter((entry) => trimmed(entry.page.head.viewport) === null).map((entry) => emit(viewportMissing, {
      page: entry.url,
      detail: 'There is no viewport meta, so a phone lays the page out at desktop width and zooms out to fit. Text arrives too small to read however responsive the CSS is.',
      evidence: [url(entry.url), html('<meta name="viewport"> absent')],
      fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
    }))
  },
})

export const viewportBlocksZoom = define({
  id: 'head.viewport-blocks-zoom',
  severity: 'medium',
  title: 'The viewport stops the page being zoomed',
  catches: 'user-scalable=no or maximum-scale=1, which takes pinch-zoom away from everyone.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      const viewport = trimmed(entry.page.head.viewport)
      if (viewport === null) continue
      const reasons = []
      if (/user-scalable\s*=\s*(no|0)/i.test(viewport)) reasons.push('user-scalable=no')
      const maximum = /maximum-scale\s*=\s*([0-9.]+)/i.exec(viewport)
      if (maximum !== null && Number(maximum[1]) <= 1) reasons.push(`maximum-scale=${maximum[1]}`)
      if (reasons.length === 0) continue
      out.push(emit(viewportBlocksZoom, {
        page: entry.url,
        detail: `The viewport sets ${reasons.join(' and ')}, which stops a visitor zooming in. Anyone who needs larger text — on a phone, in bright sun, or with low vision — cannot get it.`,
        evidence: [url(entry.url), html(`<meta name="viewport" content="${viewport}">`)],
        fix: 'Drop user-scalable and maximum-scale; keep width=device-width, initial-scale=1.',
      }))
    }
    return out
  },
})

export const faviconMissing = define({
  id: 'head.favicon-missing',
  severity: 'medium',
  title: 'The page links no favicon',
  catches: 'A site with no icon, which every tab, bookmark and history entry shows blank.',
  run(ctx) {
    return htmlPages(ctx).filter((entry) => linksWithRel(entry, 'icon').length === 0).map((entry) => emit(faviconMissing, {
      page: entry.url,
      detail: 'No <link rel="icon"> is declared — a touch icon or a mask icon is not one — so the browser falls back to /favicon.ico if it exists and shows a blank page icon if it does not. Tabs, bookmarks and history entries are unidentifiable.',
      evidence: [url(entry.url), html('no <link rel="icon">')],
      fix: 'Link an icon from the head, and ship the file it points at.',
    }))
  },
})

export const faviconBroken = define({
  id: 'head.favicon-broken',
  severity: 'medium',
  title: 'A declared icon does not load',
  catches: 'An icon link pointing at a url that 404s, usually after a path change.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      const broken = []
      for (const link of linksMatching(entry, 'icon')) {
        const response = ctx.probes.headAssets.get(link.href)
        if (response === undefined || ok200(response)) continue
        broken.push(`${link.href} → HTTP ${response.status}${response.error ? ` (${response.error})` : ''}`)
      }
      if (broken.length === 0) continue
      out.push(emit(faviconBroken, {
        page: entry.url,
        detail: `This page links ${broken.length} icon${broken.length === 1 ? '' : 's'} that ${broken.length === 1 ? 'does' : 'do'} not load, so the browser shows a blank icon despite the markup being there.`,
        evidence: [url(entry.url), ...broken.slice(0, EVIDENCE_LIMIT).map(status)],
        fix: 'Point the icon link at a url that serves the file, and check it after every build.',
      }))
    }
    return out
  },
})

export const appleTouchIconMissing = define({
  id: 'head.apple-touch-icon-missing',
  severity: 'low',
  title: 'No apple-touch-icon is declared',
  catches: 'A site saved to an iOS home screen as a screenshot of the page instead of an icon.',
  run(ctx) {
    return htmlPages(ctx).filter((entry) => linksMatching(entry, 'apple-touch-icon').length === 0).map((entry) => emit(appleTouchIconMissing, {
      page: entry.url,
      detail: 'There is no apple-touch-icon, so a visitor who adds this site to an iOS home screen gets a shrunken screenshot of the page rather than an icon.',
      evidence: [url(entry.url), html('no <link rel="apple-touch-icon">')],
      fix: 'Add <link rel="apple-touch-icon" href="/apple-touch-icon.png"> and ship a 180×180 png.',
    }))
  },
})

export const manifestMissing = define({
  id: 'head.manifest-missing',
  severity: 'info',
  title: 'No web app manifest is linked',
  catches: 'A site with no manifest, which cannot be installed and names itself by its title alone.',
  run(ctx) {
    return htmlPages(ctx).filter((entry) => linksMatching(entry, 'manifest').length === 0).map((entry) => emit(manifestMissing, {
      page: entry.url,
      detail: 'No web app manifest is linked. The site cannot be installed to a home screen or launched standalone, and the name and icons it would use there are undeclared.',
      evidence: [url(entry.url), html('no <link rel="manifest">')],
      fix: 'Add a web app manifest with a name, icons and a theme colour, if an installable site is wanted.',
    }))
  },
})

export const themeColorMissing = define({
  id: 'head.theme-color-missing',
  severity: 'info',
  title: 'No theme colour is declared',
  catches: 'A site whose browser chrome stays default grey on mobile.',
  run(ctx) {
    return htmlPages(ctx).filter((entry) => metaOf(entry, 'theme-color') === null).map((entry) => emit(themeColorMissing, {
      page: entry.url,
      detail: 'No theme colour is declared, so mobile browser chrome around the page stays its own default rather than matching the site.',
      evidence: [url(entry.url), html('<meta name="theme-color"> absent')],
      fix: 'Add <meta name="theme-color" content="#..."> matching the site palette.',
    }))
  },
})

export const ogMissing = define({
  id: 'head.og-missing',
  severity: 'medium',
  title: 'An Open Graph property is missing',
  catches: 'A page that produces a bare, untitled link preview when it is shared.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      for (const property of OG_REQUIRED) {
        if (ogOf(entry, property) !== null) continue
        out.push(emit(ogMissing, {
          page: entry.url,
          detail: `This page declares no ${property}. Every social network, chat app and link unfurler reads Open Graph first, so what it shows for this url is whatever it can scrape instead.`,
          evidence: [url(entry.url), html(`<meta property="${property}"> absent`)],
          fix: `Add <meta property="${property}" content="..."> to the head.`,
        }))
      }
    }
    return out
  },
})

export const ogImageBroken = define({
  id: 'head.og-image-broken',
  severity: 'high',
  title: 'The og:image does not load',
  catches: 'A card image url that 404s, which turns every shared link into a text-only preview.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      const image = ogImage(ctx, entry)
      if (image === null || ok200(image.response)) continue
      out.push(emit(ogImageBroken, {
        page: entry.url,
        detail: `The og:image url answers HTTP ${image.response.status}. Every share of this page renders without an image, and a social network caches that result for a long time.`,
        evidence: [
          url(entry.url),
          html(`<meta property="og:image" content="${image.src}">`),
          status(`HTTP ${image.response.status}${image.response.error ? ` (${image.response.error})` : ''}`),
        ],
        fix: 'Point og:image at a url that serves the image, and re-scrape the page once it does.',
      }))
    }
    return out
  },
})

export const ogImageNotRaster = define({
  id: 'head.og-image-not-raster',
  severity: 'medium',
  title: 'The og:image is not a raster image',
  catches: 'An SVG — or something that is not an image at all — used as a social card.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      const image = ogImage(ctx, entry)
      if (image === null || !ok200(image.response)) continue
      const contentType = contentTypeOf(image.response)
      const isSvgType = contentType.includes('image/svg')
      const bytes = bytesOf(image.response)
      if (!isSvgType && bytes === null) continue // nothing to judge; not the same as judging it bad
      const measured = isSvgType ? { type: 'svg' } : imageDimensions(bytes)
      if (measured.type !== 'svg' && measured.type !== 'unknown') continue
      out.push(emit(ogImageNotRaster, {
        page: entry.url,
        detail: measured.type === 'svg'
          ? 'The og:image is an SVG. No major social network renders vector card images, so the preview falls back to no image at all.'
          : 'The bytes at the og:image url are not a PNG, JPEG, GIF or WebP, whatever the url extension and content type say. A social network will not render them.',
        evidence: [
          url(entry.url),
          html(`<meta property="og:image" content="${image.src}">`),
          header(`content-type: ${contentType || '(none)'}`),
          text(`bytes read as: ${measured.type}`),
        ],
        fix: 'Export the card as a PNG or JPEG at 1200×630 and point og:image at that.',
      }))
    }
    return out
  },
})

export const ogImageSmall = define({
  id: 'head.og-image-small',
  severity: 'medium',
  title: 'The og:image is smaller than a card needs',
  catches: 'A card image under 1200×630, which social networks upscale or crop to a thumbnail.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      const image = ogImage(ctx, entry)
      if (image === null || !ok200(image.response)) continue
      const bytes = bytesOf(image.response)
      if (bytes === null) continue
      const measured = imageDimensions(bytes)
      if (measured.type === 'svg' || measured.type === 'unknown') continue // og-image-not-raster's finding
      if (measured.width === null || measured.height === null) continue
      if (measured.width >= OG_IMAGE_MIN_WIDTH && measured.height >= OG_IMAGE_MIN_HEIGHT) continue
      out.push(emit(ogImageSmall, {
        page: entry.url,
        detail: `The og:image is ${measured.width}×${measured.height}, under the ${OG_IMAGE_MIN_WIDTH}×${OG_IMAGE_MIN_HEIGHT} a large card needs. Networks either upscale it into a blur or fall back to a small square thumbnail.`,
        evidence: [
          url(entry.url),
          html(`<meta property="og:image" content="${image.src}">`),
          metric(`${measured.width}×${measured.height} ${measured.type}`),
        ],
        fix: `Export the card at ${OG_IMAGE_MIN_WIDTH}×${OG_IMAGE_MIN_HEIGHT} or larger, keeping the 1.91:1 ratio.`,
      }))
    }
    return out
  },
})

export const ogImageDimensionsMissing = define({
  id: 'head.og-image-dimensions-missing',
  severity: 'low',
  title: 'The og:image declares no dimensions',
  catches: 'A card with no og:image:width/height, so the first share renders before the image is measured.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      if (ogOf(entry, 'og:image') === null) continue
      const missing = ['og:image:width', 'og:image:height'].filter((property) => ogOf(entry, property) === null)
      if (missing.length === 0) continue
      out.push(emit(ogImageDimensionsMissing, {
        page: entry.url,
        detail: `The card image declares no ${missing.join(' or ')}. A network that has not fetched the image yet cannot reserve the right space, so the first share of this url often renders without the card.`,
        evidence: [url(entry.url), ...missing.map((property) => html(`<meta property="${property}"> absent`))],
        fix: 'Declare og:image:width and og:image:height alongside og:image.',
      }))
    }
    return out
  },
})

export const ogUrlMismatch = define({
  id: 'head.og-url-mismatch',
  severity: 'medium',
  title: 'og:url and the canonical disagree',
  catches: 'Two different urls claimed for one page, which splits shares and likes between them.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      const ogUrl = ogOf(entry, 'og:url')
      const canonical = trimmed(entry.page.head.canonical)
      if (ogUrl === null || canonical === null) continue
      let a
      let b
      try {
        a = new URL(ogUrl).href
        b = new URL(canonical).href
      } catch {
        continue
      }
      if (a === b) continue
      out.push(emit(ogUrlMismatch, {
        page: entry.url,
        detail: 'og:url and the canonical link name two different urls for this page. Shares, likes and comment counts accrue to the og:url while search engines index the canonical, so the page is split in two.',
        evidence: [url(entry.url), html(`<meta property="og:url" content="${a}">`), html(`<link rel="canonical" href="${b}">`)],
        fix: 'Set og:url to the canonical url of the page.',
      }))
    }
    return out
  },
})

export const twitterCardMissing = define({
  id: 'head.twitter-card-missing',
  severity: 'low',
  title: 'No twitter:card is declared',
  catches: 'A page that has no card format chosen, so a shared link renders as plain text or a small thumbnail.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      if (metaOf(entry, 'twitter:card') !== null) continue
      const withOg = hasAnyOg(entry)
      out.push(emit(twitterCardMissing, {
        page: entry.url,
        severity: withOg ? 'info' : 'low',
        detail: withOg
          ? 'There is no twitter:card, so the Open Graph tags are used with a default small-image layout. Declaring summary_large_image is what turns the card into a full-width one.'
          : 'There is no twitter:card and no Open Graph either, so a shared link renders as bare text with no title, description or image.',
        evidence: [url(entry.url), html('<meta name="twitter:card"> absent'), text(withOg ? 'Open Graph tags are present' : 'no Open Graph tags either')],
        fix: 'Add <meta name="twitter:card" content="summary_large_image">.',
      }))
    }
    return out
  },
})

export const jsonldInvalid = define({
  id: 'head.jsonld-invalid',
  severity: 'high',
  title: 'A JSON-LD block does not parse',
  catches: 'Structured data with a trailing comma or an unescaped quote, which is discarded whole.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      for (const block of entry.page.jsonld) {
        if (block.error === null) continue
        out.push(emit(jsonldInvalid, {
          page: entry.url,
          detail: `A <script type="application/ld+json"> block on this page is not valid JSON, so every parser discards it entirely: ${block.error}`,
          evidence: [url(entry.url), text(`parse error: ${block.error}`), html(block.raw.slice(0, 200) || '(empty block)')],
          fix: 'Fix the JSON — a trailing comma and an unescaped quote are the usual causes — and validate the block before shipping.',
        }))
      }
    }
    return out
  },
})

export const jsonldMissingRequired = define({
  id: 'head.jsonld-missing-required',
  severity: 'medium',
  title: 'Structured data is missing a required property',
  catches: 'A schema.org node that parses but cannot produce the rich result it was written for.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      for (const node of jsonldNodes(entry)) {
        if (node.missing.length === 0) continue
        out.push(emit(jsonldMissingRequired, {
          page: entry.url,
          detail: `The ${node.type} node on this page is missing ${node.missing.join(', ')}. It parses, so nothing reports an error, but it is ineligible for the rich result it was written for.`,
          evidence: [url(entry.url), text(`${node.type} is missing: ${node.missing.join(', ')}`)],
          fix: `Add ${node.missing.join(' and ')} to the ${node.type} node.`,
        }))
      }
    }
    return out
  },
})

export const jsonldUrlBroken = define({
  id: 'head.jsonld-url-broken',
  severity: 'medium',
  title: 'Structured data points at a url that does not load',
  catches: 'A url, logo or image in JSON-LD that the crawl already found broken.',
  run(ctx) {
    const statusByUrl = new Map(ctx.crawl.pages.map((p) => [p.url, p.status]))
    const out = []
    for (const entry of htmlPages(ctx)) {
      const broken = []
      for (const node of jsonldNodes(entry)) {
        for (const candidate of node.urlsToVerify) {
          // Same-origin and already fetched, or nothing is said: the crawl is the only evidence
          // here, and an off-origin url is not this audit's to judge.
          let origin
          try {
            origin = new URL(candidate).origin
          } catch {
            continue
          }
          if (origin !== ctx.target.origin) continue
          const found = statusByUrl.get(candidate)
          if (found === undefined || found === 200) continue
          broken.push(`${node.type}: ${candidate} → HTTP ${found}`)
        }
      }
      if (broken.length === 0) continue
      out.push(emit(jsonldUrlBroken, {
        page: entry.url,
        detail: `Structured data on this page points at ${broken.length} url${broken.length === 1 ? '' : 's'} the crawl found broken. A validator follows those urls, and a node whose url does not resolve is dropped.`,
        evidence: [url(entry.url), ...[...new Set(broken)].slice(0, EVIDENCE_LIMIT).map(status)],
        fix: 'Point the structured data at urls that load, or remove the properties that cannot.',
      }))
    }
    return out
  },
})

export const jsonldOnNoindex = define({
  id: 'head.jsonld-on-noindex',
  severity: 'low',
  title: 'Structured data sits on a noindexed page',
  catches: 'Markup written for a rich result on a page no search engine will index.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      if (entry.page.jsonld.length === 0) continue
      const robots = entry.page.head.robots
      if (robots === null || !robots.includes('noindex')) continue
      out.push(emit(jsonldOnNoindex, {
        page: entry.url,
        detail: 'This page carries structured data and a noindex robots meta. The markup cannot produce a rich result on a page that is never indexed, so either the noindex or the effort spent on the markup is a mistake.',
        evidence: [url(entry.url), html(`<meta name="robots" content="${robots}">`), text(`${entry.page.jsonld.length} JSON-LD block(s)`)],
        fix: 'Decide which was intended: drop the noindex, or drop the structured data.',
      }))
    }
    return out
  },
})

export const jsonldTypesSummary = define({
  id: 'head.jsonld-types-summary',
  severity: 'info',
  title: 'Structured data types found',
  catches: 'Nothing: this is the inventory of what the site actually declares, grouped by template.',
  run(ctx) {
    // Pages that ship the same set of types are the same template, and a template is what an
    // author edits — so one finding per set, not one per page.
    const groups = new Map()
    for (const entry of htmlPages(ctx)) {
      const types = [...new Set(jsonldNodes(entry).map((node) => node.type))].sort()
      if (types.length === 0) continue
      const key = types.join(', ')
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(entry.url)
    }
    return [...groups.entries()].map(([types, urls]) => emit(jsonldTypesSummary, {
      page: urls[0],
      detail: `${urls.length} page${urls.length === 1 ? '' : 's'} declare${urls.length === 1 ? 's' : ''} ${types}. Confirm this is the structured data the site meant to publish — nothing here is wrong, it is what a validator will read.`,
      evidence: [text(`types: ${types}`), ...urls.slice(0, EVIDENCE_LIMIT).map((pageUrl) => text(`${pageUrl}: ${types}`))],
      fix: 'No action if this matches what the site is. Add the types a rich result would need if it does not.',
    }))
  },
})

export const duplicateId = define({
  id: 'head.duplicate-id',
  severity: 'low',
  title: 'A page repeats an element id',
  catches: 'The same id on two elements, which breaks label targets, anchors and every querySelector.',
  run(ctx) {
    return htmlPages(ctx).filter((entry) => entry.page.duplicateIds.length > 0).map((entry) => emit(duplicateId, {
      page: entry.url,
      detail: `This page uses ${entry.page.duplicateIds.length} id${entry.page.duplicateIds.length === 1 ? '' : 's'} more than once. An in-page anchor, a label's for attribute and getElementById all resolve to the first one, so the rest are unreachable.`,
      evidence: [url(entry.url), ...entry.page.duplicateIds.slice(0, EVIDENCE_LIMIT).map((id) => html(`id="${id}"`))],
      fix: 'Make every id unique, and use a class where the value is only for styling.',
    }))
  },
})

export const metaOutsideHead = define({
  id: 'head.meta-outside-head',
  severity: 'medium',
  title: 'A meta tag sits outside the head',
  catches: 'A description or og tag injected into the body, where nothing reads it.',
  run(ctx) {
    return htmlPages(ctx).filter((entry) => entry.page.metaOutsideHead > 0).map((entry) => emit(metaOutsideHead, {
      page: entry.url,
      detail: `${entry.page.metaOutsideHead} meta tag${entry.page.metaOutsideHead === 1 ? '' : 's'} on this page sit outside the head. Browsers and crawlers only read the head, so whatever those tags declare has no effect at all.`,
      evidence: [url(entry.url), metric(`${entry.page.metaOutsideHead} <meta> outside <head>`)],
      fix: 'Move the tags into the head, and check whatever injects them at runtime.',
    }))
  },
})

export const metaDuplicate = define({
  id: 'head.meta-duplicate',
  severity: 'low',
  title: 'A meta tag is declared twice',
  catches: 'Two descriptions, or two canonical-ish og tags, where only the first is used.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      for (const [key, count] of entry.page.head.metaCounts) {
        if (count < 2) continue
        const attribute = key.startsWith('property:') ? 'property' : 'name'
        const property = key.slice(key.indexOf(':') + 1)
        if (REPEATABLE_META.has(property) || property.startsWith(REPEATABLE_PREFIX)) continue
        const tag = `<meta ${attribute}="${property}">`
        out.push(emit(metaDuplicate, {
          page: entry.url,
          detail: `This page declares ${tag} ${count} times. Only the first is used, so the later ones are dead markup — and a sign that two things are writing the same tag.`,
          evidence: [url(entry.url), html(`${tag} × ${count}`), metric(`${count} occurrences`)],
          fix: 'Declare the tag once, and find whichever template or plugin adds the second.',
        }))
      }
    }
    return out
  },
})

export const checks = [
  titleMissing,
  titleDuplicate,
  titleLength,
  titleFrameworkDefault,
  descriptionMissing,
  descriptionDuplicate,
  descriptionLength,
  h1Missing,
  h1Multiple,
  headingSkip,
  headingEmpty,
  langMissing,
  charsetMissing,
  viewportMissing,
  viewportBlocksZoom,
  faviconMissing,
  faviconBroken,
  appleTouchIconMissing,
  manifestMissing,
  themeColorMissing,
  ogMissing,
  ogImageBroken,
  ogImageNotRaster,
  ogImageSmall,
  ogImageDimensionsMissing,
  ogUrlMismatch,
  twitterCardMissing,
  jsonldInvalid,
  jsonldMissingRequired,
  jsonldUrlBroken,
  jsonldOnNoindex,
  jsonldTypesSummary,
  duplicateId,
  metaOutsideHead,
  metaDuplicate,
]
