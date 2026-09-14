// The build output: sixteen checks over the files a person is about to upload.
//
// This is the stack-agnostic core of the gate — it reads HTML and bytes, and knows nothing about
// the generator that produced them. The two fixtures do the work: `passing-site` must trip none of
// these, and `failing-site` seeds exactly one instance of each failure so a check that silently
// stops firing is caught by its own absence.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checks } from '../skills/pre-launch/scripts/lib/output.mjs'
import { PASSING, FAILING, outsideRepoDir } from './pre-launch-helpers.mjs'
import { ctxFor, group, assertStatus } from './pre-launch-check-helpers.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ALL = [
  'output.index-html', 'output.404-page', 'output.internal-refs', 'output.favicon-set', 'output.og-image',
  'output.robots-txt', 'output.sitemap', 'output.llms-txt', 'output.noindex-utility-pages', 'output.canonical',
  'output.titles', 'output.descriptions', 'output.h1', 'output.lang', 'output.viewport', 'output.charset',
]

let passing
let failing
test('build both fixture contexts once', async () => {
  passing = await group(checks, await ctxFor(PASSING))
  failing = await group(checks, await ctxFor(FAILING))
  assert.equal(passing.size, ALL.length)
})

test('the passing fixture fails nothing in the output group', () => {
  for (const id of ALL) {
    const found = passing.get(id)
    assert.ok(found !== undefined, `${id} did not run`)
    assert.notEqual(found.status, 'fail', `${id} — ${found.detail}`)
  }
})

test('every output check fires on the failing fixture', () => {
  const notFiring = ALL.filter((id) => failing.get(id).status === 'pass')
  assert.deepEqual(notFiring, [], 'these checks found nothing in a fixture seeded for them')
})

test('a missing index.html at the root fails', () => {
  const found = assertStatus(failing, 'output.index-html', 'fail', assert)
  assert.match(found.detail, /index\.html/)
})

test('an indexable 404 page fails, and a 404 identical to the homepage fails', async () => {
  const found = assertStatus(failing, 'output.404-page', 'fail', assert)
  assert.match(found.detail, /noindex/)

  const { dir, cleanup } = outsideRepoDir('soft404')
  try {
    const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><title>Home</title></head><body><h1>Home</h1></body></html>'
    writeFileSync(join(dir, 'package.json'), '{}')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, 'dist', 'index.html'), html)
    writeFileSync(join(dir, 'dist', '404.html'), html)
    const map = await group(checks, await ctxFor(dir))
    const same = assertStatus(map, 'output.404-page', 'fail', assert)
    assert.match(same.detail, /identical|same/i)
  } finally { cleanup() }
})

test('an internal reference that resolves to nothing fails, in HTML and in CSS', () => {
  const found = assertStatus(failing, 'output.internal-refs', 'fail', assert)
  const values = found.evidence.map((e) => e.value).join(' | ')
  assert.match(values, /images\/missing\.png/)
  assert.match(values, /images\/hero-missing\.jpg/)
  assert.equal(/googletagmanager/.test(values), false, 'an external url is not an internal reference')
})

test('an incomplete favicon set fails and names each missing piece', () => {
  const found = assertStatus(failing, 'output.favicon-set', 'fail', assert)
  const values = found.evidence.map((e) => e.value).join(' | ')
  assert.match(values, /favicon\.ico/)
  assert.match(values, /apple-touch-icon\.png/)
})

test('a build with no og:image anywhere fails — a missing card is the failure, not an absence of work', async () => {
  const { dir, cleanup } = outsideRepoDir('no-og')
  try {
    const { mkdirSync } = await import('node:fs')
    writeFileSync(join(dir, 'package.json'), '{}')
    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, 'dist', 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>t</title></head><body><h1>h</h1></body></html>')
    const map = await group(checks, await ctxFor(dir))
    const found = assertStatus(map, 'output.og-image', 'fail', assert)
    assert.match(found.detail, /no og:image|declares an og:image/i)
    assert.ok(found.evidence.some((e) => e.value.includes('index.html')), JSON.stringify(found.evidence))
  } finally { cleanup() }
})

test('an og:image on another origin is declared as not verified rather than silently skipped', async () => {
  const { dir, cleanup } = outsideRepoDir('off-origin-og')
  try {
    const { mkdirSync } = await import('node:fs')
    writeFileSync(join(dir, 'package.json'), '{}')
    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, 'dist', 'index.html'), [
      '<!doctype html><html lang="en"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width"><title>t</title>',
      '<meta property="og:image" content="https://cdn.example.net/card.png">',
      '</head><body><h1>h</h1></body></html>',
    ].join(''))
    const map = await group(checks, await ctxFor(dir))
    const found = assertStatus(map, 'output.og-image', 'pass', assert)
    assert.deepEqual(found.notCovered, ['output.og-image: https://cdn.example.net/card.png is hosted off-origin — not verified'])
  } finally { cleanup() }
})

test('an svg og:image fails as not raster, and a 2400x1260 one is named in the detail', () => {
  const found = assertStatus(failing, 'output.og-image', 'fail', assert)
  const text = `${found.detail} ${found.evidence.map((e) => e.value).join(' | ')}`
  assert.match(text, /og\.svg/)
  assert.match(text, /2400.?1260/)
})

test('robots.txt must name a sitemap on the production host and must not disallow everything', () => {
  const found = assertStatus(failing, 'output.robots-txt', 'fail', assert)
  const text = `${found.detail} ${found.evidence.map((e) => e.value).join(' | ')}`
  assert.match(text, /Disallow: \//)
  assert.match(text, /staging\.example\.com/)
})

test('a sitemap loc off the production host or absent from the build fails', () => {
  const found = assertStatus(failing, 'output.sitemap', 'fail', assert)
  const values = found.evidence.map((e) => e.value).join(' | ')
  assert.match(values, /missing-page/)
  assert.match(values, /staging\.example\.com/)
})

test('a sitemap index is expanded from disk, and its children are what get checked', () => {
  assertStatus(passing, 'output.sitemap', 'pass', assert)
})

test('llms.txt is informational: well-formed passes, malformed is advisory, absent is info', async () => {
  assertStatus(passing, 'output.llms-txt', 'pass', assert)
  const malformed = assertStatus(failing, 'output.llms-txt', 'advisory', assert)
  assert.equal(malformed.severity, 'low')

  const { dir, cleanup } = outsideRepoDir('nollms')
  try {
    const { mkdirSync } = await import('node:fs')
    writeFileSync(join(dir, 'package.json'), '{}')
    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, 'dist', 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>t</title></head><body><h1>h</h1></body></html>')
    const map = await group(checks, await ctxFor(dir))
    const absent = assertStatus(map, 'output.llms-txt', 'advisory', assert)
    assert.equal(absent.severity, 'info')
  } finally { cleanup() }
})

test('a thank-you page that is not noindexed fails', () => {
  const found = assertStatus(failing, 'output.noindex-utility-pages', 'fail', assert)
  assert.match(found.evidence.map((e) => e.value).join(' '), /thank-you/)
})

test('canonicals must be present, absolute, on the production host and self-referencing', () => {
  const found = assertStatus(failing, 'output.canonical', 'fail', assert)
  const values = found.evidence.map((e) => e.value).join(' | ')
  assert.match(values, /home\.html/)
  assert.match(values, /other\.example/)
  assert.match(values, /contact\.html/)
})

test('titles and descriptions must be present and unique', () => {
  const titles = assertStatus(failing, 'output.titles', 'fail', assert)
  const titleText = titles.evidence.map((e) => e.value).join(' | ')
  assert.match(titleText, /contact\.html/)
  assert.match(titleText, /Harbour Works/)

  const descriptions = assertStatus(failing, 'output.descriptions', 'fail', assert)
  assert.match(descriptions.evidence.map((e) => e.value).join(' | '), /contact\.html/)
})

test('one h1, a lang, a viewport and a charset on every page', () => {
  assert.match(assertStatus(failing, 'output.h1', 'fail', assert).evidence.map((e) => e.value).join(' '), /home\.html/)
  assert.match(assertStatus(failing, 'output.lang', 'fail', assert).evidence.map((e) => e.value).join(' '), /home\.html/)
  assert.match(assertStatus(failing, 'output.viewport', 'fail', assert).evidence.map((e) => e.value).join(' '), /about\.html/)
  assert.match(assertStatus(failing, 'output.charset', 'fail', assert).evidence.map((e) => e.value).join(' '), /contact\.html/)
})

test('with no build directory every output check skips with the reason', async () => {
  const { dir, cleanup } = outsideRepoDir('nobuild')
  try {
    writeFileSync(join(dir, 'package.json'), '{}')
    const map = await group(checks, await ctxFor(dir))
    for (const id of ALL) {
      const found = assertStatus(map, id, 'skip', assert)
      assert.match(found.detail, /build/i)
    }
  } finally { cleanup() }
})
