// The browser-tier checks, over a hand-built ctx.browser.
//
// These checks never touch a browser: Task 14's orchestrator runs browser.mjs and hands the result
// in as `ctx.browser`, so the whole surface under test here is "given this render/axe/lighthouse
// result, what is reported". Every ctx is written out by hand for that reason.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checks } from '../skills/launch-audit/scripts/lib/checks/browser-tier.mjs'

const PAGE = 'https://render.test/'
const OTHER = 'https://render.test/pricing'

const GA4_BODY = `<html><head><script>gtag('config', 'G-ABC123')</script></head><body>hi</body></html>`
const PLAIN_BODY = '<html><head><title>HTTP title</title></head><body>hi</body></html>'

const head = (over = {}) => ({
  title: 'HTTP title',
  metaByName: new Map([['description', 'HTTP description']]),
  canonical: 'https://render.test/',
  robots: null,
  ...over,
})

const crawlPage = (url, body, headOver) => ({
  url,
  finalUrl: url,
  status: 200,
  response: { status: 200, body },
  page: { head: head(headOver) },
})

const render = (over = {}) => ({
  url: PAGE,
  finalUrl: PAGE,
  status: 200,
  screenshots: { desktop: '/shots/render-test/desktop.png', tablet: '/shots/render-test/tablet.png', mobile: '/shots/render-test/mobile.png' },
  consoleErrors: [],
  failedRequests: [],
  collectorHits: [],
  horizontalOverflow: { desktop: false, tablet: false, mobile: false },
  navCollapsed: true,
  renderedHead: { title: 'HTTP title', description: 'HTTP description', canonical: 'https://render.test/', robots: null },
  cookiesBeforeInteraction: [],
  consentBannerVisible: true,
  error: null,
  ...over,
})

function ctxWith({ renders = [[PAGE, render()]], axe = [], lighthouse = [], available = true, pages = [crawlPage(PAGE, PLAIN_BODY)], embeds = [], externals = [], options = {} } = {}) {
  return {
    target: { url: PAGE, origin: 'https://render.test' },
    crawl: { pages },
    probes: {
      embeds: new Map(embeds.map((url) => [url, { status: 200 }])),
      externals: new Map(externals),
    },
    options,
    browser: {
      available,
      reason: available ? null : '--browser off',
      renders: new Map(renders),
      axe: new Map(axe),
      lighthouse: new Map(lighthouse),
      sampled: renders.map(([url]) => url),
    },
  }
}

async function run(ctx) {
  const out = []
  for (const check of checks) {
    const produced = await check.run(ctx)
    assert.ok(Array.isArray(produced), `${check.id}.run() must return an array`)
    for (const finding of produced) {
      assert.equal(finding.id, check.id)
      out.push(finding)
    }
  }
  return out
}

const of = (findings, id) => findings.filter((f) => f.id === id)
const has = (findings, id) => findings.some((f) => f.id === id)
const evidenceText = (finding) => finding.evidence.map((e) => `${e.type}:${e.value}`).join(' | ')

const ALL_IDS = [
  'browser.console-errors',
  'browser.failed-requests',
  'browser.horizontal-overflow',
  'browser.nav-not-collapsed',
  'browser.rendered-head-differs',
  'browser.analytics-not-firing',
  'browser.consent-missing',
  'browser.axe-violation',
  'browser.lighthouse-score',
  'browser.lighthouse-summary',
  'browser.screenshots-for-review',
  'browser.embed-console-error',
]

test('every check is registrable, browser-tier, and in the browser dimension', () => {
  assert.deepEqual(checks.map((c) => c.id).sort(), [...ALL_IDS].sort())
  for (const check of checks) {
    assert.equal(check.phase, 'launch-audit')
    assert.equal(check.dimension, 'browser')
    assert.equal(check.tier, 'browser')
    assert.ok(check.title && check.catches)
  }
})

test('every check reports nothing when the browser tier did not run', async () => {
  const ctx = ctxWith({
    available: false,
    renders: [[PAGE, render({ consoleErrors: [{ text: 'boom', url: PAGE }], navCollapsed: false })]],
    axe: [[PAGE, { available: true, violations: [{ id: 'color-contrast', impact: 'critical', help: 'h', helpUrl: 'u', nodes: 1, sample: 'p' }] }]],
    lighthouse: [[PAGE, { available: true, formFactor: 'mobile', scores: { performance: 10, accessibility: 10, bestPractices: 10, seo: 10 }, metrics: { lcp: 1, cls: 1, tbt: 1, inp: null, fcp: 1, si: 1 } }]],
  })
  assert.deepEqual(await run(ctx), [])
})

test('a clean render reports only the info screenshot row', async () => {
  const found = await run(ctxWith())
  assert.deepEqual(found.map((f) => f.id), ['browser.screenshots-for-review'])
})

test('browser.screenshots-for-review lists all three paths for the page', async () => {
  const found = of(await run(ctxWith()), 'browser.screenshots-for-review')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'info')
  assert.equal(found[0].page, PAGE)
  const evidence = evidenceText(found[0])
  assert.match(evidence, /desktop\.png/)
  assert.match(evidence, /tablet\.png/)
  assert.match(evidence, /mobile\.png/)
})

test('browser.console-errors counts them and quotes the first three', async () => {
  const errors = [1, 2, 3, 4].map((n) => ({ text: `Error number ${n}`, url: `https://render.test/app${n}.js` }))
  const found = of(await run(ctxWith({ renders: [[PAGE, render({ consoleErrors: errors })]] })), 'browser.console-errors')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  assert.equal(found[0].page, PAGE)
  assert.match(found[0].detail, /4/)
  const evidence = evidenceText(found[0])
  assert.match(evidence, /Error number 1/)
  assert.match(evidence, /Error number 3/)
  assert.ok(!evidence.includes('Error number 4'))
  assert.ok(!has(await run(ctxWith()), 'browser.console-errors'))
})

test('browser.embed-console-error singles out an error thrown by a form embed', async () => {
  const ctx = ctxWith({
    embeds: ['https://forms.test/embed.js'],
    renders: [[PAGE, render({ consoleErrors: [{ text: 'embed blew up', url: 'https://forms.test/embed.js' }] })]],
  })
  const found = of(await run(ctx), 'browser.embed-console-error')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'high')
  assert.equal(found[0].page, PAGE)
  assert.match(evidenceText(found[0]), /forms\.test\/embed\.js/)
  // An error from the site's own bundle is not an embed error.
  const own = ctxWith({ embeds: ['https://forms.test/embed.js'], renders: [[PAGE, render({ consoleErrors: [{ text: 'boom', url: 'https://render.test/app.js' }] })]] })
  assert.ok(!has(await run(own), 'browser.embed-console-error'))
})

test('browser.failed-requests skips collector hosts and requests the http tier already could not verify', async () => {
  const ctx = ctxWith({
    externals: [['https://unverifiable.test/logo.png', { status: 0, error: 'connect ECONNREFUSED' }]],
    renders: [[PAGE, render({
      failedRequests: [
        { url: 'https://render.test/missing.png', status: 404, method: 'GET' },
        { url: 'https://www.google-analytics.com/g/collect?v=2', status: 0, method: 'POST' },
        { url: 'https://unverifiable.test/logo.png', status: 0, method: 'GET' },
      ],
    })]],
  })
  const found = of(await run(ctx), 'browser.failed-requests')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /missing\.png/)
  assert.ok(!evidence.includes('google-analytics'))
  assert.ok(!evidence.includes('unverifiable.test'))
  assert.ok(!has(await run(ctxWith()), 'browser.failed-requests'))
})

test('browser.horizontal-overflow is high at mobile and medium at the wider viewports', async () => {
  const ctx = ctxWith({ renders: [[PAGE, render({ horizontalOverflow: { desktop: true, tablet: false, mobile: true } })]] })
  const found = of(await run(ctx), 'browser.horizontal-overflow')
  assert.equal(found.length, 2)
  const mobile = found.find((f) => evidenceText(f).includes('mobile'))
  const desktop = found.find((f) => evidenceText(f).includes('desktop'))
  assert.equal(mobile.severity, 'high')
  assert.equal(desktop.severity, 'medium')
  assert.equal(mobile.page, PAGE)
  assert.ok(!has(await run(ctxWith()), 'browser.horizontal-overflow'))
})

test('browser.nav-not-collapsed fires only when a mobile nav stayed open', async () => {
  const ctx = ctxWith({ renders: [[PAGE, render({ navCollapsed: false })]] })
  const found = of(await run(ctx), 'browser.nav-not-collapsed')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  assert.equal(found[0].page, PAGE)
  assert.ok(!has(await run(ctxWith()), 'browser.nav-not-collapsed'))
  // No nav at all is not a finding.
  assert.ok(!has(await run(ctxWith({ renders: [[PAGE, render({ navCollapsed: null })]] })), 'browser.nav-not-collapsed'))
})

test('browser.rendered-head-differs names each field the browser changed', async () => {
  const ctx = ctxWith({
    renders: [[PAGE, render({ renderedHead: { title: 'Rendered title', description: 'HTTP description', canonical: 'https://render.test/other', robots: 'noindex' } })]],
  })
  const found = of(await run(ctx), 'browser.rendered-head-differs')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  assert.equal(found[0].page, PAGE)
  const evidence = evidenceText(found[0])
  assert.match(evidence, /title/)
  assert.match(evidence, /canonical/)
  assert.match(evidence, /robots/)
  assert.ok(!/description/.test(evidence))
  assert.ok(!has(await run(ctxWith()), 'browser.rendered-head-differs'))
  // Whitespace-only differences are not differences.
  const padded = ctxWith({ renders: [[PAGE, render({ renderedHead: { title: '  HTTP title ', description: 'HTTP description', canonical: 'https://render.test/', robots: null } })]] })
  assert.ok(!has(await run(padded), 'browser.rendered-head-differs'))
})

test('browser.analytics-not-firing fires when the tag is in the markup but nothing reached the collector', async () => {
  const ctx = ctxWith({ pages: [crawlPage(PAGE, GA4_BODY)], renders: [[PAGE, render({ collectorHits: [] })]] })
  const found = of(await run(ctx), 'browser.analytics-not-firing')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'high')
  assert.equal(found[0].page, PAGE)
  assert.match(evidenceText(found[0]), /GA4/)
  // A collector hit clears it.
  const firing = ctxWith({ pages: [crawlPage(PAGE, GA4_BODY)], renders: [[PAGE, render({ collectorHits: ['https://www.google-analytics.com/g/collect?v=2'] })]] })
  assert.ok(!has(await run(firing), 'browser.analytics-not-firing'))
  // No tag in the markup, nothing to report.
  assert.ok(!has(await run(ctxWith()), 'browser.analytics-not-firing'))
})

test('browser.consent-missing fires when cookies are set before any interaction and no banner is visible', async () => {
  const ctx = ctxWith({
    pages: [crawlPage(PAGE, GA4_BODY)],
    renders: [[PAGE, render({ collectorHits: ['https://www.google-analytics.com/g/collect'], cookiesBeforeInteraction: [{ name: '_ga', domain: '.render.test' }], consentBannerVisible: false })]],
  })
  const found = of(await run(ctx), 'browser.consent-missing')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'info')
  assert.match(evidenceText(found[0]), /_ga/)
  // A visible banner clears it.
  const withBanner = ctxWith({
    pages: [crawlPage(PAGE, GA4_BODY)],
    renders: [[PAGE, render({ cookiesBeforeInteraction: [{ name: '_ga', domain: '.render.test' }], consentBannerVisible: true })]],
  })
  assert.ok(!has(await run(withBanner), 'browser.consent-missing'))
  // No cookie-setting tag, nothing to consent to.
  const cookieless = ctxWith({
    pages: [crawlPage(PAGE, '<script src="https://plausible.io/js/script.js"></script>')],
    renders: [[PAGE, render({ cookiesBeforeInteraction: [], consentBannerVisible: false })]],
  })
  assert.ok(!has(await run(cookieless), 'browser.consent-missing'))
})

test('browser.axe-violation is one finding per violation, with the severity axe implies', async () => {
  const violations = [
    { id: 'color-contrast', impact: 'serious', help: 'Contrast', helpUrl: 'https://example.test/c', nodes: 4, sample: '.hero p' },
    { id: 'region', impact: 'moderate', help: 'Landmarks', helpUrl: 'https://example.test/r', nodes: 1, sample: 'body > div' },
    { id: 'aria-hidden-focus', impact: 'critical', help: 'Focusable', helpUrl: 'https://example.test/a', nodes: 2, sample: '#x' },
    { id: 'empty-heading', impact: 'minor', help: 'Empty heading', helpUrl: 'https://example.test/h', nodes: 1, sample: 'h2' },
  ]
  const ctx = ctxWith({ axe: [[PAGE, { available: true, violations }]] })
  const found = of(await run(ctx), 'browser.axe-violation')
  assert.equal(found.length, 4)
  const by = (id) => found.find((f) => evidenceText(f).includes(id))
  assert.equal(by('color-contrast').severity, 'high')
  assert.equal(by('aria-hidden-focus').severity, 'high')
  assert.equal(by('region').severity, 'medium')
  assert.equal(by('empty-heading').severity, 'low')
  assert.equal(by('color-contrast').page, PAGE)
  assert.match(evidenceText(by('color-contrast')), /\.hero p/)
  // An unavailable axe result reports nothing.
  assert.ok(!has(await run(ctxWith({ axe: [[PAGE, { available: false, reason: 'axe-core not installed. Optional: npm i -D axe-core' }]] })), 'browser.axe-violation'))
  assert.ok(!has(await run(ctxWith({ axe: [[PAGE, { available: true, violations: [] }]] })), 'browser.axe-violation'))
})

const lh = (performance, formFactor = 'mobile') => ({
  available: true,
  formFactor,
  scores: { performance, accessibility: 95, bestPractices: 92, seo: 90 },
  metrics: { lcp: 3200, cls: 0.21, tbt: 450, inp: null, fcp: 1200, si: 2600 },
})

test('browser.lighthouse-score fires on a performance score under the threshold for its form factor', async () => {
  const mobileBad = ctxWith({ lighthouse: [[PAGE, lh(55, 'mobile')]] })
  const found = of(await run(mobileBad), 'browser.lighthouse-score')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  assert.equal(found[0].page, PAGE)
  assert.match(evidenceText(found[0]), /55/)
  assert.match(evidenceText(found[0]), /70/)
  // 75 clears the mobile threshold but not the desktop one.
  assert.ok(!has(await run(ctxWith({ lighthouse: [[PAGE, lh(75, 'mobile')]] })), 'browser.lighthouse-score'))
  assert.ok(has(await run(ctxWith({ lighthouse: [[PAGE, lh(75, 'desktop')]] })), 'browser.lighthouse-score'))
})

test('browser.lighthouse-score honours options.thresholds', async () => {
  const ctx = ctxWith({ lighthouse: [[PAGE, lh(75, 'mobile')]], options: { thresholds: { desktop: 90, mobile: 80 } } })
  assert.ok(has(await run(ctx), 'browser.lighthouse-score'))
})

test('browser.lighthouse-summary reports every category and metric once per page, at info', async () => {
  const found = of(await run(ctxWith({ lighthouse: [[PAGE, lh(55, 'mobile')]] })), 'browser.lighthouse-summary')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'info')
  assert.equal(found[0].page, PAGE)
  const evidence = evidenceText(found[0])
  for (const needle of ['95', '92', '90', '3200', '0.21', '450']) assert.ok(evidence.includes(needle), `${needle} missing from ${evidence}`)
  // An unavailable lighthouse result reports nothing at all.
  const off = ctxWith({ lighthouse: [[PAGE, { available: false, reason: 'lighthouse not installed. Optional: npm i -D lighthouse' }]] })
  assert.ok(!has(await run(off), 'browser.lighthouse-summary'))
  assert.ok(!has(await run(off), 'browser.lighthouse-score'))
})

test('two sampled pages are reported separately', async () => {
  const ctx = ctxWith({
    pages: [crawlPage(PAGE, PLAIN_BODY), crawlPage(OTHER, PLAIN_BODY)],
    renders: [
      [PAGE, render({ navCollapsed: false })],
      [OTHER, render({ url: OTHER, finalUrl: OTHER, navCollapsed: false })],
    ],
  })
  const found = of(await run(ctx), 'browser.nav-not-collapsed')
  assert.deepEqual(found.map((f) => f.page).sort(), [PAGE, OTHER].sort())
})

test('a render that errored outright still reports what it captured without crashing', async () => {
  const ctx = ctxWith({
    renders: [[PAGE, { url: PAGE, finalUrl: null, status: null, screenshots: { desktop: null, tablet: null, mobile: null }, consoleErrors: [], failedRequests: [], collectorHits: [], horizontalOverflow: { desktop: null, tablet: null, mobile: null }, navCollapsed: null, renderedHead: { title: null, description: null, canonical: null, robots: null }, cookiesBeforeInteraction: [], consentBannerVisible: false, error: 'net::ERR_CONNECTION_REFUSED' }]],
  })
  const found = await run(ctx)
  assert.ok(!has(found, 'browser.screenshots-for-review'))
  assert.ok(!has(found, 'browser.horizontal-overflow'))
  assert.ok(!has(found, 'browser.rendered-head-differs'))
})
