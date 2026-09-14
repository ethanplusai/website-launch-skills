// What only a real browser can say.
//
// Pure over the audit context, like every other check module — and emphatically so here: nothing
// in this file launches, navigates or screenshots anything. browser.mjs does the rendering, the
// orchestrator puts the results on `ctx.browser`, and these checks read them. That split is what
// makes the browser tier testable with no browser installed, and it is why every check begins by
// asking whether the tier ran at all.
//
// `ctx.browser` is `{ available, reason, renders, axe, lighthouse, sampled }`, where the three maps
// are keyed by the url that was rendered. When `available` is false every check here returns
// nothing: the report's "Not covered" line is the orchestrator's to write, and a browser finding
// invented without a browser would be a lie about where the evidence came from.
//
// The tier is a *sample*, not the whole crawl — rendering every page of a large site is an audit
// nobody runs twice — so a clean section here means "the pages we rendered were clean".
//
// Two findings deliberately cross tiers, because the gap between the tiers is the finding:
//
// - `browser.analytics-not-firing` compares the http tier's markup detection against the requests
//   the page actually made. A tag in the source with no hit at the collector is the one analytics
//   failure the http tier structurally cannot see.
// - `browser.rendered-head-differs` compares the rendered head against the head that was served.
//   A canonical or a robots meta rewritten by script is what a crawler that runs javascript sees,
//   and the difference between the two is what makes an indexing bug reproducible.

import { defineCheck } from '../registry.mjs'
import { detectAnalytics, isCollectorUrl, COOKIE_SETTING_TOOLS } from '../detect/analytics.mjs'

const PHASE = 'launch-audit'
const DIMENSION = 'browser'
const TIER = 'browser'

const CONSOLE_QUOTE_LIMIT = 3
const REQUEST_QUOTE_LIMIT = 5
// Lighthouse's own defaults for a passing score, split by form factor: a phone on a throttled
// connection is held to a lower bar than a desktop, because it is a harder test of the same page.
const DEFAULT_THRESHOLDS = { desktop: 90, mobile: 70 }

// axe's impact scale, mapped onto this report's severities. critical and serious both land on high:
// axe reserves "critical" for content that is unusable and "serious" for content that is a barrier,
// and neither is something to ship.
const IMPACT_SEVERITY = { critical: 'high', serious: 'high', moderate: 'medium', minor: 'low' }

const url = (value) => ({ type: 'url', value })
const status = (value) => ({ type: 'status', value })
const text = (value) => ({ type: 'text', value })
const metric = (value) => ({ type: 'metric', value })
const screenshot = (value) => ({ type: 'screenshot', value })

const define = (def) => defineCheck({ phase: PHASE, dimension: DIMENSION, tier: TIER, ...def })
const emit = (check, overrides) => check.mk({ title: check.title, ...overrides })

const plural = (n, one, many) => (n === 1 ? one : many)

// A console entry can carry an empty message (a bare `console.error()`, or an error object the
// browser could not stringify). Evidence values may not be empty — findings.mjs rejects one — so
// the absence is spelled out rather than dropped: an unnamed error is still an error.
const said = (value) => (typeof value === 'string' && value.trim() !== '' ? value : '(no message)')

// The three result maps are Maps in a real run; an array of pairs or a plain object is accepted
// too, so a hand-built context never has to be a Map to be read correctly.
function entriesOf(mapLike) {
  if (mapLike instanceof Map) return [...mapLike.entries()]
  if (Array.isArray(mapLike)) return mapLike
  if (mapLike !== null && typeof mapLike === 'object') return Object.entries(mapLike)
  return []
}

const ran = (ctx) => ctx.browser?.available === true
const renders = (ctx) => (ran(ctx) ? entriesOf(ctx.browser?.renders) : [])
const axeResults = (ctx) => (ran(ctx) ? entriesOf(ctx.browser?.axe) : [])
const lighthouseResults = (ctx) => (ran(ctx) ? entriesOf(ctx.browser?.lighthouse) : [])

// The crawled page behind a rendered url, matched on either the url asked for or the url it
// landed on, so a render that followed a redirect still finds its http-tier twin.
function httpPage(ctx, renderedUrl, render) {
  const wanted = new Set([renderedUrl, render?.finalUrl].filter((value) => typeof value === 'string' && value !== ''))
  return (ctx.crawl?.pages ?? []).find((entry) => wanted.has(entry.url) || wanted.has(entry.finalUrl)) ?? null
}

const bodyOf = (entry) => (typeof entry?.response?.body === 'string' ? entry.response.body : '')

// The tools the http tier found in this page's markup, deduped by name.
function toolsOn(ctx, renderedUrl, render) {
  const entry = httpPage(ctx, renderedUrl, render)
  if (entry === null) return []
  return [...new Set(detectAnalytics(bodyOf(entry)).map((hit) => hit.name))]
}

export const consoleErrors = define({
  id: 'browser.console-errors',
  severity: 'medium',
  title: 'The page logs javascript errors in the console',
  catches: 'Scripts that throw on load — a broken widget, a missing global, a failed integration — which the html tier cannot see because the markup is fine.',
  run(ctx) {
    const out = []
    for (const [renderedUrl, render] of renders(ctx)) {
      const errors = render?.consoleErrors ?? []
      if (errors.length === 0) continue
      out.push(emit(consoleErrors, {
        page: renderedUrl,
        detail: `${errors.length} javascript ${plural(errors.length, 'error was', 'errors were')} logged while this page loaded. Something on the page is throwing, and whatever that script was meant to do is not happening.`,
        evidence: [
          url(renderedUrl),
          text(`${errors.length} console ${plural(errors.length, 'error', 'errors')}`),
          ...errors.slice(0, CONSOLE_QUOTE_LIMIT).map((error) => text(`${said(error.text)}${error.url ? ` — ${error.url}` : ''}`)),
        ],
        fix: 'Open the page with the console visible, reproduce each error, and fix it at the source rather than suppressing it.',
      }))
    }
    return out
  },
})

export const embedConsoleError = define({
  id: 'browser.embed-console-error',
  severity: 'high',
  title: 'An embedded form or widget is throwing errors',
  catches: 'A third-party form, booking widget or payment embed that loads but does not work — the failure mode that silently loses every enquiry a site receives.',
  run(ctx) {
    const embedUrls = entriesOf(ctx.probes?.embeds).map(([embedUrl]) => embedUrl)
    if (embedUrls.length === 0) return []
    const out = []
    for (const [renderedUrl, render] of renders(ctx)) {
      for (const error of render?.consoleErrors ?? []) {
        const source = typeof error.url === 'string' ? error.url : ''
        const embed = embedUrls.find((embedUrl) => source === embedUrl || source.startsWith(embedUrl))
        if (embed === undefined) continue
        out.push(emit(embedConsoleError, {
          page: renderedUrl,
          detail: `The embedded script at ${embed} threw while this page loaded. An embed that errors is usually an embed that never renders its form — and nobody gets an error page, so the enquiries simply stop.`,
          evidence: [url(renderedUrl), url(embed), text(said(error.text))],
          fix: 'Submit the embedded form yourself on the live site. If it fails, check the embed code, the account it points at, and whether a consent or ad blocker is stopping it loading.',
        }))
      }
    }
    return out
  },
})

export const failedRequests = define({
  id: 'browser.failed-requests',
  severity: 'medium',
  title: 'The page asks for files that do not load',
  catches: 'Broken images, stylesheets and scripts as the browser actually requests them, including the ones built by script that never appear in the markup.',
  run(ctx) {
    const externals = ctx.probes?.externals
    // A request the http tier already could not verify is not new information: it was reported
    // there, as an unverifiable external, and repeating it here would double-count one fact.
    const alreadyUnverifiable = (requestUrl) => {
      const response = typeof externals?.get === 'function' ? externals.get(requestUrl) : undefined
      if (response === undefined) return false
      return response.status === 0 || (response.error !== null && response.error !== undefined)
    }
    const out = []
    for (const [renderedUrl, render] of renders(ctx)) {
      const failures = (render?.failedRequests ?? []).filter((request) => {
        if (isCollectorUrl(request.url)) return false
        if ((request.status === 0 || request.status === null) && alreadyUnverifiable(request.url)) return false
        return true
      })
      if (failures.length === 0) continue
      out.push(emit(failedRequests, {
        page: renderedUrl,
        detail: `${failures.length} ${plural(failures.length, 'request', 'requests')} the browser made while rendering this page did not come back. Each one is a file the page expected and did not get.`,
        evidence: [
          url(renderedUrl),
          ...failures.slice(0, REQUEST_QUOTE_LIMIT).map((request) => status(`${request.status === 0 ? 'no response' : request.status} ${request.method} ${request.url}`)),
        ],
        fix: 'Fix or remove each reference. A file that 404s on every page load is both a visible defect and wasted requests.',
      }))
    }
    return out
  },
})

export const horizontalOverflow = define({
  id: 'browser.horizontal-overflow',
  severity: 'medium',
  title: 'The page scrolls sideways',
  catches: 'A too-wide element — an image, a table, a fixed-width block — that makes the whole page scroll horizontally. On a phone it is the single most common visible layout bug.',
  run(ctx) {
    const out = []
    for (const [renderedUrl, render] of renders(ctx)) {
      for (const [width, overflowed] of Object.entries(render?.horizontalOverflow ?? {})) {
        if (overflowed !== true) continue
        out.push(emit(horizontalOverflow, {
          page: renderedUrl,
          severity: width === 'mobile' ? 'high' : 'medium',
          title: `The page scrolls sideways at ${width} width`,
          detail: `At ${width} width the document is wider than the viewport, so the page scrolls horizontally. ${width === 'mobile' ? 'On a phone this is immediately visible and makes the page feel broken.' : 'Something on the page is wider than the space it has.'}`,
          evidence: [url(renderedUrl), text(`horizontal overflow at ${width} width (documentElement.scrollWidth > window.innerWidth + 2)`), ...(render.screenshots?.[width] ? [screenshot(render.screenshots[width])] : [])],
          fix: 'Find the overflowing element (in devtools, look for the widest child) and constrain it: max-width: 100%, a wrapper with overflow-x: auto for tables, or word-break for long unbroken strings.',
        }))
      }
    }
    return out
  },
})

export const navNotCollapsed = define({
  id: 'browser.nav-not-collapsed',
  severity: 'medium',
  title: 'The mobile navigation does not collapse',
  catches: 'A menu with a burger button whose links are still on screen at phone width — the state a half-finished responsive nav ships in.',
  run(ctx) {
    const out = []
    for (const [renderedUrl, render] of renders(ctx)) {
      if (render?.navCollapsed !== false) continue
      out.push(emit(navNotCollapsed, {
        page: renderedUrl,
        detail: 'At phone width this page has a navigation with a visible toggle control and a visible link list at the same time. Either the toggle does nothing, or the menu it controls was never hidden — both look like a broken header on a phone.',
        evidence: [url(renderedUrl), text('a nav toggle is visible at mobile width while its links are still visible'), ...(render.screenshots?.mobile ? [screenshot(render.screenshots.mobile)] : [])],
        fix: 'Check the mobile menu on a real phone width: the links should be hidden until the toggle is pressed, and the toggle should carry aria-expanded.',
      }))
    }
    return out
  },
})

const HEAD_FIELDS = [
  { field: 'title', http: (head) => head?.title ?? null },
  { field: 'description', http: (head) => head?.metaByName?.get?.('description') ?? null },
  { field: 'canonical', http: (head) => head?.canonical ?? null },
  { field: 'robots', http: (head) => head?.robots ?? null },
]

const normalise = (value) => (value === null || value === undefined ? '' : String(value).trim())

export const renderedHeadDiffers = define({
  id: 'browser.rendered-head-differs',
  severity: 'medium',
  title: 'The head a browser sees is not the head that was served',
  catches: 'A title, description, canonical or robots meta that javascript rewrites after load — so what a crawler that runs scripts indexes is not what the server sent.',
  run(ctx) {
    const out = []
    for (const [renderedUrl, render] of renders(ctx)) {
      const rendered = render?.renderedHead
      if (!rendered) continue
      // A render that captured no head at all captured nothing to compare; that is a failed
      // render, which `error` already says, not a head that changed.
      if (HEAD_FIELDS.every(({ field }) => normalise(rendered[field]) === '')) continue
      const entry = httpPage(ctx, renderedUrl, render)
      if (entry === null || entry.page === null || entry.page === undefined) continue
      const differences = HEAD_FIELDS
        .map(({ field, http }) => ({ field, served: normalise(http(entry.page.head)), rendered: normalise(rendered[field]) }))
        .filter((row) => row.served !== row.rendered)
      if (differences.length === 0) continue
      out.push(emit(renderedHeadDiffers, {
        page: renderedUrl,
        detail: `${differences.length} head ${plural(differences.length, 'field differs', 'fields differ')} between the served html and the rendered page: ${differences.map((row) => row.field).join(', ')}. Whichever one is wrong, two different answers to "what is this page" is a bug in itself.`,
        evidence: [
          url(renderedUrl),
          ...differences.map((row) => text(`${row.field}: served ${row.served === '' ? '(none)' : `"${row.served}"`} → rendered ${row.rendered === '' ? '(none)' : `"${row.rendered}"`}`)),
        ],
        fix: 'Render the head server-side. A canonical or robots value set by script is a value some crawlers will never see.',
      }))
    }
    return out
  },
})

export const analyticsNotFiring = define({
  id: 'browser.analytics-not-firing',
  severity: 'high',
  title: 'The analytics tag is installed but never sends anything',
  catches: 'A measurement snippet that is in the markup and does not fire — a blocked script, a consent gate that never resolves, a misconfigured id — which markup alone can never reveal.',
  run(ctx) {
    const out = []
    for (const [renderedUrl, render] of renders(ctx)) {
      const tools = toolsOn(ctx, renderedUrl, render)
      if (tools.length === 0) continue
      if ((render?.collectorHits ?? []).length > 0) continue
      out.push(emit(analyticsNotFiring, {
        page: renderedUrl,
        detail: `The markup of this page installs ${tools.join(', ')}, but loading it in a browser produced no request to any analytics collector. The tag is present and is not measuring anything — every visit to this page is currently invisible.`,
        evidence: [url(renderedUrl), text(`installed in markup: ${tools.join(', ')}`), text('collector requests observed: none')],
        fix: 'Load the page with the network panel open and filter for the collector. Check the script actually loads, the property id is right, and no consent gate is blocking it before a decision is made.',
      }))
    }
    return out
  },
})

export const consentMissing = define({
  id: 'browser.consent-missing',
  severity: 'info',
  title: 'Cookies are set before anyone is asked',
  catches: 'Analytics cookies written on load with no consent banner in sight — the shape of a GDPR/ePrivacy problem, which is a lawyer question rather than a bug.',
  run(ctx) {
    const out = []
    for (const [renderedUrl, render] of renders(ctx)) {
      const cookieTools = toolsOn(ctx, renderedUrl, render).filter((tool) => COOKIE_SETTING_TOOLS.has(tool))
      if (cookieTools.length === 0) continue
      const cookies = render?.cookiesBeforeInteraction ?? []
      if (cookies.length === 0) continue
      if (render?.consentBannerVisible === true) continue
      out.push(emit(consentMissing, {
        page: renderedUrl,
        detail: `This page installs ${cookieTools.join(', ')} and sets ${cookies.length} ${plural(cookies.length, 'cookie', 'cookies')} on load, with nothing on screen that looks like a consent banner. Whether that is a problem depends on where your visitors are — this is a flag to check, not a verdict.`,
        evidence: [
          url(renderedUrl),
          text(`cookie-setting tools: ${cookieTools.join(', ')}`),
          ...cookies.slice(0, REQUEST_QUOTE_LIMIT).map((cookie) => text(`cookie set before any interaction: ${cookie.name} (${cookie.domain})`)),
          text('no element matching a consent/cookie banner selector was visible'),
        ],
        fix: 'Decide whether this site needs a consent banner for its audience. If it does, hold the cookie-setting tags until consent is given rather than firing them on load.',
      }))
    }
    return out
  },
})

export const axeViolation = define({
  id: 'browser.axe-violation',
  severity: 'medium',
  title: 'axe found an accessibility violation',
  catches: 'Everything the html tier structurally cannot check: colour contrast, computed roles and names, focus handling, ARIA state as rendered.',
  run(ctx) {
    const out = []
    for (const [renderedUrl, result] of axeResults(ctx)) {
      if (result?.available !== true) continue
      for (const violation of result.violations ?? []) {
        const count = violation.nodes ?? 0
        out.push(emit(axeViolation, {
          page: renderedUrl,
          severity: IMPACT_SEVERITY[violation.impact] ?? 'medium',
          title: `axe: ${violation.help ?? violation.id}`,
          detail: `axe reports "${violation.id}" (${violation.impact ?? 'unknown'} impact) on ${count} ${plural(count, 'element', 'elements')} of this page. ${violation.help ?? ''}`.trim(),
          evidence: [
            url(renderedUrl),
            text(`axe rule: ${violation.id} (${violation.impact ?? 'unknown'} impact, ${count} ${plural(count, 'element', 'elements')})`),
            ...(violation.sample ? [text(`first element: ${violation.sample}`)] : []),
            ...(violation.helpUrl ? [url(violation.helpUrl)] : []),
          ],
          fix: violation.helpUrl ? `Follow axe's guidance at ${violation.helpUrl}, then re-run the audit.` : 'Fix the elements axe named, then re-run the audit.',
        }))
      }
    }
    return out
  },
})

const thresholdsFor = (ctx) => ({ ...DEFAULT_THRESHOLDS, ...(ctx.options?.thresholds ?? {}) })

export const lighthouseScore = define({
  id: 'browser.lighthouse-score',
  severity: 'medium',
  title: 'The Lighthouse performance score is below the bar',
  catches: 'A page that is slow as measured rather than as guessed — the number the http tier can only approximate from asset weight.',
  run(ctx) {
    const thresholds = thresholdsFor(ctx)
    const out = []
    for (const [renderedUrl, result] of lighthouseResults(ctx)) {
      if (result?.available !== true) continue
      const formFactor = result.formFactor === 'desktop' ? 'desktop' : 'mobile'
      const threshold = thresholds[formFactor] ?? DEFAULT_THRESHOLDS[formFactor]
      const score = result.scores?.performance
      if (typeof score !== 'number' || score >= threshold) continue
      const metrics = result.metrics ?? {}
      out.push(emit(lighthouseScore, {
        page: renderedUrl,
        detail: `Lighthouse scored this page ${score} for performance on ${formFactor}, below the ${threshold} this audit treats as the bar. The metrics below say which part of the load is costing the score.`,
        evidence: [
          url(renderedUrl),
          metric(`performance ${score}/100 on ${formFactor} (threshold ${threshold})`),
          ...(typeof metrics.lcp === 'number' ? [metric(`LCP ${Math.round(metrics.lcp)}ms`)] : []),
          ...(typeof metrics.cls === 'number' ? [metric(`CLS ${metrics.cls}`)] : []),
          ...(typeof metrics.tbt === 'number' ? [metric(`TBT ${Math.round(metrics.tbt)}ms`)] : []),
        ],
        fix: 'Work the largest metric first: LCP is usually the hero image or a blocking font, TBT is javascript, CLS is images and ads with no reserved space.',
      }))
    }
    return out
  },
})

export const lighthouseSummary = define({
  id: 'browser.lighthouse-summary',
  severity: 'info',
  title: 'Lighthouse scores for this page',
  catches: 'Nothing on its own — it is the measured baseline the other findings are argued against, recorded so the next run has something to compare with.',
  run(ctx) {
    const out = []
    for (const [renderedUrl, result] of lighthouseResults(ctx)) {
      if (result?.available !== true) continue
      const formFactor = result.formFactor === 'desktop' ? 'desktop' : 'mobile'
      const scores = result.scores ?? {}
      const metrics = result.metrics ?? {}
      const show = (label, value, unit = '') => (value === null || value === undefined ? [] : [metric(`${label} ${unit === 'ms' ? Math.round(value) : value}${unit}`)])
      out.push(emit(lighthouseSummary, {
        page: renderedUrl,
        detail: `Lighthouse (${formFactor}): performance ${scores.performance ?? 'n/a'}, accessibility ${scores.accessibility ?? 'n/a'}, best practices ${scores.bestPractices ?? 'n/a'}, SEO ${scores.seo ?? 'n/a'}. Recorded as the baseline for this page; the accessibility number in particular is a floor, not a pass — axe checks a fraction of what matters.`,
        evidence: [
          url(renderedUrl),
          ...show('performance', scores.performance),
          ...show('accessibility', scores.accessibility),
          ...show('best practices', scores.bestPractices),
          ...show('SEO', scores.seo),
          ...show('LCP', metrics.lcp, 'ms'),
          ...show('CLS', metrics.cls),
          ...show('TBT', metrics.tbt, 'ms'),
          ...show('INP', metrics.inp, 'ms'),
          ...show('FCP', metrics.fcp, 'ms'),
          ...show('Speed Index', metrics.si, 'ms'),
        ],
        fix: 'Nothing to fix from this row alone. Keep it to compare against after the performance work.',
      }))
    }
    return out
  },
})

export const screenshotsForReview = define({
  id: 'browser.screenshots-for-review',
  severity: 'info',
  title: 'Screenshots captured for a human visual pass',
  catches: 'Nothing automatically — it hands over the evidence for the one review no checker can do: does this page actually look right.',
  run(ctx) {
    const out = []
    for (const [renderedUrl, render] of renders(ctx)) {
      const shots = Object.entries(render?.screenshots ?? {}).filter(([, path]) => typeof path === 'string' && path !== '')
      if (shots.length === 0) continue
      out.push(emit(screenshotsForReview, {
        page: renderedUrl,
        detail: `Full-page screenshots of this page at ${shots.map(([width]) => width).join(', ')} width. Look at each one: cut-off text, a hero that never loaded, a footer overlapping content, placeholder copy that survived launch.`,
        evidence: [url(renderedUrl), ...shots.map(([width, path]) => screenshot(`${width}: ${path}`))],
        fix: 'Open the three screenshots side by side and read the page as a visitor would, before anything else in this report.',
      }))
    }
    return out
  },
})

export const checks = [
  consoleErrors,
  embedConsoleError,
  failedRequests,
  horizontalOverflow,
  navNotCollapsed,
  renderedHeadDiffers,
  analyticsNotFiring,
  consentMissing,
  axeViolation,
  lighthouseScore,
  lighthouseSummary,
  screenshotsForReview,
]
