import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checks } from '../skills/launch-audit/scripts/lib/checks/indexability.mjs'
import { findingsFor, has, of, allEvidence, evidenceText } from './checks-helpers.mjs'

const run = (fixture, options) => findingsFor(checks, `recorded/${fixture}`, options)
const GOOD = ['https-site.json', { url: 'https://good.test/' }]
const good = () => run(...GOOD)

test('every check is registrable, http-tier, and in the indexability dimension', () => {
  assert.ok(checks.length > 0)
  for (const check of checks) {
    assert.equal(check.phase, 'launch-audit')
    assert.equal(check.dimension, 'indexability')
    assert.ok(check.id.startsWith('indexability.'))
    assert.equal(typeof check.run, 'function')
    assert.ok(check.title && check.catches)
  }
  assert.equal(new Set(checks.map((c) => c.id)).size, checks.length)
})

test('indexability.site-noindex blocks on a noindexed home page', async () => {
  const found = of(await run('noindex-site.json', { url: 'https://noindex.test/' }), 'indexability.site-noindex')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'blocker')
  assert.match(evidenceText(found[0]), /noindex/i)
  assert.ok(!has(await good(), 'indexability.site-noindex'))
})

test('indexability.site-noindex also fires when robots.txt disallows everything', async () => {
  const found = of(await run('https-site.json', {
    url: 'https://good.test/',
    cacheTag: 'disallow-all',
    records: {
      'https://good.test/robots.txt': { status: 200, headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /\n' },
    },
  }), 'indexability.site-noindex')
  assert.equal(found.length, 1)
  assert.match(evidenceText(found[0]), /Disallow: \//)
})

test('indexability.site-noindex is downgraded to info on a staging target', async () => {
  const staging = of(await run('noindex-site.json', { url: 'https://noindex.test/', staging: true }), 'indexability.site-noindex')
  assert.equal(staging.length, 1)
  assert.equal(staging[0].severity, 'info')
  const production = of(await run('noindex-site.json', { url: 'https://noindex.test/' }), 'indexability.site-noindex')
  assert.equal(production[0].severity, 'blocker')
})

test('indexability.page-noindex-in-sitemap names the noindexed sitemap page', async () => {
  const found = of(await run('sitemap-site.json', { url: 'https://sm.test/' }), 'indexability.page-noindex-in-sitemap')
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://sm.test/noindexed')
  assert.match(evidenceText(found[0]), /noindex/)
  assert.ok(!has(await good(), 'indexability.page-noindex-in-sitemap'))
})

test('indexability.nosnippet-unintended reports each page that suppresses snippets', async () => {
  const found = of(await run('noindex-site.json', { url: 'https://noindex.test/' }), 'indexability.nosnippet-unintended')
  assert.ok(found.some((f) => f.page === 'https://noindex.test/about'))
  assert.equal(found[0].severity, 'low')
  assert.ok(!has(await good(), 'indexability.nosnippet-unintended'))
})

test('indexability.robots-unfetchable fires on a 5xx robots.txt', async () => {
  const found = of(await run('http-only-site.json', { url: 'http://plain.test/' }), 'indexability.robots-unfetchable')
  assert.equal(found.length, 1)
  assert.match(evidenceText(found[0]), /503/)
  assert.ok(!has(await good(), 'indexability.robots-unfetchable'))
})

test('indexability.robots-sitemap-line-missing fires when robots.txt names no sitemap', async () => {
  const found = of(await run('noindex-site.json', { url: 'https://noindex.test/' }), 'indexability.robots-sitemap-line-missing')
  assert.equal(found.length, 1)
  assert.match(evidenceText(found[0]), /robots\.txt/)
  assert.ok(!has(await good(), 'indexability.robots-sitemap-line-missing'))
})

test('indexability.robots-sitemap-other-host fires on a cross-host Sitemap line', async () => {
  const found = of(await run('sitemap-site.json', { url: 'https://sm.test/' }), 'indexability.robots-sitemap-other-host')
  assert.equal(found.length, 1)
  assert.match(evidenceText(found[0]), /other\.test/)
  assert.ok(!has(await good(), 'indexability.robots-sitemap-other-host'))
})

test('indexability.robots-blocks-assets lists the blocked asset paths', async () => {
  const found = of(await run('noindex-site.json', { url: 'https://noindex.test/' }), 'indexability.robots-blocks-assets')
  assert.equal(found.length, 1)
  assert.match(evidenceText(found[0]), /a\.css/)
  assert.ok(!has(await run('sitemap-site.json', { url: 'https://sm.test/' }), 'indexability.robots-blocks-assets'))
})

test('indexability.ai-crawler-policy always reports one row per known AI crawler', async () => {
  const blocked = of(await run('noindex-site.json', { url: 'https://noindex.test/' }), 'indexability.ai-crawler-policy')
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0].severity, 'info')
  assert.equal(blocked[0].evidence.length, 12)
  assert.ok(blocked[0].evidence.some((e) => /^GPTBot\b.*: blocked$/.test(e.value)))
  const allowed = of(await good(), 'indexability.ai-crawler-policy')
  assert.equal(allowed.length, 1)
  assert.ok(allowed[0].evidence.some((e) => /^GPTBot\b.*: allowed$/.test(e.value)))
})

test('indexability.sitemap-missing fires when no sitemap is discoverable', async () => {
  const found = of(await run('noindex-site.json', { url: 'https://noindex.test/' }), 'indexability.sitemap-missing')
  assert.equal(found.length, 1)
  assert.match(evidenceText(found[0]), /sitemap\.xml/)
  assert.ok(!has(await good(), 'indexability.sitemap-missing'))
})

test('indexability.sitemap-invalid fires when a child sitemap does not parse', async () => {
  const found = of(await run('sitemap-site.json', { url: 'https://sm.test/' }), 'indexability.sitemap-invalid')
  assert.equal(found.length, 1)
  assert.match(evidenceText(found[0]), /sitemap-bad\.xml/)
  assert.ok(!has(await good(), 'indexability.sitemap-invalid'))
})

test('indexability.sitemap-too-large fires past 50,000 urls', async () => {
  const locs = Array.from({ length: 50_001 }, (_, i) => `<url><loc>https://good.test/p/${i}</loc></url>`).join('\n')
  const found = of(await run('https-site.json', {
    url: 'https://good.test/',
    maxPages: 1,
    cacheTag: 'huge-sitemap',
    records: {
      'https://good.test/sitemap.xml': {
        status: 200,
        headers: { 'content-type': 'application/xml' },
        body: `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs}\n</urlset>`,
      },
    },
  }), 'indexability.sitemap-too-large')
  assert.equal(found.length, 1)
  assert.match(evidenceText(found[0]), /50001|50,001/)
  assert.ok(!has(await good(), 'indexability.sitemap-too-large'))
})

test('indexability.sitemap-url-not-200 names the dead sitemap url', async () => {
  const found = of(await run('sitemap-site.json', { url: 'https://sm.test/' }), 'indexability.sitemap-url-not-200')
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://sm.test/gone')
  assert.match(evidenceText(found[0]), /404/)
  assert.ok(!has(await good(), 'indexability.sitemap-url-not-200'))
})

test('indexability.sitemap-noindexed-url covers header noindex and robots-disallowed urls', async () => {
  const found = of(await run('sitemap-site.json', { url: 'https://sm.test/' }), 'indexability.sitemap-noindexed-url')
  const pages = found.map((f) => f.page).sort()
  assert.deepEqual(pages, ['https://sm.test/blocked', 'https://sm.test/hdr-noindex'])
  assert.match(allEvidence(found), /x-robots-tag/i)
  assert.ok(!has(await good(), 'indexability.sitemap-noindexed-url'))
})

test('indexability.sitemap-other-host fires on an off-origin loc', async () => {
  const found = of(await run('sitemap-site.json', { url: 'https://sm.test/' }), 'indexability.sitemap-other-host')
  assert.equal(found.length, 1)
  assert.match(evidenceText(found[0]), /other\.test/)
  assert.ok(!has(await good(), 'indexability.sitemap-other-host'))
})

test('indexability.sitemap-lastmod-future fires on a lastmod after now', async () => {
  const found = of(await run('sitemap-site.json', { url: 'https://sm.test/' }), 'indexability.sitemap-lastmod-future')
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://sm.test/future')
  assert.match(evidenceText(found[0]), /2099/)
  assert.ok(!has(await good(), 'indexability.sitemap-lastmod-future'))
})

test('indexability.canonical-missing names the page without a canonical', async () => {
  const found = of(await run('canonical-site.json', { url: 'https://canon.test/' }), 'indexability.canonical-missing')
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://canon.test/nocanon')
  assert.ok(!has(await good(), 'indexability.canonical-missing'))
})

test('indexability.canonical-relative fires on a path-only canonical href', async () => {
  const found = of(await run('canonical-site.json', { url: 'https://canon.test/' }), 'indexability.canonical-relative')
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://canon.test/rel')
  assert.match(evidenceText(found[0]), /href="\/rel"/)
  assert.ok(!has(await good(), 'indexability.canonical-relative'))
})

test('indexability.canonical-other-host fires on a canonical pointing off-site', async () => {
  const found = of(await run('canonical-site.json', { url: 'https://canon.test/' }), 'indexability.canonical-other-host')
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://canon.test/other')
  assert.match(evidenceText(found[0]), /elsewhere\.test/)
  assert.ok(!has(await good(), 'indexability.canonical-other-host'))
})

test('indexability.canonical-to-redirect-or-404 fires when the canonical target redirects', async () => {
  const found = of(await run('canonical-site.json', { url: 'https://canon.test/' }), 'indexability.canonical-to-redirect-or-404')
  assert.deepEqual(found.map((f) => f.page).sort(), ['https://canon.test/legacy', 'https://canon.test/toredirect'])
  assert.match(evidenceText(found.find((f) => f.page === 'https://canon.test/toredirect')), /\/moved/)
  // /legacy canonicalizes to /blog, and /blog is itself the redirect source.
  assert.match(evidenceText(found.find((f) => f.page === 'https://canon.test/legacy')), /canon\.test\/blog/)
  assert.ok(!has(await good(), 'indexability.canonical-to-redirect-or-404'))
})

test('indexability.canonical-to-redirect-or-404 leaves a canonical the crawl reached through a redirect alone', async () => {
  // The crawl found /blog/ by following /blog → /blog/. A page canonicalizing to /blog/ names the
  // url that actually serves the content, and the chain on that crawl entry describes how the
  // crawl got there, not the canonical.
  const found = of(await run('canonical-site.json', { url: 'https://canon.test/' }), 'indexability.canonical-to-redirect-or-404')
  assert.ok(!found.some((f) => f.page === 'https://canon.test/blog?page=2'))
})

test('indexability.canonical-multiple fires on two canonical tags', async () => {
  const found = of(await run('canonical-site.json', { url: 'https://canon.test/' }), 'indexability.canonical-multiple')
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://canon.test/')
  assert.match(evidenceText(found[0]), /2/)
  assert.ok(!has(await good(), 'indexability.canonical-multiple'))
})

test('indexability.canonical-header-mismatch compares the Link header with the tag', async () => {
  const found = of(await run('canonical-site.json', { url: 'https://canon.test/' }), 'indexability.canonical-header-mismatch')
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://canon.test/hdrmismatch')
  assert.match(evidenceText(found[0]), /different/)
  assert.ok(!has(await good(), 'indexability.canonical-header-mismatch'))
})

test('indexability.hreflang-invalid fires on a malformed language code', async () => {
  const found = of(await run('hreflang-site.json', { url: 'https://hl.test/' }), 'indexability.hreflang-invalid')
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://hl.test/')
  assert.match(evidenceText(found[0]), /en_US/)
  assert.ok(!has(await good(), 'indexability.hreflang-invalid'))
})

test('indexability.hreflang-not-reciprocal fires when the alternate does not point back', async () => {
  const found = of(await run('hreflang-site.json', { url: 'https://hl.test/' }), 'indexability.hreflang-not-reciprocal')
  assert.equal(found.length, 1)
  assert.equal(found[0].page, 'https://hl.test/')
  assert.match(evidenceText(found[0]), /hl\.test\/de/)
  assert.ok(!has(await good(), 'indexability.hreflang-not-reciprocal'))
})

test('indexability.hreflang-no-x-default fires once for the whole site', async () => {
  const found = of(await run('hreflang-site.json', { url: 'https://hl.test/' }), 'indexability.hreflang-no-x-default')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'low')
  assert.ok(!has(await good(), 'indexability.hreflang-no-x-default'))
})

test('indexability.llms-txt reports present, malformed and absent', async () => {
  const present = of(await good(), 'indexability.llms-txt')
  assert.equal(present.length, 1)
  assert.equal(present[0].severity, 'info')
  assert.match(present[0].title, /present/i)
  assert.doesNotMatch(present[0].title, /malformed/i)

  const malformed = of(await run('bad-headers-site.json', { url: 'https://bare.test/' }), 'indexability.llms-txt')
  assert.equal(malformed.length, 1)
  assert.match(malformed[0].title, /malformed/i)

  const absent = of(await run('noindex-site.json', { url: 'https://noindex.test/' }), 'indexability.llms-txt')
  assert.equal(absent.length, 1)
  assert.match(absent[0].title, /absent|no llms\.txt/i)
})
