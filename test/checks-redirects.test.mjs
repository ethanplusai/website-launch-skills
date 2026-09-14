import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checks, bestMatch, redirectMap, toCsv, redirectsCsv,
} from '../skills/launch-audit/scripts/lib/checks/redirects.mjs'
import { readFixture } from './helpers.mjs'
import { ctxFor, findingsFor, has, of, allEvidence, evidenceText } from './checks-helpers.mjs'

const OLD_SITE = () => JSON.parse(readFixture('recorded/redirects-old-site.json'))
const cutover = (cacheTag) => ({
  url: 'https://new.test/',
  oldUrl: 'https://old.test/',
  records: OLD_SITE(),
  cacheTag,
})
const run = (fixture, options) => findingsFor(checks, `recorded/${fixture}`, options)
// A cutover with a would-404, a redirect to a 404, a two-hop chain and six old urls dumped on the
// front page.
const bad = () => run('redirects-new-site.json', cutover('cutover-bad'))
// The same old site, cut over properly: every old url serves or redirects once, each to its own
// target.
const good = () => run('redirects-clean-site.json', cutover('cutover-clean'))
// An audit that was never told there was an old site.
const noOldUrl = () => run('links-good-site.json', { url: 'https://good-links.test/' })

test('every check is registrable, http-tier, and in the redirects dimension', async () => {
  assert.ok(checks.length > 0)
  for (const check of checks) {
    assert.equal(check.phase, 'launch-audit')
    assert.equal(check.dimension, 'redirects')
    assert.ok(check.id.startsWith('redirects.'))
    assert.equal(check.tier, 'http')
    assert.ok(check.title && check.catches)
  }
  assert.equal(new Set(checks.map((c) => c.id)).size, checks.length)
})

// ------------------------------------------------------------------------------------ bestMatch

test('bestMatch finds the renamed page by its slug, with real confidence', () => {
  const match = bestMatch('/services/botox', ['/treatments/botox', '/about'])
  assert.equal(match.path, '/treatments/botox')
  assert.ok(match.confidence > 0.5, `confidence was ${match.confidence}`)
})

test('bestMatch returns null when nothing overlaps at all', () => {
  assert.equal(bestMatch('/xyz', ['/completely/unrelated', '/about']), null)
  assert.equal(bestMatch('/xyz', []), null)
})

test('bestMatch ignores numbers and stop words, so a dated path still matches its slug', () => {
  const match = bestMatch('/blog/2019/the-art-of-binding', ['/journal/art-binding', '/contact'])
  assert.equal(match.path, '/journal/art-binding')
  assert.ok(match.confidence > 0)
})

test('bestMatch prefers the closer of two candidates', () => {
  const match = bestMatch('/services/deep-tissue-massage', ['/treatments/deep-tissue-massage', '/services'])
  assert.equal(match.path, '/treatments/deep-tissue-massage')
})

// ---------------------------------------------------------------------------- redirectMap, toCsv

test('redirectMap classifies every old url against the new site', async () => {
  const ctx = await ctxFor('recorded/redirects-new-site.json', cutover('cutover-bad'))
  const rows = redirectMap(ctx.oldCrawl, ctx.probes, ctx.target.origin, ['/', '/treatments/botox', '/about', '/contact'])
  const by = new Map(rows.map((row) => [row.old_url, row]))
  assert.equal(rows.length, 10)
  assert.equal(by.get('https://old.test/').status_on_new, 'same-path-200')
  assert.equal(by.get('https://old.test/services/botox').status_on_new, 'would-404')
  assert.match(by.get('https://old.test/services/botox').recommendation, /\/treatments\/botox/)
  assert.equal(by.get('https://old.test/about-us').status_on_new, 'redirect-200')
  assert.equal(by.get('https://old.test/about-us').final_url, 'https://new.test/about')
  assert.equal(by.get('https://old.test/gone-forever').status_on_new, 'redirect-to-404')
  assert.equal(by.get('https://old.test/legacy-a').final_url, 'https://new.test/')
  // The category says what to do about the url; new_status says what the server actually answered.
  assert.equal(by.get('https://old.test/').new_status, 200)
  assert.equal(by.get('https://old.test/services/botox').new_status, 404)
  assert.equal(by.get('https://old.test/gone-forever').new_status, 404)
})

test('redirectMap calls an old url it never probed unknown, rather than guessing', () => {
  const oldCrawl = { pages: [{ url: 'https://old.test/never', status: 200 }] }
  const rows = redirectMap(oldCrawl, { oldPaths: new Map() }, 'https://new.test', ['/'])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status_on_new, 'unknown')
  assert.equal(rows[0].confidence, null)
  assert.equal(rows[0].new_status, null)
})

test('redirectMap recommends deciding by hand when nothing on the new site matches', async () => {
  const ctx = await ctxFor('recorded/redirects-new-site.json', cutover('cutover-bad'))
  const rows = redirectMap(ctx.oldCrawl, ctx.probes, ctx.target.origin, ['/quite/different'])
  const row = rows.find((r) => r.old_url === 'https://old.test/services/botox')
  assert.equal(row.recommendation, 'no match — decide manually')
  assert.equal(row.confidence, null)
})

test('toCsv writes the agreed header and quotes what RFC 4180 says to quote', () => {
  const csv = toCsv([
    { old_url: 'https://old.test/a', status_on_new: 'would-404', final_url: 'https://new.test/a', recommendation: 'redirect to /b, probably', confidence: 0.42, new_status: 404 },
    { old_url: 'https://old.test/b', status_on_new: 'unknown', final_url: '', recommendation: 'say "no"', confidence: null, new_status: null },
  ])
  const lines = csv.split('\r\n')
  assert.equal(lines[0], 'old_url,status_on_new,final_url,recommendation,confidence,new_status')
  assert.equal(lines[1], 'https://old.test/a,would-404,https://new.test/a,"redirect to /b, probably",0.42,404')
  assert.equal(lines[2], 'https://old.test/b,unknown,,"say ""no""",,')
  assert.equal(lines[3], '')
})

test('redirectsCsv renders the whole map, and says nothing when there is no old site', async () => {
  const ctx = await ctxFor('recorded/redirects-new-site.json', cutover('cutover-bad'))
  const csv = redirectsCsv(ctx)
  assert.match(csv, /^old_url,status_on_new,final_url,recommendation,confidence,new_status\r\n/)
  assert.match(csv, /https:\/\/old\.test\/services\/botox,would-404/)
  assert.match(csv, /treatments\/botox/)
  assert.equal(csv.trimEnd().split('\r\n').length, 11)
  const plain = await ctxFor('recorded/links-good-site.json', { url: 'https://good-links.test/' })
  assert.equal(redirectsCsv(plain), null)
})

// --------------------------------------------------------------------------------------- checks

test('redirects.would-404 reports every old url the new site has no page for', async () => {
  const found = of(await bad(), 'redirects.would-404')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'high')
  assert.equal(found[0].page, 'https://old.test/services/botox')
  assert.match(evidenceText(found[0]), /treatments\/botox/)
  assert.ok(!has(await good(), 'redirects.would-404'))
})

test('redirects.to-404 reports a redirect that lands on an error', async () => {
  const found = of(await bad(), 'redirects.to-404')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'high')
  assert.equal(found[0].page, 'https://old.test/gone-forever')
  assert.match(evidenceText(found[0]), /oops/)
  assert.ok(!has(await good(), 'redirects.to-404'))
})

test('redirects.chain reports more than one hop, and leaves a single hop alone', async () => {
  const found = of(await bad(), 'redirects.chain')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  assert.equal(found[0].page, 'https://old.test/about-us')
  assert.match(evidenceText(found[0]), /2 hops/)
  assert.ok(!allEvidence(found).includes('legacy-a'))
  assert.ok(!has(await good(), 'redirects.chain'))
})

test('redirects.wildcard-smell fires when six of ten old urls land on one page', async () => {
  const found = of(await bad(), 'redirects.wildcard-smell')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'medium')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /60%|6 of 10/)
  assert.match(evidence, /https:\/\/new\.test\//)
  assert.ok(!has(await good(), 'redirects.wildcard-smell'))
})

test('a server error on the new site is its own finding, and never a 404', async () => {
  const findings = await run('redirects-new-site.json', {
    ...cutover('cutover-500'),
    records: {
      ...OLD_SITE(),
      'https://new.test/services/botox': { status: 500, headers: { 'content-type': 'text/html' }, body: '<h1>Server error</h1>' },
    },
  })
  const found = of(findings, 'redirects.new-site-error')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'high')
  assert.equal(found[0].page, 'https://old.test/services/botox')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /500/)
  assert.ok(!evidence.includes('404'))
  // The url is no longer reported as a missing page, because it is not one.
  assert.ok(!has(findings, 'redirects.would-404'))
  assert.ok(!has(await good(), 'redirects.new-site-error'))
  assert.ok(!has(await bad(), 'redirects.new-site-error'))
})

test('a 410 is still a gone page, and the evidence carries the status the server gave', async () => {
  const findings = await run('redirects-new-site.json', {
    ...cutover('cutover-410'),
    records: {
      ...OLD_SITE(),
      'https://new.test/services/botox': { status: 410, headers: { 'content-type': 'text/html' }, body: '<h1>Gone</h1>' },
    },
  })
  const found = of(findings, 'redirects.would-404')
  assert.equal(found.length, 1)
  assert.match(evidenceText(found[0]), /410/)
  assert.ok(!has(findings, 'redirects.new-site-error'))
  // The plain 404 case is unchanged.
  assert.match(evidenceText(of(await bad(), 'redirects.would-404')[0]), /404/)
})

test('redirects.summary counts every old url by what the new site does with it', async () => {
  const found = of(await bad(), 'redirects.summary')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'info')
  const evidence = evidenceText(found[0])
  assert.match(evidence, /same-path-200/)
  assert.match(evidence, /redirect-200/)
  assert.match(evidence, /would-404/)
  assert.ok(!has(await noOldUrl(), 'redirects.summary'))
})

test('redirects.old-url-same-origin fires when the old url is the site being audited', async () => {
  const findings = await run('redirects-new-site.json', {
    url: 'https://new.test/',
    oldUrl: 'https://new.test/',
    records: OLD_SITE(),
    cacheTag: 'cutover-same-origin',
  })
  assert.deepEqual(findings.map((f) => f.id), ['redirects.old-url-same-origin'])
  assert.equal(findings[0].severity, 'info')
  assert.match(findings[0].detail, /same site/)
  // Neither the "no old site" finding nor the map is produced.
  assert.ok(!has(findings, 'redirects.old-url-required'))
  assert.ok(!has(findings, 'redirects.summary'))
  assert.ok(!has(await bad(), 'redirects.old-url-same-origin'))
  assert.ok(!has(await noOldUrl(), 'redirects.old-url-same-origin'))
})

test('redirects.old-url-required is the only thing said when no old site was given', async () => {
  const findings = await noOldUrl()
  assert.deepEqual(findings.map((f) => f.id), ['redirects.old-url-required'])
  assert.equal(findings[0].severity, 'info')
  assert.match(findings[0].fix, /--old-url/)
  assert.match(findings[0].detail, /replaces one that is already live/)
  assert.ok(!has(await bad(), 'redirects.old-url-required'))
})
