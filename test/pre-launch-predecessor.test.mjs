// Predecessor coverage: the part of the gate that decides whether a domain move will take its
// rankings with it.
//
// The live sitemap of the site being replaced is the source of truth, and it is the one thing the
// gate fetches. Every test here injects a `net`, because a check that fails closed on an
// unreachable child sitemap has to be provable without an unreachable server.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { checks } from '../skills/pre-launch/scripts/lib/predecessor.mjs'
import { PASSING, FAILING, fakeNet, copyFixture } from './pre-launch-helpers.mjs'
import { ctxFor, group, assertStatus } from './pre-launch-check-helpers.mjs'
import { fixturePath } from './helpers.mjs'

const sitemap = (name) => readFileSync(fixturePath(`sitemaps/${name}`), 'utf8')

const OLD = 'https://old.test'
const ROBOTS = { status: 200, headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nAllow: /\nSitemap: https://old.test/sitemap.xml\n' }

const netWith = (body) => fakeNet({
  'https://old.test/robots.txt': ROBOTS,
  'https://old.test/sitemap.xml': { status: 200, headers: { 'content-type': 'application/xml' }, body },
})

const ALL = ['predecessor.coverage', 'predecessor.wildcard-redirects', 'predecessor.redirect-chains']

test('with no --predecessor-url all three skip with the same named reason', async () => {
  const map = await group(checks, await ctxFor(PASSING))
  for (const id of ALL) {
    const found = assertStatus(map, id, 'skip', assert)
    assert.match(found.detail, /--predecessor-url/)
  }
})

test('an old path that exists at the same path, or has an explicit redirect, is covered', async () => {
  const ctx = await ctxFor(PASSING, { predecessorUrl: OLD, net: netWith(sitemap('predecessor-covered.xml')) })
  const map = await group(checks, ctx)
  assertStatus(map, 'predecessor.coverage', 'pass', assert)
  assertStatus(map, 'predecessor.wildcard-redirects', 'pass', assert)
  assertStatus(map, 'predecessor.redirect-chains', 'pass', assert)
})

test('leftover old paths fail, one per evidence line', async () => {
  const ctx = await ctxFor(FAILING, { predecessorUrl: OLD, net: netWith(sitemap('predecessor.xml')) })
  const map = await group(checks, ctx)
  const found = assertStatus(map, 'predecessor.coverage', 'fail', assert)
  const values = found.evidence.map((e) => e.value)
  assert.ok(values.some((v) => v.includes('/gone-forever')), JSON.stringify(values))
  assert.ok(values.some((v) => v.includes('/legacy/pricing')))
  assert.equal(values.some((v) => v.includes('/about')), false, '/about resolves in the build')
})

test('a wildcard redirect covering old content paths fails with the rule quoted', async () => {
  const ctx = await ctxFor(FAILING, { predecessorUrl: OLD, net: netWith(sitemap('predecessor.xml')) })
  const map = await group(checks, ctx)
  const found = assertStatus(map, 'predecessor.wildcard-redirects', 'fail', assert)
  const text = found.evidence.map((e) => e.value).join(' | ')
  assert.match(text, /\/legacy\/:path\*/)
  assert.match(text, /\/legacy\/pricing/)
})

test('a redirect chain fails, with every hop named', async () => {
  const ctx = await ctxFor(FAILING, { predecessorUrl: OLD, net: netWith(sitemap('predecessor.xml')) })
  const map = await group(checks, ctx)
  const found = assertStatus(map, 'predecessor.redirect-chains', 'fail', assert)
  const text = found.evidence.map((e) => e.value).join(' | ')
  assert.match(text, /\/old-team -> \/team -> \/about/)
  assert.match(text, /2 hops/)
})

test('a redirect cycle fails as a cycle, not as a long chain', async () => {
  const { dir, cleanup } = copyFixture(PASSING, 'redirect-cycle')
  try {
    const { writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    writeFileSync(join(dir, 'vercel.json'), JSON.stringify({
      redirects: [
        { source: '/a', destination: '/b', permanent: true },
        { source: '/b', destination: '/a', permanent: true },
      ],
    }, null, 2))
    const ctx = await ctxFor(dir, { predecessorUrl: OLD, net: netWith(sitemap('predecessor-covered.xml')) })
    const map = await group(checks, ctx)
    const found = assertStatus(map, 'predecessor.redirect-chains', 'fail', assert)
    const text = found.evidence.map((e) => e.value).join(' | ')
    assert.match(text, /\/a -> \/b -> \/a is a loop and serves nothing/)
    assert.match(text, /\/b -> \/a -> \/b is a loop and serves nothing/)
  } finally { cleanup() }
})

test('a query-conditional vercel rule on / is not a hop: /old -> / is one hop, not a chain', async () => {
  const { dir, cleanup } = copyFixture(PASSING, 'conditional-redirect')
  try {
    const { writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    writeFileSync(join(dir, 'vercel.json'), JSON.stringify({
      redirects: [
        { source: '/old', destination: '/', statusCode: 301 },
        // WordPress shortlink: only /?p=10 redirects, never the home page itself
        { source: '/', has: [{ type: 'query', key: 'p', value: '^10$' }], destination: '/blog/', statusCode: 301 },
      ],
    }, null, 2))
    const ctx = await ctxFor(dir, { predecessorUrl: OLD, net: netWith(sitemap('predecessor-covered.xml')) })
    const map = await group(checks, ctx)
    assertStatus(map, 'predecessor.redirect-chains', 'pass', assert)
  } finally { cleanup() }
})

test('an unfetchable child sitemap fails closed and names the child', async () => {
  const index = '<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://old.test/sitemap-posts.xml</loc></sitemap></sitemapindex>'
  const net = fakeNet({
    'https://old.test/robots.txt': ROBOTS,
    'https://old.test/sitemap.xml': { status: 200, headers: { 'content-type': 'application/xml' }, body: index },
    'https://old.test/sitemap-posts.xml': { status: 503, body: null },
  })
  const map = await group(checks, await ctxFor(PASSING, { predecessorUrl: OLD, net }))
  const found = assertStatus(map, 'predecessor.coverage', 'fail', assert)
  assert.match(found.evidence.map((e) => e.value).join(' '), /sitemap-posts\.xml/)
})

test('no sitemap at all on the predecessor fails rather than reporting full coverage', async () => {
  const net = fakeNet({ 'https://old.test/robots.txt': { status: 404, body: null } })
  const map = await group(checks, await ctxFor(PASSING, { predecessorUrl: OLD, net }))
  const found = assertStatus(map, 'predecessor.coverage', 'fail', assert)
  assert.match(found.detail, /sitemap/i)
})

// From the astro-conversion-kit fixture run: a static host needs one rule that adds (or removes)
// the trailing slash on every path, and that rule is written as a catch-all. It sends `/about` to
// `/about/`, the same page, so it hides no missing coverage and is not the wildcard this check is
// for. It is counted under Not covered, and a real catch-all beside it still fails.
const SLASH_SITEMAP = () => sitemap('predecessor-covered.xml')

test('the vercel.json trailing-slash rule is a slash rule, not a wildcard over content', async () => {
  const { dir, cleanup } = copyFixture(PASSING, 'vercel-slash-rule')
  try {
    const { writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    writeFileSync(join(dir, 'vercel.json'), JSON.stringify({
      redirects: [
        { source: '/old-about', destination: '/about', permanent: true },
        { source: '/:path((?:.*[^/]))', destination: '/:path/', statusCode: 308 },
      ],
    }, null, 2))
    const ctx = await ctxFor(dir, { predecessorUrl: OLD, net: netWith(SLASH_SITEMAP()) })
    const map = await group(checks, ctx)
    const found = assertStatus(map, 'predecessor.wildcard-redirects', 'pass', assert)
    assert.match(found.notCovered.join(' | '), /predecessor\.wildcard-redirects: 1 trailing-slash rule/)
  } finally { cleanup() }
})

test('the _redirects trailing-slash rules are slash rules, and a real catch-all beside them still fails', async () => {
  const { dir, cleanup } = copyFixture(PASSING, 'plain-slash-rule')
  try {
    const { writeFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    rmSync(join(dir, 'vercel.json'))
    writeFileSync(join(dir, '_redirects'), [
      '/old-about  /about  301',
      '/*/  /:splat  308',
      '/*  /:splat/  308',
    ].join('\n') + '\n')
    const clean = await group(checks, await ctxFor(dir, { predecessorUrl: OLD, net: netWith(SLASH_SITEMAP()) }))
    const found = assertStatus(clean, 'predecessor.wildcard-redirects', 'pass', assert)
    assert.match(found.notCovered.join(' | '), /2 trailing-slash rules/)

    writeFileSync(join(dir, '_redirects'), [
      '/legacy/*  /new/  301',
      '/*  /:splat/  308',
    ].join('\n') + '\n')
    const old = '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://old.test/</loc></url><url><loc>https://old.test/legacy/pricing</loc></url></urlset>'
    const dirty = await group(checks, await ctxFor(dir, { predecessorUrl: OLD, net: netWith(old) }))
    const failed = assertStatus(dirty, 'predecessor.wildcard-redirects', 'fail', assert)
    const text = failed.evidence.map((e) => e.value).join(' | ')
    assert.match(text, /\/legacy\/\* -> \/new\//)
    assert.equal(text.includes(':splat/'), false, `the slash rule is not quoted as a wildcard: ${text}`)
  } finally { cleanup() }
})

// Also from the kit run: `/about -> /about/` was read as a loop, because the chain walk compares
// normalised paths and normalising strips the slash. A rule that only adds or removes the trailing
// slash leads to the same page; it is neither a hop in a chain nor a loop.
test('a redirect that only adds or removes the trailing slash is not a chain or a loop', async () => {
  const { dir, cleanup } = copyFixture(PASSING, 'slash-redirect')
  try {
    const { writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    writeFileSync(join(dir, 'vercel.json'), JSON.stringify({
      redirects: [
        { source: '/about', destination: '/about/', statusCode: 308 },
        { source: '/contact/', destination: '/contact', statusCode: 308 },
        { source: '/old-about', destination: '/about', permanent: true },
      ],
    }, null, 2))
    const ctx = await ctxFor(dir, { predecessorUrl: OLD, net: netWith(sitemap('predecessor-covered.xml')) })
    const map = await group(checks, ctx)
    assertStatus(map, 'predecessor.redirect-chains', 'pass', assert)
  } finally { cleanup() }
})

// The other side of the same rule: a slash redirect sends an old url to itself, so it is not a
// destination for it. An old page the build does not have is still uncovered.
test('a slash redirect does not count as coverage for an old url the build does not have', async () => {
  const { dir, cleanup } = copyFixture(PASSING, 'slash-not-coverage')
  try {
    const { writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    writeFileSync(join(dir, 'vercel.json'), JSON.stringify({
      redirects: [
        { source: '/old-about', destination: '/about', permanent: true },
        { source: '/contact', destination: '/contact/', statusCode: 308 },
        { source: '/pricing', destination: '/pricing/', statusCode: 308 },
      ],
    }, null, 2))
    const old = '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://old.test/contact</loc></url><url><loc>https://old.test/pricing</loc></url></urlset>'
    const map = await group(checks, await ctxFor(dir, { predecessorUrl: OLD, net: netWith(old) }))
    const found = assertStatus(map, 'predecessor.coverage', 'fail', assert)
    const values = found.evidence.map((e) => e.value).join(' | ')
    assert.match(values, /\/pricing has no destination/)
    assert.equal(values.includes('/contact'), false, '/contact is in the build')
  } finally { cleanup() }
})
