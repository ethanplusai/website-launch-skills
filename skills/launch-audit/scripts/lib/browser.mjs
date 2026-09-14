// The optional browser tier.
//
// Everything above this file is HTTP: bodies, headers, and what markup alone can prove. This is
// the one module that renders a page, and it is optional on purpose — Playwright is the only
// dependency this repo ever suggests, it is never installed here, and an audit must run without
// it. So the whole module is written against an injected `loader`: `createBrowser()` never imports
// playwright at module scope, and every test drives it with a fake chromium.
//
// Unavailability is a first-class result, not an error. `mode: 'off'`, a missing package and a
// chromium that will not launch all end the same way — `available: false` with a `reason` a human
// can act on — because the report's job is to say *why* a tier did not run rather than to pretend
// it did.
//
// Three things here exist because an earlier prototype got them wrong:
//
//   1. A full-page screenshot of a page with scroll-revealed content is a screenshot of empty
//      boxes. So `render` scrolls the page in viewport steps to the bottom and back to the top
//      before it shoots, and the tests assert that order.
//   2. Two urls can slugify to the same directory name (`/a/b` and `/a-b`), and the prototype
//      silently overwrote the first page's evidence with the second's. Slugs are now claimed once
//      per url and suffixed `-2`, `-3` on collision.
//   3. `networkidle` never settles on a page with a polling script or a live chat widget. A
//      timeout there falls back to `load` and records what happened rather than losing the page.
//
// `render` is strictly observational: it dismisses dialogs, and it never clicks anything. That is
// what makes `cookiesBeforeInteraction` mean what it says, and it is why nothing here can put a
// site into a state its own visitors would not reach by loading a url.

import { createServer } from 'node:net'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { slugify } from './slug.mjs'
import { USER_AGENT } from './net.mjs'
import { isCollectorUrl } from './detect/analytics.mjs'

export const DEFAULT_WIDTHS = { desktop: 1440, tablet: 768, mobile: 390 }
const VIEWPORT_HEIGHTS = { desktop: 900, tablet: 1024, mobile: 844 }

export const OFF_REASON = '--browser off'
const WHERE = 'in the website-launch-skills checkout, not the audited site'
export const PLAYWRIGHT_MISSING = `Playwright not installed. Optional, ${WHERE}: npm i --no-save playwright && npx playwright install chromium`
export const AXE_MISSING = `axe-core not installed. Optional, ${WHERE}: npm i --no-save axe-core`
export const LIGHTHOUSE_MISSING = `lighthouse not installed. Optional, ${WHERE}: npm i --no-save lighthouse`

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag22aa']
const LIGHTHOUSE_CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo']
const SCREEN_EMULATION = {
  mobile: { mobile: true, width: 390, height: 844, deviceScaleFactor: 2, disabled: false },
  desktop: { mobile: false, width: 1440, height: 900, deviceScaleFactor: 1, disabled: false },
}

// Every script is a source *string* rather than a function, and carries a comment marker. The
// marker is how the tests recognise which script a fake page was asked to run, and it is why the
// scroll-before-screenshot ordering can be asserted at all.
const VISIBLE = `const visible = (el) => {
  if (!el) return false
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return false
  const style = getComputedStyle(el)
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
}`

const SCROLL_STEPS = `(async () => {
  /* scroll-steps */
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
  const step = Math.max(200, window.innerHeight)
  let y = 0
  for (let i = 0; i < 60; i++) {
    window.scrollTo(0, y)
    await sleep(60)
    const bottom = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    if (y >= bottom) break
    y = Math.min(y + step, bottom)
  }
  window.scrollTo(0, 0)
  await sleep(60)
  return document.documentElement.scrollHeight
})()`

// Two pixels of slack: a rounded scrollWidth on a fractional layout is not a broken page.
const HORIZONTAL_OVERFLOW = `(() => {
  /* horizontal-overflow */
  return document.documentElement.scrollWidth > window.innerWidth + 2
})()`

// Three answers, not two, and the third one is the point. `null` means there was nothing here to
// judge — no nav, or no visible toggle inside it — and a page with nothing to judge must not be
// reported as a broken one. The smoke run found a site whose burger sits beside its <nav> rather
// than inside it, and read "no toggle in the nav" as "the nav does not collapse" on five pages.
// `true` is a visible toggle over a hidden link list: a collapsed nav. `false` is a visible toggle
// over a visible link list, which is the half-finished responsive header this check exists for.
export const NAV_COLLAPSED = `(() => {
  /* nav-collapsed */
  ${VISIBLE}
  const nav = document.querySelector('nav, [role=navigation]')
  if (!nav) return null
  const toggle = Array.from(nav.querySelectorAll('button, [aria-expanded]')).some(visible)
  if (!toggle) return null
  const lists = Array.from(nav.querySelectorAll('ul, ol'))
  // A nav with no list still has links; they are just not wrapped. Looking only at direct children
  // would miss every nav that puts its anchors in a div.
  const targets = lists.length > 0 ? lists : Array.from(nav.querySelectorAll('a'))
  const linksShowing = targets.some(visible)
  return !linksShowing
})()`

// Read from the live DOM, so a canonical or a robots meta a script injected after load is the one
// reported. `robots` is lowercased to match how the http tier normalises it, so case alone never
// reads as a difference.
const RENDERED_HEAD = `(() => {
  /* rendered-head */
  const meta = (name) => {
    const el = document.querySelector('meta[name="' + name + '"]')
    const content = el === null ? null : el.getAttribute('content')
    return content === null || content === '' ? null : content
  }
  const canonicalEl = document.querySelector('link[rel~="canonical"]')
  const robots = meta('robots')
  return {
    title: document.title === '' ? null : document.title,
    description: meta('description'),
    canonical: canonicalEl === null ? null : canonicalEl.getAttribute('href'),
    robots: robots === null ? null : robots.toLowerCase(),
  }
})()`

const CONSENT_BANNER = `(() => {
  /* consent-banner */
  ${VISIBLE}
  const selector = '[id*=consent], [class*=consent], [id*=cookie], [class*=cookie], [aria-label*=cookie i]'
  return Array.from(document.querySelectorAll(selector)).some(visible)
})()`

const AXE_RUN = `(async () => {
  /* axe-run */
  return await window.axe.run(document, { runOnly: { type: 'tag', values: ${JSON.stringify(AXE_TAGS)} } })
})()`

function emptyRender(url) {
  return {
    url,
    finalUrl: null,
    status: null,
    screenshots: { desktop: null, tablet: null, mobile: null },
    consoleErrors: [],
    failedRequests: [],
    collectorHits: [],
    horizontalOverflow: { desktop: null, tablet: null, mobile: null },
    navCollapsed: null,
    renderedHead: { title: null, description: null, canonical: null, robots: null },
    cookiesBeforeInteraction: [],
    consentBannerVisible: false,
    error: null,
  }
}

// axe-core ships a single built file; resolving the package is the whole availability test.
function defaultResolveAxe() {
  try {
    return createRequire(import.meta.url).resolve('axe-core/axe.min.js')
  } catch {
    // import.meta.resolve is the other spelling, and the only one that works when the package is
    // reachable as a bare specifier but not through CommonJS resolution.
    return fileURLToPath(import.meta.resolve('axe-core/axe.min.js'))
  }
}

// Lighthouse talks to Chromium over CDP, so it needs a browser started with a known debugging
// port. Playwright's Browser has no wsEndpoint() (that is Puppeteer), and
// `--remote-debugging-port=0` gives Chromium a port nothing on this side can read back — so the
// port is chosen here first: bind :0, read what the OS handed out, let it go, and pass the same
// number to both Chromium and lighthouse. The window between close and launch is a race in
// theory; in practice nothing else on the machine is racing for this port, and a launch that
// loses it fails loudly rather than silently measuring the wrong thing.
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

const messageOf = (error) => (error?.message === undefined || error.message === '' ? String(error) : error.message)

export function createBrowser(options = {}) {
  const {
    loader = () => import('playwright'),
    mode = 'auto',
    userAgent = USER_AGENT,
    timeoutMs = 30000,
    outDir = process.cwd(),
    widths = DEFAULT_WIDTHS,
    resolveAxe = defaultResolveAxe,
    pickPort = pickFreePort,
    // Injectable for the same reason `loader` is: whether lighthouse is installed is a fact about
    // the machine, and a test that asserts the not-installed path by relying on it being absent
    // passes for the wrong reason on any machine that has run the browser-tier install.
    importLighthouse = () => import('lighthouse'),
  } = options

  let available = mode === 'off' ? false : null
  let reason = mode === 'off' ? OFF_REASON : null
  let chromium = null
  let instance = null
  let lighthouseBrowser = null
  let lighthousePort = null
  let opening = null

  // One slug per url, claimed on first use, so a second url that slugifies the same way gets its
  // own directory instead of overwriting the first one's screenshots.
  const slugByUrl = new Map()
  const takenSlugs = new Set()
  function slugFor(url) {
    const known = slugByUrl.get(url)
    if (known !== undefined) return known
    const base = slugify(url)
    let slug = base
    let n = 1
    while (takenSlugs.has(slug)) {
      n++
      slug = `${base}-${n}`
    }
    takenSlugs.add(slug)
    slugByUrl.set(url, slug)
    return slug
  }

  async function launch() {
    let loaded
    try {
      loaded = await loader()
    } catch {
      available = false
      reason = PLAYWRIGHT_MISSING
      return false
    }
    chromium = loaded?.chromium ?? loaded?.default?.chromium ?? null
    if (typeof chromium?.launch !== 'function') {
      available = false
      reason = PLAYWRIGHT_MISSING
      return false
    }
    try {
      instance = await chromium.launch({ headless: true })
    } catch (error) {
      available = false
      reason = messageOf(error)
      return false
    }
    available = true
    reason = null
    return true
  }

  function open() {
    if (mode === 'off') return Promise.resolve(false)
    if (opening === null) opening = launch()
    return opening
  }

  async function newPage() {
    const context = await instance.newContext({
      userAgent,
      viewport: { width: widths.desktop ?? DEFAULT_WIDTHS.desktop, height: VIEWPORT_HEIGHTS.desktop },
    })
    const page = await context.newPage()
    // A page that opens an alert on load blocks every later evaluate until something answers it,
    // and a beforeunload confirm can strand the navigation entirely. Dismiss, never accept: an
    // accepted dialog is an interaction, and this tier does not interact.
    page.on('dialog', (dialog) => { Promise.resolve(dialog.dismiss()).catch(() => {}) })
    return { context, page }
  }

  // networkidle first, because a page that finishes its xhr is the page a visitor sees; `load` is
  // the fallback for the sites where idle never arrives, and the caller is told it happened.
  async function navigate(page, url) {
    try {
      return { response: await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs }), error: null }
    } catch (first) {
      try {
        const response = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs })
        return { response, error: `networkidle never settled (${messageOf(first)}); fell back to waitUntil "load"` }
      } catch (second) {
        return { response: null, error: messageOf(second) }
      }
    }
  }

  async function render(url, renderOptions = {}) {
    const result = emptyRender(url)
    if (!(await open())) return { ...result, error: reason }

    const usedWidths = renderOptions.widths ?? widths
    const dir = resolve(renderOptions.outDir ?? outDir)

    // Every listener dedupes, because the page is navigated once per viewport and a site's console
    // error is the same error all three times.
    const consoleErrors = new Map()
    const failedRequests = new Map()
    const collectorHits = new Set()

    const { context, page } = await newPage()
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      const text = message.text()
      const at = message.location?.()?.url ?? null
      consoleErrors.set(`${text}|${at}`, { text, url: at })
    })
    page.on('request', (request) => {
      const requestUrl = request.url()
      if (isCollectorUrl(requestUrl)) collectorHits.add(requestUrl)
    })
    page.on('response', (response) => {
      const status = response.status()
      if (status < 400) return
      const responseUrl = response.url()
      failedRequests.set(`${responseUrl}|${status}`, { url: responseUrl, status, method: response.request?.()?.method?.() ?? 'GET' })
    })
    page.on('requestfailed', (request) => {
      const requestUrl = request.url()
      failedRequests.set(`${requestUrl}|0`, { url: requestUrl, status: 0, method: request.method?.() ?? 'GET' })
    })

    const problems = []
    let firstLoad = true
    // The try is inside the loop on purpose: a screenshot that fails at desktop must not cost the
    // tablet and mobile evidence. Each width fails on its own and says so in `error`.
    try {
      for (const [name, width] of Object.entries(usedWidths)) {
        try {
          await page.setViewportSize({ width, height: VIEWPORT_HEIGHTS[name] ?? VIEWPORT_HEIGHTS.desktop })
          const { response, error } = await navigate(page, url)
          if (error !== null) problems.push(`${name}: ${error}`)
          // Both navigation attempts failed at this width: there is nothing on screen worth
          // screenshotting, and `error` already carries why.
          if (response === null) continue

          if (firstLoad) {
            firstLoad = false
            result.status = typeof response?.status === 'function' ? response.status() : null
            result.finalUrl = typeof page.url === 'function' ? page.url() : url
            result.renderedHead = (await page.evaluate(RENDERED_HEAD)) ?? result.renderedHead
            result.consentBannerVisible = (await page.evaluate(CONSENT_BANNER)) === true
            // After load, before any click: these are the cookies a visitor gets for doing nothing.
            const cookies = await context.cookies()
            result.cookiesBeforeInteraction = (cookies ?? []).map((cookie) => ({ name: cookie.name, domain: cookie.domain }))
          }

          // Scroll first. A full-page screenshot taken before this is a picture of the placeholders
          // every lazy-loading site ships.
          await page.evaluate(SCROLL_STEPS)
          result.horizontalOverflow[name] = (await page.evaluate(HORIZONTAL_OVERFLOW)) === true
          if (name === 'mobile') {
            const collapsed = await page.evaluate(NAV_COLLAPSED)
            result.navCollapsed = collapsed === null || collapsed === undefined ? null : collapsed === true
          }
          const path = join(dir, 'screenshots', slugFor(url), `${name}.png`)
          mkdirSync(dirname(path), { recursive: true })
          await page.screenshot({ path, fullPage: true })
          result.screenshots[name] = path
        } catch (error) {
          problems.push(`${name}: ${messageOf(error)}`)
        }
      }
    } catch (error) {
      problems.push(messageOf(error))
    } finally {
      await context.close().catch(() => {})
    }

    result.consoleErrors = [...consoleErrors.values()]
    result.failedRequests = [...failedRequests.values()]
    result.collectorHits = [...collectorHits]
    result.error = problems.length === 0 ? null : problems.join('; ')
    return result
  }

  async function axe(url) {
    if (!(await open())) return { available: false, reason }
    let source = null
    try {
      source = readFileSync(await resolveAxe(), 'utf8')
    } catch {
      return { available: false, reason: AXE_MISSING }
    }
    if (typeof source !== 'string' || source === '') return { available: false, reason: AXE_MISSING }

    const { context, page } = await newPage()
    try {
      const { response, error } = await navigate(page, url)
      // axe on a page that never loaded reports zero violations, which reads as a clean page. It
      // is the opposite: nothing was examined at all.
      if (response === null) return { available: false, reason: `navigation failed: ${error}` }
      await page.addScriptTag({ content: source })
      const report = await page.evaluate(AXE_RUN)
      const violations = (report?.violations ?? []).map((violation) => ({
        id: violation.id,
        impact: violation.impact ?? null,
        help: violation.help ?? null,
        helpUrl: violation.helpUrl ?? null,
        nodes: violation.nodes?.length ?? 0,
        sample: violation.nodes?.[0]?.target?.[0] ?? null,
      }))
      return { available: true, violations }
    } catch (error) {
      return { available: false, reason: messageOf(error) }
    } finally {
      await context.close().catch(() => {})
    }
  }

  // One extra browser per run, launched only if lighthouse is actually installed, on a port this
  // side picked so both ends agree on it.
  async function lighthouseChromium() {
    if (lighthouseBrowser === null) {
      const port = await pickPort()
      if (!Number.isInteger(port) || port <= 0) throw new Error(`could not pick a debugging port (got ${port})`)
      lighthouseBrowser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`] })
      lighthousePort = port
    }
    return lighthousePort
  }

  async function lighthouse(url, lighthouseOptions = {}) {
    const formFactor = lighthouseOptions.formFactor === 'desktop' ? 'desktop' : 'mobile'
    let run = typeof loader.lighthouse === 'function' ? loader.lighthouse : null
    if (run === null) {
      try {
        const loaded = await importLighthouse()
        run = loaded?.default ?? loaded
      } catch {
        return { available: false, reason: LIGHTHOUSE_MISSING }
      }
    }
    if (typeof run !== 'function') return { available: false, reason: LIGHTHOUSE_MISSING }
    if (!(await open())) return { available: false, reason }

    try {
      const port = await lighthouseChromium()
      const raw = await run(url, {
        port,
        output: 'json',
        logLevel: 'error',
        onlyCategories: LIGHTHOUSE_CATEGORIES,
        formFactor,
        screenEmulation: SCREEN_EMULATION[formFactor],
      })
      const lhr = raw?.lhr ?? raw
      const score = (category) => {
        const value = lhr?.categories?.[category]?.score
        return typeof value === 'number' ? Math.round(value * 100) : null
      }
      const metric = (audit) => {
        const value = lhr?.audits?.[audit]?.numericValue
        return typeof value === 'number' ? value : null
      }
      return {
        available: true,
        formFactor,
        scores: {
          performance: score('performance'),
          accessibility: score('accessibility'),
          bestPractices: score('best-practices'),
          seo: score('seo'),
        },
        metrics: {
          lcp: metric('largest-contentful-paint'),
          cls: metric('cumulative-layout-shift'),
          tbt: metric('total-blocking-time'),
          inp: metric('interaction-to-next-paint'),
          fcp: metric('first-contentful-paint'),
          si: metric('speed-index'),
        },
      }
    } catch (error) {
      return { available: false, reason: messageOf(error) }
    }
  }

  async function close() {
    for (const browser of [instance, lighthouseBrowser]) {
      if (browser === null) continue
      try {
        await browser.close()
      } catch {
        // A browser that has already gone away is closed.
      }
    }
    instance = null
    lighthouseBrowser = null
    lighthousePort = null
    // A closed browser is not an unavailable one: clearing the memo lets a later render open a
    // fresh chromium. A tier that never became available keeps its reason, so a missing package
    // is not re-probed on every call.
    if (available === true) {
      available = null
      reason = null
      opening = null
    }
  }

  return {
    get available() { return available === true },
    get reason() { return reason },
    open,
    render,
    axe,
    lighthouse,
    close,
  }
}
