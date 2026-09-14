// The optional browser tier, driven entirely by a fake loader.
//
// Playwright is never installed in this repo and must never be needed to test browser.mjs, so
// every test here hands createBrowser() a `loader` that resolves to a stub `chromium`. The stub
// records every call it receives in one flat list, which is how the ordering assertions
// (scroll-before-screenshot) are written: the order of the recorded calls IS the behaviour.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpDir } from './helpers.mjs'
import { createBrowser } from '../skills/launch-audit/scripts/lib/browser.mjs'

const PLAYWRIGHT_MISSING = 'Playwright not installed. Optional: npm i -D playwright && npx playwright install chromium'
const AXE_MISSING = 'axe-core not installed. Optional: npm i -D axe-core'
const LIGHTHOUSE_MISSING = 'lighthouse not installed. Optional: npm i -D lighthouse'

// A stub chromium. `script` is what the fake page should answer:
//   evaluate: { '<marker found in the evaluated source>': value }  (a function value is called)
//   status, finalUrl, cookies, consoleErrors, requests, responses, requestFailed
//   gotoThrow: ['networkidle'] — waitUntil values that time out
//   launchError: a message, to make launch() reject
function stubChromium(script = {}) {
  const calls = []
  const browsers = []

  function makePage() {
    const handlers = new Map()
    const fire = (event, payload) => { for (const fn of handlers.get(event) ?? []) fn(payload) }
    let gotos = 0
    let lastWidth = null
    const page = {
      on(event, fn) {
        calls.push({ call: 'on', event })
        if (!handlers.has(event)) handlers.set(event, [])
        handlers.get(event).push(fn)
      },
      async setViewportSize({ width, height }) { lastWidth = width; calls.push({ call: 'viewport', width, height }) },
      async goto(url, options = {}) {
        calls.push({ call: 'goto', url, waitUntil: options.waitUntil })
        if ((script.gotoThrow ?? []).includes(options.waitUntil)) throw new Error(`Timeout ${options.waitUntil}`)
        gotos++
        // Events replay on every navigation on purpose: the render must dedupe them.
        fire('dialog', { message: () => 'hi', async dismiss() { calls.push({ call: 'dialog.dismiss' }) } })
        for (const error of script.consoleErrors ?? []) {
          fire('console', { type: () => 'error', text: () => error.text, location: () => ({ url: error.url }) })
        }
        fire('console', { type: () => 'log', text: () => 'chatter', location: () => ({ url }) })
        for (const requestUrl of script.requests ?? []) fire('request', { url: () => requestUrl, method: () => 'GET' })
        for (const response of script.responses ?? []) {
          fire('response', {
            url: () => response.url,
            status: () => response.status,
            request: () => ({ method: () => response.method ?? 'GET' }),
          })
        }
        for (const failed of script.requestFailed ?? []) {
          fire('requestfailed', {
            url: () => failed.url,
            method: () => failed.method ?? 'GET',
            failure: () => ({ errorText: failed.errorText ?? 'net::ERR_FAILED' }),
          })
        }
        return { status: () => script.status ?? 200, url: () => script.finalUrl ?? url }
      },
      url: () => script.finalUrl ?? script.lastUrl ?? 'https://render.test/',
      async evaluate(source) {
        const text = String(source)
        const marker = Object.keys(script.evaluate ?? {}).find((key) => text.includes(key))
        calls.push({ call: 'evaluate', marker: marker ?? text.slice(0, 40), source: text })
        const value = marker === undefined ? null : script.evaluate[marker]
        return typeof value === 'function' ? value(gotos) : value
      },
      async addScriptTag({ content }) { calls.push({ call: 'addScriptTag', bytes: content.length }) },
      async screenshot({ path, fullPage }) {
        calls.push({ call: 'screenshot', path, fullPage, width: lastWidth })
        if ((script.screenshotThrow ?? []).includes(lastWidth)) throw new Error(`screenshot failed at ${lastWidth}`)
        writeFileSync(path, '')
      },
      async close() { calls.push({ call: 'page.close' }) },
    }
    return page
  }

  const chromium = {
    async launch(options = {}) {
      calls.push({ call: 'launch', args: options.args ?? [], headless: options.headless })
      if (script.launchError !== undefined) throw new Error(script.launchError)
      const browser = {
        async newContext(contextOptions = {}) {
          calls.push({ call: 'newContext', userAgent: contextOptions.userAgent })
          return {
            async newPage() { calls.push({ call: 'newPage' }); return makePage() },
            async cookies() { return script.cookies ?? [] },
            async close() { calls.push({ call: 'context.close' }) },
          }
        },
        async close() { calls.push({ call: 'browser.close' }) },
      }
      browsers.push(browser)
      return browser
    },
  }
  return { chromium, calls, browsers }
}

const loaderFor = (stub) => () => Promise.resolve({ chromium: stub.chromium })

const RENDER_EVALUATE = {
  'scroll-steps': true,
  'horizontal-overflow': (n) => n === 3, // true at the third navigation only, i.e. mobile
  'nav-collapsed': false,
  'rendered-head': { title: 'Rendered title', description: 'Rendered description', canonical: 'https://render.test/', robots: 'index,follow' },
  'consent-banner': false,
}

test('mode "off" reports unavailable and never calls the loader', async () => {
  let called = false
  const browser = createBrowser({ mode: 'off', loader: () => { called = true; return Promise.resolve({}) } })
  assert.equal(await browser.open(), false)
  assert.equal(browser.available, false)
  assert.equal(browser.reason, '--browser off')
  assert.equal(called, false)
})

test('a loader that throws reports Playwright as missing, with the install line', async () => {
  const browser = createBrowser({ loader: () => { throw new Error('Cannot find package playwright') } })
  await browser.open()
  assert.equal(browser.available, false)
  assert.equal(browser.reason, PLAYWRIGHT_MISSING)
})

test('a loader that rejects is the same as one that throws', async () => {
  const browser = createBrowser({ loader: () => Promise.reject(new Error('nope')) })
  await browser.open()
  assert.equal(browser.available, false)
  assert.equal(browser.reason, PLAYWRIGHT_MISSING)
})

test('a chromium that will not launch reports the launch error as the reason', async () => {
  const stub = stubChromium({ launchError: 'Executable does not exist' })
  const browser = createBrowser({ loader: loaderFor(stub) })
  await browser.open()
  assert.equal(browser.available, false)
  assert.match(browser.reason, /Executable does not exist/)
})

test('open() launches headless chromium once, however many times it is called', async () => {
  const stub = stubChromium({})
  const browser = createBrowser({ loader: loaderFor(stub) })
  assert.equal(await browser.open(), true)
  await browser.open()
  assert.equal(browser.available, true)
  assert.equal(browser.reason, null)
  const launches = stub.calls.filter((c) => c.call === 'launch')
  assert.equal(launches.length, 1)
  assert.equal(launches[0].headless, true)
  await browser.close()
})

test('render() fills every field of the result', async () => {
  const tmp = tmpDir('browser-render')
  const stub = stubChromium({
    evaluate: RENDER_EVALUATE,
    status: 200,
    finalUrl: 'https://render.test/home',
    cookies: [{ name: '_ga', domain: '.render.test', value: 'x' }],
    consoleErrors: [{ text: 'Uncaught TypeError: x is not a function', url: 'https://cdn.render.test/app.js' }],
    requests: ['https://www.google-analytics.com/g/collect?v=2', 'https://render.test/app.js'],
    responses: [{ url: 'https://render.test/missing.png', status: 404, method: 'GET' }],
    requestFailed: [{ url: 'https://blocked.test/pixel.gif' }],
  })
  const browser = createBrowser({ loader: loaderFor(stub) })
  const result = await browser.render('https://render.test/', { outDir: tmp.dir })

  assert.equal(result.url, 'https://render.test/')
  assert.equal(result.finalUrl, 'https://render.test/home')
  assert.equal(result.status, 200)
  assert.equal(result.error, null)

  for (const width of ['desktop', 'tablet', 'mobile']) {
    assert.ok(result.screenshots[width].endsWith(join('screenshots', 'render-test', `${width}.png`)), result.screenshots[width])
    assert.ok(existsSync(result.screenshots[width]))
  }

  // Events replayed on all three navigations, and arrive deduped.
  assert.deepEqual(result.consoleErrors, [{ text: 'Uncaught TypeError: x is not a function', url: 'https://cdn.render.test/app.js' }])
  assert.deepEqual(result.collectorHits, ['https://www.google-analytics.com/g/collect?v=2'])
  assert.equal(result.failedRequests.length, 2)
  assert.deepEqual(result.failedRequests.find((r) => r.status === 404), { url: 'https://render.test/missing.png', status: 404, method: 'GET' })
  assert.deepEqual(result.failedRequests.find((r) => r.status === 0), { url: 'https://blocked.test/pixel.gif', status: 0, method: 'GET' })

  assert.deepEqual(result.horizontalOverflow, { desktop: false, tablet: false, mobile: true })
  assert.equal(result.navCollapsed, false)
  assert.deepEqual(result.renderedHead, RENDER_EVALUATE['rendered-head'])
  assert.deepEqual(result.cookiesBeforeInteraction, [{ name: '_ga', domain: '.render.test' }])
  assert.equal(result.consentBannerVisible, false)

  // A dialog handler is registered, and the dialog it saw was dismissed rather than accepted.
  assert.ok(stub.calls.some((c) => c.call === 'on' && c.event === 'dialog'))
  assert.ok(stub.calls.some((c) => c.call === 'dialog.dismiss'))
  // Nothing is ever clicked.
  assert.ok(!stub.calls.some((c) => c.call === 'click'))

  await browser.close()
  tmp.cleanup()
})

test('render() sets each viewport, and scrolls the page before it screenshots it', async () => {
  const tmp = tmpDir('browser-order')
  const stub = stubChromium({ evaluate: RENDER_EVALUATE })
  const browser = createBrowser({ loader: loaderFor(stub) })
  await browser.render('https://render.test/', { outDir: tmp.dir })

  const widths = stub.calls.filter((c) => c.call === 'viewport').map((c) => c.width)
  assert.deepEqual(widths, [1440, 768, 390])

  const steps = stub.calls
    .filter((c) => (c.call === 'evaluate' && c.marker === 'scroll-steps') || c.call === 'screenshot' || c.call === 'viewport')
    .map((c) => (c.call === 'viewport' ? `viewport:${c.width}` : (c.call === 'screenshot' ? 'shot' : 'scroll')))
  assert.deepEqual(steps, [
    'viewport:1440', 'scroll', 'shot',
    'viewport:768', 'scroll', 'shot',
    'viewport:390', 'scroll', 'shot',
  ])
  assert.ok(stub.calls.filter((c) => c.call === 'screenshot').every((c) => c.fullPage === true))

  await browser.close()
  tmp.cleanup()
})

test('render() falls back to waitUntil load when networkidle times out, and says so', async () => {
  const tmp = tmpDir('browser-fallback')
  const stub = stubChromium({ evaluate: RENDER_EVALUATE, gotoThrow: ['networkidle'] })
  const browser = createBrowser({ loader: loaderFor(stub) })
  const result = await browser.render('https://render.test/', { outDir: tmp.dir })
  const waits = stub.calls.filter((c) => c.call === 'goto').map((c) => c.waitUntil)
  assert.deepEqual(waits.slice(0, 2), ['networkidle', 'load'])
  assert.match(result.error, /networkidle/)
  assert.ok(result.screenshots.desktop !== null)
  await browser.close()
  tmp.cleanup()
})

test('navCollapsed is only asked at mobile width, and is null when there is no nav', async () => {
  const tmp = tmpDir('browser-nav')
  const stub = stubChromium({ evaluate: { ...RENDER_EVALUATE, 'nav-collapsed': null } })
  const browser = createBrowser({ loader: loaderFor(stub) })
  const result = await browser.render('https://render.test/', { outDir: tmp.dir })
  assert.equal(result.navCollapsed, null)
  assert.equal(stub.calls.filter((c) => c.call === 'evaluate' && c.marker === 'nav-collapsed').length, 1)
  await browser.close()
  tmp.cleanup()
})

test('two urls that slugify the same get their own screenshot directory', async () => {
  const tmp = tmpDir('browser-slug')
  const stub = stubChromium({ evaluate: RENDER_EVALUATE })
  const browser = createBrowser({ loader: loaderFor(stub) })
  const first = await browser.render('https://render.test/a/b', { outDir: tmp.dir })
  const second = await browser.render('https://render.test/a-b', { outDir: tmp.dir })
  const third = await browser.render('https://render.test/a/b?x=1', { outDir: tmp.dir })
  assert.ok(first.screenshots.desktop.includes(join('render-test-a-b', 'desktop.png')))
  assert.ok(second.screenshots.desktop.includes(join('render-test-a-b-2', 'desktop.png')))
  assert.ok(third.screenshots.desktop.includes(join('render-test-a-b-3', 'desktop.png')))
  // The same url twice keeps the directory it already had.
  const again = await browser.render('https://render.test/a/b', { outDir: tmp.dir })
  assert.equal(again.screenshots.desktop, first.screenshots.desktop)
  await browser.close()
  tmp.cleanup()
})

test('render() on an unavailable browser returns an empty result carrying the reason', async () => {
  const tmp = tmpDir('browser-unavailable')
  const browser = createBrowser({ mode: 'off' })
  const result = await browser.render('https://render.test/', { outDir: tmp.dir })
  assert.equal(result.error, '--browser off')
  assert.deepEqual(result.screenshots, { desktop: null, tablet: null, mobile: null })
  assert.deepEqual(result.collectorHits, [])
  assert.equal(result.navCollapsed, null)
  tmp.cleanup()
})

test('axe() is unavailable, with the install line, when axe-core cannot be resolved', async () => {
  const stub = stubChromium({ evaluate: RENDER_EVALUATE })
  const browser = createBrowser({ loader: loaderFor(stub), resolveAxe: () => { throw new Error('Cannot find module') } })
  const result = await browser.axe('https://render.test/')
  assert.deepEqual(result, { available: false, reason: AXE_MISSING })
})

test('axe() injects the resolved axe-core and reports one row per violation', async () => {
  const tmp = tmpDir('browser-axe')
  const axeFile = join(tmp.dir, 'axe.min.js')
  writeFileSync(axeFile, 'window.axe = {}')
  const stub = stubChromium({
    evaluate: {
      ...RENDER_EVALUATE,
      'axe-run': {
        violations: [
          { id: 'color-contrast', impact: 'serious', help: 'Elements must have sufficient colour contrast', helpUrl: 'https://example.test/color-contrast', nodes: [{ target: ['.hero p'] }, { target: ['.footer a'] }] },
          { id: 'region', impact: 'moderate', help: 'All content should be contained by landmarks', helpUrl: 'https://example.test/region', nodes: [{ target: ['body > div'] }] },
        ],
      },
    },
  })
  const browser = createBrowser({ loader: loaderFor(stub), resolveAxe: () => axeFile })
  const result = await browser.axe('https://render.test/')
  assert.equal(result.available, true)
  assert.deepEqual(result.violations, [
    { id: 'color-contrast', impact: 'serious', help: 'Elements must have sufficient colour contrast', helpUrl: 'https://example.test/color-contrast', nodes: 2, sample: '.hero p' },
    { id: 'region', impact: 'moderate', help: 'All content should be contained by landmarks', helpUrl: 'https://example.test/region', nodes: 1, sample: 'body > div' },
  ])
  assert.ok(stub.calls.some((c) => c.call === 'addScriptTag' && c.bytes === 'window.axe = {}'.length))
  await browser.close()
  tmp.cleanup()
})

test('axe() is unavailable when the browser itself is', async () => {
  const browser = createBrowser({ mode: 'off' })
  const result = await browser.axe('https://render.test/')
  assert.equal(result.available, false)
  assert.equal(result.reason, '--browser off')
})

test('lighthouse() is unavailable, with the install line, when lighthouse cannot be imported', async () => {
  const stub = stubChromium({})
  const browser = createBrowser({ loader: loaderFor(stub) })
  const result = await browser.lighthouse('https://render.test/', { formFactor: 'mobile' })
  assert.deepEqual(result, { available: false, reason: LIGHTHOUSE_MISSING })
})

test('lighthouse() launches a second chromium on the port this side picked, and hands lighthouse the same one', async () => {
  const stub = stubChromium({})
  const runs = []
  const loader = loaderFor(stub)
  loader.lighthouse = async (url, flags) => {
    runs.push({ url, flags })
    return {
      lhr: {
        categories: {
          performance: { score: 0.42 },
          accessibility: { score: 0.91 },
          'best-practices': { score: 1 },
          seo: { score: 0.83 },
        },
        audits: {
          'largest-contentful-paint': { numericValue: 3200 },
          'cumulative-layout-shift': { numericValue: 0.21 },
          'total-blocking-time': { numericValue: 450 },
          'first-contentful-paint': { numericValue: 1200 },
          'speed-index': { numericValue: 2600 },
        },
      },
    }
  }
  let picked = 0
  const browser = createBrowser({ loader, pickPort: async () => { picked++; return 45123 } })
  const result = await browser.lighthouse('https://render.test/', { formFactor: 'mobile' })
  assert.equal(picked, 1)

  assert.equal(runs.length, 1)
  assert.equal(runs[0].url, 'https://render.test/')
  assert.equal(runs[0].flags.port, 45123)
  assert.equal(runs[0].flags.output, 'json')
  assert.ok(runs[0].flags.onlyCategories.includes('performance'))
  assert.equal(runs[0].flags.formFactor, 'mobile')

  assert.equal(result.available, true)
  assert.equal(result.formFactor, 'mobile')
  assert.deepEqual(result.scores, { performance: 42, accessibility: 91, bestPractices: 100, seo: 83 })
  assert.deepEqual(result.metrics, { lcp: 3200, cls: 0.21, tbt: 450, inp: null, fcp: 1200, si: 2600 })

  // The lighthouse chromium is a second launch, asked for a debugging port.
  const launches = stub.calls.filter((c) => c.call === 'launch')
  assert.equal(launches.length, 2)
  assert.ok(launches[1].args.includes('--remote-debugging-port=45123'))

  await browser.close()
  const closes = stub.calls.filter((c) => c.call === 'browser.close')
  assert.equal(closes.length, 2)
})

test('a width that fails does not cost the other widths their screenshots', async () => {
  const tmp = tmpDir('browser-width-failure')
  const stub = stubChromium({ evaluate: RENDER_EVALUATE, screenshotThrow: [1440] })
  const browser = createBrowser({ loader: loaderFor(stub) })
  const result = await browser.render('https://render.test/', { outDir: tmp.dir })
  assert.equal(result.screenshots.desktop, null)
  assert.ok(existsSync(result.screenshots.tablet))
  assert.ok(existsSync(result.screenshots.mobile))
  assert.match(result.error, /desktop: screenshot failed at 1440/)
  // The widths after the failure were still measured.
  assert.equal(result.horizontalOverflow.mobile, true)
  await browser.close()
  tmp.cleanup()
})

test('a render after close() opens a fresh browser', async () => {
  const tmp = tmpDir('browser-reopen')
  const stub = stubChromium({ evaluate: RENDER_EVALUATE })
  const browser = createBrowser({ loader: loaderFor(stub) })
  await browser.render('https://render.test/', { outDir: tmp.dir })
  await browser.close()
  assert.equal(browser.available, false)
  const second = await browser.render('https://render.test/other', { outDir: tmp.dir })
  assert.equal(browser.available, true)
  assert.equal(second.error, null)
  assert.ok(existsSync(second.screenshots.desktop))
  assert.equal(stub.calls.filter((c) => c.call === 'launch').length, 2)
  await browser.close()
  tmp.cleanup()
})

test('close() on a browser that never became available keeps the reason it failed for', async () => {
  let loads = 0
  const browser = createBrowser({ loader: () => { loads++; throw new Error('missing') } })
  await browser.open()
  await browser.close()
  await browser.open()
  assert.equal(browser.reason, PLAYWRIGHT_MISSING)
  assert.equal(loads, 1)
})

test('the nav script looks at every link in the nav, not only its direct children', async () => {
  const tmp = tmpDir('browser-nav-links')
  const stub = stubChromium({ evaluate: RENDER_EVALUATE })
  const browser = createBrowser({ loader: loaderFor(stub) })
  await browser.render('https://render.test/', { outDir: tmp.dir })
  const evaluated = stub.calls.find((c) => c.call === 'evaluate' && c.marker === 'nav-collapsed').source
  assert.match(evaluated, /querySelectorAll\('ul, ol'\)/)
  assert.match(evaluated, /querySelectorAll\('a'\)/)
  assert.ok(!/nav\.children/.test(evaluated))
  await browser.close()
  tmp.cleanup()
})

test('axe() reports a page that never loaded as unavailable rather than as clean', async () => {
  // axe-core resolves fine here, so the failed navigation is what decides the result.
  const tmp = tmpDir('browser-axe-nav')
  const axeFile = join(tmp.dir, 'axe.min.js')
  writeFileSync(axeFile, 'window.axe = {}')
  const stub = stubChromium({ gotoThrow: ['networkidle', 'load'], evaluate: { 'axe-run': { violations: [] } } })
  const browser = createBrowser({ loader: loaderFor(stub), resolveAxe: () => axeFile })
  const result = await browser.axe('https://render.test/')
  assert.equal(result.available, false)
  assert.match(result.reason, /^navigation failed: /)
  assert.ok(!stub.calls.some((c) => c.call === 'evaluate' && c.marker === 'axe-run'))
  await browser.close()
  tmp.cleanup()
})

test('close() is safe when nothing was ever launched', async () => {
  const browser = createBrowser({ mode: 'off' })
  await browser.close()
})
