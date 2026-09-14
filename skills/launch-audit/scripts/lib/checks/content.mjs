// Content sanity: did anyone read the site before it shipped?
//
// Pure over the audit context, and entirely over text the crawl already extracted — nothing here
// fetches, and nothing here judges writing. Every check is a fact a reader would catch in a minute
// and a build never will: a footer still claiming last year, a sale that ended in August, two
// phone numbers for one business, an entity that reached the page as literal characters.
//
// Where a finding lands says what kind of defect it is:
//
// - Placeholder copy, a stale promotion and a visible entity are page defects: one finding per
//   page, naming what was found and where.
// - A copyright year is a layout defect shared by every page that carries the footer, so it is
//   grouped by the year itself and reported once, listing the pages.
// - The `*-variants` checks are site-wide by nature. "Which of these two numbers do I call" is a
//   question about the site, not about any page, so each is one finding listing every variant with
//   the pages it appears on.
//
// `content.phone-variants` compares normalised digits, not spellings: `(555) 010-1234` and
// `tel:+15550101234` are the same number written twice, and reporting that as an inconsistency
// would make the check useless on every site that formats a number for humans and for phones.

import { defineCheck } from '../registry.mjs'
import { PLACEHOLDER_TEXT, scanText } from '../detect/placeholders.mjs'

const PHASE = 'launch-audit'
const DIMENSION = 'content'
const TIER = 'http'
const EVIDENCE_LIMIT = 10

// © / (c) / "copyright", then a year. `&copy;` is in the alternation on purpose: html.mjs decodes
// only the five entities that change how markup parses and leaves the rest as written, so a footer
// that writes `&copy;` — most of them do — reaches page.text with the entity intact.
const COPYRIGHT_YEAR = /(?:©|&copy;|\(c\)|copyright)\s*(?:by\s+)?(\d{4})/gi
// A promotion with an end date. The year is optional, because most promotions are written without
// one — and a promotion written without a year means this year.
const PROMO = /(through|until|ends|expires|valid (?:through|until))\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/gi
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
// Ten digits in the shapes a business writes them, with an optional country code.
const PHONE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
// A US postal code is only a postal code when a state code sits next to it; five digits on their
// own are a price, a year range or a part number far more often than an address.
const US_STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY'
const POSTAL = new RegExp(`\\b(${US_STATES})[\\s,]+(\\d{5}(?:-\\d{4})?)\\b`, 'g')
// An entity that survived into the rendered text is an entity that was escaped twice. Only an
// entity html.mjs decodes may be listed here: one it leaves alone reaches page.text intact on
// every site that writes it, and would fire on all of them — which is why `&copy;` is absent, and
// why `&apos;` is too. `&apos;` is now decoded, so a visible one would be a real double-escape,
// but it is left out of the alternation deliberately: apostrophes are common enough in copy that
// the check earns more from being quiet here than from the one case it gives up.
const VISIBLE_ENTITY = /&(?:amp|nbsp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);/g

// Spelling pairs where a site using both looks like two writers who never spoke. Each side matches
// the word and its ordinary inflections, and neither side may match a word that merely contains
// the other ("catalogue" is not a "catalog" with a suffix).
const SPELLING_PAIRS = [
  { label: 'color / colour', a: /\bcolors?\b/i, b: /\bcolours?\b/i },
  { label: 'center / centre', a: /\bcenters?\b/i, b: /\bcentres?\b/i },
  { label: 'optimize / optimise', a: /\boptimiz(?:e|es|ed|ing|ation)\b/i, b: /\boptimis(?:e|es|ed|ing|ation)\b/i },
  { label: 'license / licence', a: /\blicens(?:e|es|ed|ing)\b/i, b: /\blicenc(?:e|es|ed|ing)\b/i },
  { label: 'catalog / catalogue', a: /\bcatalogs?\b/i, b: /\bcatalogues?\b/i },
]

const url = (value) => ({ type: 'url', value })
const text = (value) => ({ type: 'text', value })
const metric = (value) => ({ type: 'metric', value })

const define = (def) => defineCheck({ phase: PHASE, dimension: DIMENSION, tier: TIER, ...def })
const emit = (check, overrides) => check.mk({ title: check.title, ...overrides })

const htmlPages = (ctx) => ctx.crawl.pages.filter((p) => p.page !== null && p.status >= 200 && p.status < 300)
const plural = (n, one, many) => (n === 1 ? one : many)
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

const matchesOf = (value, re) => (typeof value === 'string' ? [...value.matchAll(re)] : [])

// A phone number as the digits somebody would actually dial: punctuation dropped, and the US
// country code dropped so that +1 555 010 1234 and (555) 010-1234 are one number.
function normalizePhone(raw) {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1)
  return digits.length === 10 ? digits : null
}

// Collect distinct values across the whole site, remembering every spelling seen and the pages it
// appeared on. The map is keyed by the normalised value, which is what "distinct" means here.
function siteWide(ctx, collect) {
  const found = new Map()
  for (const entry of htmlPages(ctx)) {
    const add = (key, shown) => {
      if (key === null) return
      if (!found.has(key)) found.set(key, { key, shown: new Set(), pages: new Set() })
      const group = found.get(key)
      group.shown.add(shown)
      group.pages.add(entry.url)
    }
    collect(entry, add)
  }
  return [...found.values()]
}

function variantFinding(check, groups, { subject, why, fix, format }) {
  if (groups.length < 2) return []
  const show = format ?? ((group) => [...group.shown].join(' / '))
  return [emit(check, {
    page: [...groups[0].pages][0],
    detail: `This site publishes ${groups.length} different ${subject}. ${why}`,
    evidence: groups.slice(0, EVIDENCE_LIMIT).map((group) => text(
      `${show(group)} — on ${[...group.pages].slice(0, 3).join(', ')}`,
    )),
    fix,
  })]
}

export const placeholderText = define({
  id: 'content.placeholder-text',
  severity: 'high',
  title: 'A page still carries placeholder copy',
  catches: 'Lorem ipsum, "coming soon", a TODO, an unrendered {{ template }} or an [INSERT] left in the copy.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      const sources = [
        { where: 'body text', value: entry.page.text },
        { where: 'title', value: entry.page.head.title },
        { where: 'meta description', value: entry.page.head.metaByName.get('description') ?? null },
      ]
      const hits = []
      for (const source of sources) {
        for (const hit of scanText(source.value, PLACEHOLDER_TEXT)) hits.push({ ...source, match: hit.match })
      }
      if (hits.length === 0) continue
      out.push(emit(placeholderText, {
        page: entry.url,
        detail: `This page still carries copy nobody meant to publish: ${hits.map((hit) => `"${hit.match}" in the ${hit.where}`).join(', ')}. A visitor reads it as a site that is not finished, and a search engine indexes it.`,
        evidence: [url(entry.url), ...hits.slice(0, EVIDENCE_LIMIT).map((hit) => text(`${hit.where}: ${hit.match}`))],
        fix: 'Write the real copy, or take the page down until it exists.',
      }))
    }
    return out
  },
})

export const copyrightYearStale = define({
  id: 'content.copyright-year-stale',
  severity: 'low',
  title: 'The copyright year is out of date',
  catches: 'A footer year hardcoded at build time and never updated — the cheapest signal that a site is abandoned.',
  run(ctx) {
    const currentYear = ctx.now.getUTCFullYear()
    // Grouped by year rather than by page: a footer is one template, and listing forty pages that
    // share it as forty findings would say the same thing forty times.
    const byYear = new Map()
    for (const entry of htmlPages(ctx)) {
      for (const found of matchesOf(entry.page.text, COPYRIGHT_YEAR)) {
        const year = Number(found[1])
        if (!Number.isFinite(year) || year >= currentYear) continue
        if (!byYear.has(year)) byYear.set(year, { year, shown: found[0].trim(), pages: new Set() })
        byYear.get(year).pages.add(entry.url)
      }
    }
    const out = []
    for (const group of byYear.values()) {
      const pages = [...group.pages]
      out.push(emit(copyrightYearStale, {
        page: pages[0],
        detail: `${pages.length} ${plural(pages.length, 'page says', 'pages say')} "${group.shown}", and it is ${currentYear}. Nothing breaks, but it is the first thing a visitor reads as "nobody has touched this site in ${currentYear - group.year} ${plural(currentYear - group.year, 'year', 'years')}".`,
        evidence: [text(group.shown), metric(`${group.year} vs ${currentYear}`), ...pages.slice(0, EVIDENCE_LIMIT).map(url)],
        fix: 'Render the year at request time, or from the build date, rather than typing it into the template.',
      }))
    }
    return out
  },
})

export const pastDatedPromo = define({
  id: 'content.past-dated-promo',
  severity: 'medium',
  title: 'A promotion advertises a date that has passed',
  catches: '"Ends Aug 31" still on the page in September — an offer the site is still making and can no longer honour.',
  run(ctx) {
    const out = []
    const now = ctx.now
    const currentYear = now.getUTCFullYear()
    for (const entry of htmlPages(ctx)) {
      const hits = []
      for (const found of matchesOf(entry.page.text, PROMO)) {
        const month = MONTHS.indexOf(found[2].slice(0, 3).toLowerCase())
        const day = Number(found[3])
        if (month === -1 || !Number.isFinite(day) || day < 1 || day > 31) continue
        // A promotion written without a year means this year, which is the reading that makes a
        // September page still advertising August wrong rather than eleven months early.
        const year = found[4] === undefined ? currentYear : Number(found[4])
        const ends = new Date(Date.UTC(year, month, day, 23, 59, 59))
        if (ends.getTime() >= now.getTime()) continue
        hits.push({ shown: found[0].trim(), ends: ends.toISOString().slice(0, 10) })
      }
      if (hits.length === 0) continue
      out.push(emit(pastDatedPromo, {
        page: entry.url,
        detail: `This page still advertises ${hits.length} ${plural(hits.length, 'offer', 'offers')} that ${plural(hits.length, 'has', 'have')} expired — "${hits[0].shown}" ended on ${hits[0].ends}. A visitor who asks for it has been promised something the site no longer honours.`,
        evidence: [url(entry.url), ...hits.slice(0, EVIDENCE_LIMIT).map((hit) => text(`${hit.shown} (ended ${hit.ends})`))],
        fix: 'Take the offer down, or move the date out.',
      }))
    }
    return out
  },
})

export const phoneVariants = define({
  id: 'content.phone-variants',
  severity: 'medium',
  title: 'The site publishes more than one phone number',
  catches: 'An old number left on one page and the new one on another, so half the calls go nowhere.',
  run(ctx) {
    const groups = siteWide(ctx, (entry, add) => {
      for (const found of matchesOf(entry.page.text, PHONE)) add(normalizePhone(found[0]), found[0].trim())
      for (const link of entry.page.links) {
        if (link.scheme !== 'tel' || link.href === null) continue
        const raw = safeDecode(link.href.slice('tel:'.length))
        add(normalizePhone(raw), raw)
      }
    })
    return variantFinding(phoneVariants, groups, {
      subject: 'phone numbers',
      // The dialable digits first, then every spelling of them, because the digits are what makes
      // two of these the same number and the spellings are what you search the templates for.
      format: (group) => `${group.key} — written as ${[...group.shown].join(' / ')}`,
      why: 'Whichever is the old one, the calls placed to it are enquiries nobody answers — and nothing on the site tells a visitor which to trust.',
      fix: 'Publish one number, from one source, on every page — and dial the others to find out where they go.',
    })
  },
})

export const emailVariants = define({
  id: 'content.email-variants',
  severity: 'info',
  title: 'The site publishes more than one email address',
  catches: 'Several contact addresses across the site, at least one of which nobody monitors.',
  run(ctx) {
    const groups = siteWide(ctx, (entry, add) => {
      for (const found of matchesOf(entry.page.text, EMAIL)) add(found[0].toLowerCase(), found[0])
      for (const link of entry.page.links) {
        if (link.scheme !== 'mailto' || link.href === null) continue
        const address = safeDecode(link.href.slice('mailto:'.length).split('?')[0].split(',')[0]).trim()
        if (address === '' || !address.includes('@')) continue
        add(address.toLowerCase(), address)
      }
    })
    return variantFinding(emailVariants, groups, {
      subject: 'email addresses',
      why: 'Every one of them has to reach somebody, or the enquiries sent to it are lost without a bounce.',
      fix: 'Keep the addresses you actually monitor, and send a test message to each one.',
    })
  },
})

export const addressVariants = define({
  id: 'content.address-variants',
  severity: 'info',
  title: 'The site publishes more than one postal address',
  catches: 'A second address left behind after a move — which search engines read as two businesses.',
  run(ctx) {
    const groups = siteWide(ctx, (entry, add) => {
      for (const found of matchesOf(entry.page.text, POSTAL)) add(found[2].split('-')[0], `${found[1]} ${found[2]}`)
    })
    return variantFinding(addressVariants, groups, {
      subject: 'postal codes',
      why: 'If the business has one location, one of these is the old one; if it has two, each needs its own page and its own listing, or search engines merge them into one confused entry.',
      fix: 'Publish the current address everywhere, and give a genuine second location its own page.',
    })
  },
})

export const brokenEntity = define({
  id: 'content.broken-entity',
  severity: 'low',
  title: 'An HTML entity is visible in the text',
  catches: 'Text escaped twice, so the reader sees "&amp;" or "&nbsp;" where a character should be.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      // page.text is already decoded, so an entity still present here is one that was escaped
      // twice in the source (`&amp;amp;`) and reached the reader as characters.
      const hits = matchesOf(entry.page.text, VISIBLE_ENTITY).map((found) => found[0])
      if (hits.length === 0) continue
      const shown = [...new Set(hits)]
      out.push(emit(brokenEntity, {
        page: entry.url,
        detail: `This page shows ${shown.join(', ')} as literal text. The copy was escaped twice — usually a CMS field run through an escaping step that had already been applied — so the reader sees the markup instead of the character.`,
        evidence: [url(entry.url), ...shown.slice(0, EVIDENCE_LIMIT).map(text)],
        fix: 'Stop escaping the field twice, or write the character itself.',
      }))
    }
    return out
  },
})

export const mixedSpelling = define({
  id: 'content.mixed-spelling',
  severity: 'info',
  title: 'The site uses two spellings of the same word',
  catches: 'American and British spellings of one word across the site — two writers who never agreed.',
  run(ctx) {
    const pages = htmlPages(ctx)
    const out = []
    for (const pair of SPELLING_PAIRS) {
      const sides = [{ re: pair.a, pages: [], word: null }, { re: pair.b, pages: [], word: null }]
      for (const entry of pages) {
        for (const side of sides) {
          const found = side.re.exec(entry.page.text)
          if (found === null) continue
          side.pages.push(entry.url)
          if (side.word === null) side.word = found[0]
        }
      }
      if (sides[0].pages.length === 0 || sides[1].pages.length === 0) continue
      out.push(emit(mixedSpelling, {
        page: sides[0].pages[0],
        detail: `This site writes both "${sides[0].word}" and "${sides[1].word}". Nothing breaks, but a reader notices, and so does anyone searching for one spelling and not the other.`,
        evidence: [
          text(`${pair.label}`),
          ...sides.map((side) => text(`"${side.word}" on ${side.pages.slice(0, 3).join(', ')}`)),
        ],
        fix: 'Pick the spelling your audience uses and apply it everywhere.',
      }))
    }
    return out
  },
})

export const checks = [
  placeholderText,
  copyrightYearStale,
  pastDatedPromo,
  phoneVariants,
  emailVariants,
  addressVariants,
  brokenEntity,
  mixedSpelling,
]
