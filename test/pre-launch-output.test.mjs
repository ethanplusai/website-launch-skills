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

// Regression, from the smoke run against a real static site: two of the gate's eight blocking
// failures were `window.location.href = d.url;` and a `href="${p.u}"` inside a template literal,
// both of them script, neither of them a reference to anything. A gate that blocks a launch on
// evidence that is not there is worse than one check short.
// A line a person reads out loud has to be a sentence. "1 page declare a canonical" is what the
// smoke run printed against a real repository.
test('the canonical failure agrees with itself about how many pages it found', async () => {
  const many = assertStatus(failing, 'output.canonical', 'fail', assert)
  assert.match(many.detail, /\d+ pages declare/)

  const { dir, cleanup } = outsideRepoDir('one-canonical')
  try {
    const { mkdirSync } = await import('node:fs')
    const head = '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Home</title><meta name="description" content="A description long enough to be a real one and not a stub of any kind at all.">'
    writeFileSync(join(dir, 'package.json'), '{}')
    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, 'dist', 'index.html'), `<!doctype html><html lang="en"><head>${head}<link rel="canonical" href="/"></head><body><h1>Home</h1></body></html>`)
    const map = await group(checks, await ctxFor(dir))
    const one = assertStatus(map, 'output.canonical', 'fail', assert)
    assert.match(one.detail, /^1 page declares/, `ungrammatical detail: ${one.detail}`)
  } finally { cleanup() }
})

test('script bodies are not scanned for references', () => {
  const found = passing.get('output.internal-refs')
  assert.ok(found !== undefined, 'output.internal-refs did not run')
  assert.notEqual(found.status, 'fail', `output.internal-refs — ${found.detail}`)
})

// The other half of the same fix: dropping script bodies must not drop the script tag itself. A
// bundle the build never wrote is exactly the reference this check exists for.
test('a script src pointing at a file the build does not contain still fails', async () => {
  const { dir, cleanup } = outsideRepoDir('scriptsrc')
  try {
    const { mkdirSync } = await import('node:fs')
    const head = '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Home</title>'
    writeFileSync(join(dir, 'package.json'), '{}')
    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, 'dist', 'index.html'), `<!doctype html><html lang="en"><head>${head}</head><body><h1>Home</h1><script src="/missing-bundle.js"></script></body></html>`)
    const map = await group(checks, await ctxFor(dir))
    const found = assertStatus(map, 'output.internal-refs', 'fail', assert)
    assert.match(found.evidence.map((e) => e.value).join(' | '), /missing-bundle\.js/)
  } finally { cleanup() }
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

// M8: `<script\b[^>]*>` stops at the first `>` in the tag, and a `>` inside a quoted attribute
// value is an ordinary thing for a bundler to emit (`data-sel="div > span"`, an inline JSON
// island, a selector in a data attribute). The opening tag then ends early, and the lazy body
// match eats the rest of the real tag — `src` included — so a `<script src>` pointing at a bundle
// the build never wrote stopped being a broken reference. That is the one thing the script rule
// was explicitly written to keep catching. The tokenizer's own quoted-attribute class does not
// have the problem, so this uses it.
test('a > inside a quoted script attribute does not hide a broken script src', async () => {
  const { dir, cleanup } = outsideRepoDir('script-attr-gt')
  try {
    const { mkdirSync } = await import('node:fs')
    const head = '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Home</title><meta name="description" content="A description long enough to be a real one and not a stub of any kind at all.">'
    const script = '<script data-sel="div > span" src="/missing-bundle.js"></script>'
    writeFileSync(join(dir, 'package.json'), '{}')
    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, 'dist', 'index.html'), `<!doctype html><html lang="en"><head>${head}</head><body><h1>Home</h1>${script}</body></html>`)
    const map = await group(checks, await ctxFor(dir))
    const found = assertStatus(map, 'output.internal-refs', 'fail', assert)
    assert.match(found.evidence.map((e) => e.value).join(' | '), /missing-bundle\.js/)
  } finally { cleanup() }
})

// And the body of such a script is still not markup: the reason the rule exists at all.
test('a > inside a quoted script attribute does not expose the script body to the reference scan', async () => {
  const { dir, cleanup } = outsideRepoDir('script-attr-gt-body')
  try {
    const { mkdirSync } = await import('node:fs')
    const head = '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Home</title><meta name="description" content="A description long enough to be a real one and not a stub of any kind at all.">'
    const script = '<script data-sel="div > span">window.location.href = "/a-file-that-is-not-there.html"</script>'
    writeFileSync(join(dir, 'package.json'), '{}')
    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, 'dist', 'index.html'), `<!doctype html><html lang="en"><head>${head}</head><body><h1>Home</h1>${script}</body></html>`)
    const map = await group(checks, await ctxFor(dir))
    const found = map.get('output.internal-refs')
    assert.ok(found !== undefined, 'output.internal-refs did not run')
    assert.notEqual(found.status, 'fail', `output.internal-refs — ${found.detail}`)
  } finally { cleanup() }
})
