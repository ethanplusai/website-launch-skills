import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFixture } from './helpers.mjs'
import { parseRobots, isAllowed, AI_CRAWLERS, aiPolicy, blocksAssets } from '../skills/launch-audit/scripts/lib/robots.mjs'

const load = (name) => readFixture(`robots/${name}`)

// --- parseRobots grouping and directive handling ---

test('consecutive User-agent lines share one group', () => {
  const robots = parseRobots('User-agent: A\nUser-agent: B\nDisallow: /x\n')
  assert.equal(robots.groups.length, 1)
  assert.deepEqual(robots.groups[0].agents, ['A', 'B'])
  assert.deepEqual(robots.groups[0].disallow, ['/x'])
})

test('a rule line between User-agent blocks starts a new group', () => {
  const robots = parseRobots('User-agent: A\nDisallow: /a\nUser-agent: B\nDisallow: /b\n')
  assert.equal(robots.groups.length, 2)
  assert.deepEqual(robots.groups[0].agents, ['A'])
  assert.deepEqual(robots.groups[1].agents, ['B'])
})

test('Allow/Disallow with an empty value are ignored', () => {
  const robots = parseRobots(load('allow-all.txt'))
  assert.equal(robots.groups.length, 1)
  assert.deepEqual(robots.groups[0].allow, [])
  assert.deepEqual(robots.groups[0].disallow, [])
})

test('comments are stripped, including inline comments after a value', () => {
  const robots = parseRobots('# top comment\nUser-agent: *\nDisallow: /secret # trailing comment\n')
  assert.deepEqual(robots.groups[0].disallow, ['/secret'])
})

test('unknown directives and Crawl-delay are ignored without erroring', () => {
  const robots = parseRobots('User-agent: *\nCrawl-delay: 10\nHost: example.com\nDisallow: /x\n')
  assert.deepEqual(robots.groups[0].disallow, ['/x'])
  assert.deepEqual(robots.errors, [])
})

test('Sitemap lines are collected globally; absolute URLs only, relative ones are errors', () => {
  const robots = parseRobots('User-agent: *\nDisallow:\nSitemap: https://example.com/sitemap.xml\nSitemap: /relative-sitemap.xml\n')
  assert.deepEqual(robots.sitemaps, ['https://example.com/sitemap.xml'])
  assert.equal(robots.errors.length, 1)
  assert.match(robots.errors[0], /relative-sitemap\.xml/)
})

test('ai-mixed.txt fixture parses its Sitemap line', () => {
  const robots = parseRobots(load('ai-mixed.txt'))
  assert.deepEqual(robots.sitemaps, ['https://example.com/sitemap.xml'])
})

// --- isAllowed ---

test('disallow-all.txt blocks every path for every agent', () => {
  const robots = parseRobots(load('disallow-all.txt'))
  assert.equal(isAllowed(robots, 'AnyBot/1.0', '/'), false)
  assert.equal(isAllowed(robots, 'AnyBot/1.0', '/anything/deep'), false)
})

test('allow-all.txt allows every path', () => {
  const robots = parseRobots(load('allow-all.txt'))
  assert.equal(isAllowed(robots, 'AnyBot/1.0', '/'), true)
  assert.equal(isAllowed(robots, 'AnyBot/1.0', '/anything'), true)
})

test('a longer Allow rule beats a shorter Disallow rule', () => {
  const robots = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/public\n')
  assert.equal(isAllowed(robots, 'Bot', '/private/public/page'), true)
  assert.equal(isAllowed(robots, 'Bot', '/private/secret'), false)
})

test('equal-length Allow and Disallow: Allow wins', () => {
  const robots = parseRobots('User-agent: *\nDisallow: /x\nAllow: /x\n')
  assert.equal(isAllowed(robots, 'Bot', '/x'), true)
})

test('wildcard * matches any run of characters mid-pattern', () => {
  const robots = parseRobots('User-agent: *\nDisallow: /*.pdf\n')
  assert.equal(isAllowed(robots, 'Bot', '/reports/q1.pdf'), false)
  assert.equal(isAllowed(robots, 'Bot', '/reports/q1.pdf.bak'), false) // no trailing $, prefix-style match still applies
  assert.equal(isAllowed(robots, 'Bot', '/reports/q1.txt'), true)
})

test('trailing $ anchors the end of the pattern', () => {
  const robots = parseRobots('User-agent: *\nDisallow: /*.pdf$\n')
  assert.equal(isAllowed(robots, 'Bot', '/reports/q1.pdf'), false)
  assert.equal(isAllowed(robots, 'Bot', '/reports/q1.pdf.bak'), true)
})

test('a Disallow of "/" blocks everything for its group', () => {
  const robots = parseRobots('User-agent: *\nDisallow: /\n')
  assert.equal(isAllowed(robots, 'Bot', '/anything?query=1'), false)
})

test('matching is against path + query', () => {
  const robots = parseRobots('User-agent: *\nDisallow: /search?*\n')
  assert.equal(isAllowed(robots, 'Bot', '/search?q=x'), false)
  assert.equal(isAllowed(robots, 'Bot', '/search'), true)
})

test('per-agent groups: the most specific matching agent token wins over *', () => {
  const robots = parseRobots(load('ai-mixed.txt'))
  assert.equal(isAllowed(robots, 'GPTBot/1.1', '/'), false)
  assert.equal(isAllowed(robots, 'Mozilla/5.0 ClaudeBot compatible', '/'), false)
  assert.equal(isAllowed(robots, 'Claude-SearchBot/1.0', '/'), true)
  // an unmentioned agent falls to the * group
  assert.equal(isAllowed(robots, 'RandomCrawler/1.0', '/'), true)
  assert.equal(isAllowed(robots, 'RandomCrawler/1.0', '/private/page'), false)
})

test('no matching group and no * group defaults to allow', () => {
  const robots = parseRobots('User-agent: OnlyThisBot\nDisallow: /\n')
  assert.equal(isAllowed(robots, 'SomeOtherBot', '/anything'), true)
})

// --- AI crawler policy table ---

test('AI_CRAWLERS has exactly 12 entries in the documented order', () => {
  assert.equal(AI_CRAWLERS.length, 12)
  assert.deepEqual(AI_CRAWLERS.map((c) => c.ua), [
    'GPTBot', 'ChatGPT-User', 'OAI-SearchBot',
    'ClaudeBot', 'Claude-User', 'Claude-SearchBot',
    'PerplexityBot', 'Perplexity-User',
    'Google-Extended', 'Applebot-Extended',
    'CCBot', 'Bytespider',
  ])
})

test('aiPolicy produces 12 rows shaped {ua, vendor, purpose, allowed} with correct allowed', () => {
  const robots = parseRobots(load('ai-mixed.txt'))
  const rows = aiPolicy(robots)
  assert.equal(rows.length, 12)
  const byUa = Object.fromEntries(rows.map((r) => [r.ua, r]))
  assert.equal(byUa['GPTBot'].allowed, false)
  assert.equal(byUa['GPTBot'].vendor, 'OpenAI')
  assert.equal(byUa['GPTBot'].purpose, 'training')
  assert.equal(byUa['ClaudeBot'].allowed, false)
  assert.equal(byUa['Google-Extended'].allowed, false)
  assert.equal(byUa['CCBot'].allowed, false)
  assert.equal(byUa['Bytespider'].allowed, false)
  assert.equal(byUa['Claude-SearchBot'].allowed, true)
  assert.equal(byUa['PerplexityBot'].allowed, true)
  // not mentioned in the fixture at all -> falls through to the * group, which only
  // disallows /private/, so the root path they're checked against (/) is allowed
  assert.equal(byUa['ChatGPT-User'].allowed, true)
  assert.equal(byUa['Applebot-Extended'].allowed, true)
})

test('aiPolicy on disallow-all.txt blocks every AI crawler', () => {
  const robots = parseRobots(load('disallow-all.txt'))
  const rows = aiPolicy(robots)
  assert.equal(rows.length, 12)
  assert.ok(rows.every((r) => r.allowed === false))
})

// --- blocksAssets ---

test('blocksAssets reports the candidate paths disallowed by blocks-assets.txt', () => {
  const robots = parseRobots(load('blocks-assets.txt'))
  const blocked = blocksAssets(robots)
  assert.deepEqual(blocked, ['/a.css', '/_astro/a.css', '/wp-content/a.css'])
})

test('blocksAssets is empty for allow-all.txt', () => {
  const robots = parseRobots(load('allow-all.txt'))
  assert.deepEqual(blocksAssets(robots), [])
})

test('blocksAssets accepts a ua parameter defaulting to *', () => {
  const robots = parseRobots('User-agent: GPTBot\nDisallow: /wp-content/\n')
  assert.deepEqual(blocksAssets(robots, 'GPTBot'), ['/wp-content/a.css'])
  assert.deepEqual(blocksAssets(robots, '*'), [])
})
