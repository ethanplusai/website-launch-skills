import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checks, fontDisplayMissing } from '../skills/launch-audit/scripts/lib/checks/perf.mjs'
import { buildAuditContext } from '../skills/launch-audit/scripts/lib/checks/_ctx.mjs'
import { createDns } from '../skills/launch-audit/scripts/lib/dns.mjs'
import { recordedNet } from './helpers.mjs'
import { fakeResolvers, findingsFor, has, of, allEvidence, evidenceText } from './checks-helpers.mjs'

const run = (fixture, options) => findingsFor(checks, `recorded/${fixture}`, options)
// A light site: one deferred script, a preloaded hero, font-display everywhere, nothing external.
const good = () => run('perf-good-site.json', { url: 'https://perf-good.test/' })
// A front page with a render-blocking script, an unpreloaded hero, two @font-face blocks with no
// font-display and two third-party scripts; a four-megabyte page; a page with 101 images.
const bad = () => run('perf-site.json', { url: 'https://perf.test/' })

test('every check is registrable, http-tier, and in the perf dimension', async () => {
  assert.ok(checks.length > 0)
  for (const check of checks) {
    assert.equal(check.phase, 'launch-audit')
    assert.equal(check.dimension, 'perf')
    assert.ok(check.id.startsWith('perf.'))
    assert.equal(check.tier, 'http')
    assert.ok(check.title && check.catches)
  }
  assert.equal(new Set(checks.map((c) => c.id)).size, checks.length)
})

test('a light site reports nothing above info', async () => {
  assert.deepEqual((await good()).filter((f) => f.severity !== 'info').map((f) => f.id), [])
})

test('perf.page-weight adds up the assets a page pulls in, and says how many it could not size', async () => {
  const found = of(await bad(), 'perf.page-weight')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  assert.equal(found[0].page, 'https://perf.test/weight')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /MB/)
  assert.match(found[0].detail, /1 sized asset/)
  assert.match(found[0].detail, /1 further asset could not be sized/)
  assert.ok(!has(await good(), 'perf.page-weight'))
})

test('perf.request-count fires past a hundred references on one page', async () => {
  const found = of(await bad(), 'perf.request-count')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'low')
  assert.equal(found[0].page, 'https://perf.test/many')
  assert.match(evidenceText(found[0]), /10[12]/)
  assert.ok(!has(await good(), 'perf.request-count'))
})

test('perf.render-blocking-script names the scripts the head waits for', async () => {
  const found = of(await bad(), 'perf.render-blocking-script')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  assert.equal(found[0].page, 'https://perf.test/')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /blocking\.js/)
  // The deferred script in the same head is not render-blocking.
  assert.ok(!evidence.includes('app.js'))
  assert.ok(!has(await good(), 'perf.render-blocking-script'))
})

test('perf.hero-preload-missing fires on a first image nothing tells the browser about', async () => {
  const found = of(await bad(), 'perf.hero-preload-missing')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'info')
  assert.equal(found[0].page, 'https://perf.test/')
  assert.match(evidenceText(found[0]), /hero\.webp/)
  // The good site preloads its hero; the heavy page marks its first image fetchpriority="high".
  assert.ok(!has(await good(), 'perf.hero-preload-missing'))
  assert.ok(!allEvidence(found).includes('huge.png'))
})

test('perf.font-display-missing covers an inline @font-face and a linked stylesheet', async () => {
  const found = of(await bad(), 'perf.font-display-missing')
  assert.equal(found.length, 2)
  for (const finding of found) assert.equal(finding.severity, 'low')
  const evidence = allEvidence(found)
  assert.match(evidence, /Ledger/)
  assert.match(evidence, /s\.css/)
  assert.ok(!has(await good(), 'perf.font-display-missing'))
})

test('perf.third-party-scripts inventories the outside code by host', async () => {
  const found = of(await bad(), 'perf.third-party-scripts')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'info')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /cdn\.other\.test/)
  assert.match(evidence, /tags\.vendor\.test/)
  // The site's own scripts are not third-party.
  assert.ok(!evidence.includes('perf.test/app.js'))
  assert.ok(!has(await good(), 'perf.third-party-scripts'))
})

test('perf.browser-tier-required says the real measurements did not happen, and why', async () => {
  const found = of(await bad(), 'perf.browser-tier-required')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'info')
  assert.match(found[0].detail, /Core Web Vitals|LCP|CLS/)
  assert.match(evidenceText(found[0]), /no browser/i)
})

test('perf.browser-tier-required says nothing when the browser tier did run', async () => {
  const findings = await run('perf-site.json', {
    url: 'https://perf.test/',
    browser: { available: true, reason: null },
    cacheTag: 'perf-browser-ran',
  })
  assert.ok(!has(findings, 'perf.browser-tier-required'))
  assert.ok(has(findings, 'perf.render-blocking-script'))
})

test('a linked stylesheet is read even when HEAD returns no body, as a real server does', async () => {
  const net = recordedNet({
    'https://css.test/': {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<!doctype html><html lang="en"><head><title>Styled</title><link rel="stylesheet" href="/s.css">'
        + '<script src="/app.js" defer></script></head><body><main><h1>Styled</h1></main></body></html>',
    },
    'https://css.test/s.css': {
      status: 200,
      headers: { 'content-type': 'text/css' },
      body: '@font-face { font-family: "Ledger"; src: url(/ledger.woff2) format("woff2"); }\n',
    },
    'https://css.test/app.js': { status: 200, headers: { 'content-type': 'application/javascript' }, body: 'console.log(1)' },
  })
  const asked = []
  const get = net.get
  net.get = (u) => { asked.push(`GET ${u}`); return get(u) }
  // A real server answers HEAD with headers and no body whatsoever — which is exactly the case
  // the recorded-net alias in checks-helpers hides.
  net.head = async (u) => { asked.push(`HEAD ${u}`); return { ...(await get(u)), body: null, bodyBytes: null } }
  net.cert = async () => ({ valid: true, altNames: ['css.test'], daysLeft: 90, error: null })
  const ctx = await buildAuditContext(net, createDns(fakeResolvers()), { url: 'https://css.test/', random: () => 'deadbeef' })

  const found = await fontDisplayMissing.run(ctx)
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://css.test/s.css')
  assert.match(evidenceText(found[0]), /Ledger/)
  assert.ok(asked.includes('GET https://css.test/s.css'))
  assert.ok(asked.includes('HEAD https://css.test/app.js'))
})
