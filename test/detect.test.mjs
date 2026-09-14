import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SIGNATURES, detectAnalytics, COLLECTOR_HOSTS, COOKIE_SETTING_TOOLS, isCollectorUrl } from '../skills/launch-audit/scripts/lib/detect/analytics.mjs'
import {
  PLACEHOLDER_TEXT, PLACEHOLDER_IDS, DEV_HOSTS, SECRETS, scanText,
} from '../skills/launch-audit/scripts/lib/detect/placeholders.mjs'

// A planted string per pattern, so no pattern can rot into one that never fires. Each entry is
// [what the pattern is meant to catch, a string it must match, a near-miss it must not].
const TEXT_PROOFS = [
  ['lorem ipsum', 'Lorem Ipsum dolor sit amet', 'Loreena sang'],
  ['your text here', 'Your text here.', 'your text, here in the box'],
  ['coming soon', 'Pricing coming soon', 'the incoming soonest train'],
  ['[INSERT', '[INSERT CLIENT NAME]', 'insert the key'],
  ['{{ mustache }}', 'Hello {{ user.name }}', 'a { brace } alone'],
  ['TODO', 'TODO: write this', 'todos are a kind of list'],
  ['FIXME', 'FIXME before launch', 'fixmen are not a word'],
  ['REPLACE_ME', 'replace_me', 'replaced the tile'],
]

const ID_PROOFS = [
  ['G-XXXXXXX', 'gtag("config","G-XXXXXXX")', 'gtag("config","G-4BCD1234")'],
  ['G-PLACEHOLDER', 'G-PLACEHOLDER', 'G-REALIDXYZ'],
  ['UA-123-4', 'UA-123456-1', 'UA-thing'],
  ['formspree placeholder', 'https://formspree.io/f/your-form-id', 'https://formspree.io/f/mabcdefg'],
  ['GTM-XXXX', 'GTM-XXXXXX', 'GTM-ABC1234'],
]

const HOST_PROOFS = [
  ['localhost', 'http://localhost:3000/api', 'https://notlocalhosting.test/'],
  ['127.0.0.1', 'http://127.0.0.1:8080/', 'http://127.10.0.1/'],
  ['preview deploy', 'https://site-abc.vercel.app/x', 'https://vercel.test/'],
  ['netlify preview', 'https://site.netlify.app/x', 'https://netlify.test/'],
  ['pages.dev', 'https://site.pages.dev/x', 'https://pages.dev.test/'],
  ['staging.', 'https://staging.example.test/', 'https://understaging-example.test/'],
  ['dev.', 'https://dev.example.test/', 'https://devices.example.test/'],
  ['.local', 'http://box.local/', 'http://box.locales/'],
]

const SECRET_PROOFS = [
  ['OpenAI-style key', 'sk-ABCDEFGHIJKLMNOPQRSTUVWX', 'sk-short'],
  ['GitHub token', `ghp_${'a'.repeat(36)}`, 'ghp_tooshort'],
  ['AWS key id', 'AKIAIOSFODNN7EXAMPLE', 'AKIA-lowercase-stuff'],
  ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27u', 'eyJshort.a.b'],
  ['PEM private key', '-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN CERTIFICATE-----'],
]

const proofTable = [
  ['PLACEHOLDER_TEXT', PLACEHOLDER_TEXT, TEXT_PROOFS],
  ['PLACEHOLDER_IDS', PLACEHOLDER_IDS, ID_PROOFS],
  ['DEV_HOSTS', DEV_HOSTS, HOST_PROOFS],
  ['SECRETS', SECRETS, SECRET_PROOFS],
]

for (const [name, patterns, proofs] of proofTable) {
  test(`${name} has one proof per pattern, and every pattern fires on its planted string`, () => {
    assert.equal(patterns.length, proofs.length, `${name} and its proof list must stay the same length`)
    proofs.forEach(([label, hit, miss], i) => {
      assert.ok(patterns[i].test(hit), `${name}[${i}] (${label}) did not fire on "${hit}"`)
      assert.ok(!patterns[i].test(miss), `${name}[${i}] (${label}) fired on the near-miss "${miss}"`)
    })
  })
}

test('scanText reports the pattern, the matched text and where it was found', () => {
  const found = scanText('All good here. TODO: write the copy.', PLACEHOLDER_TEXT)
  assert.equal(found.length, 1)
  assert.ok(found[0].pattern instanceof RegExp)
  assert.equal(found[0].match, 'TODO')
  assert.equal(found[0].index, 15)
})

test('scanText reports every pattern that matches, in pattern order', () => {
  const found = scanText('Lorem ipsum dolor. FIXME: coming soon.', PLACEHOLDER_TEXT)
  assert.deepEqual(found.map((f) => f.match.toLowerCase()), ['lorem ipsum', 'coming soon', 'fixme'])
})

test('scanText on clean text finds nothing', () => {
  assert.deepEqual(scanText('A finished page about precision tooling.', PLACEHOLDER_TEXT), [])
})

test('scanText tolerates a null or empty subject', () => {
  assert.deepEqual(scanText(null, PLACEHOLDER_TEXT), [])
  assert.deepEqual(scanText('', PLACEHOLDER_TEXT), [])
})

test('scanText extraHosts add host patterns matched as whole host segments', () => {
  const opts = { extraHosts: ['old.internal', 'dev'] }
  assert.equal(scanText('https://old.internal/app', DEV_HOSTS, opts)[0].match, 'old.internal')
  assert.equal(scanText('https://build.old.internal/app', DEV_HOSTS, opts).length, 1)
  // A host that merely starts with the extra host is a different host.
  assert.deepEqual(scanText('https://old.internals.test/', DEV_HOSTS, opts), [])
  assert.deepEqual(scanText('https://devices.example.test/', DEV_HOSTS, opts), [])
  assert.equal(scanText('https://dev.example.test/', DEV_HOSTS, opts)[0].match, 'dev.')
})

test('scanText escapes an extra host rather than treating it as a pattern', () => {
  assert.deepEqual(scanText('https://axbxc.test/', DEV_HOSTS, { extraHosts: ['a.b.c'] }), [])
  assert.equal(scanText('https://a.b.c/x', DEV_HOSTS, { extraHosts: ['a.b.c'] }).length, 1)
})

// ---------------------------------------------------------------- analytics

const ANALYTICS_PROOFS = [
  ['GA4', `<script>gtag('config', 'G-4BCD1234');</script>`, 'G-4BCD1234'],
  ['GTM', `<script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABC1234"></script>`, 'GTM-ABC1234'],
  ['Plausible', `<script defer data-domain="x.test" src="https://plausible.io/js/script.js"></script>`, null],
  ['Fathom', `<script src="https://cdn.usefathom.com/script.js"></script>`, null],
  ['PostHog', `<script>posthog.init('phc_x')</script>`, null],
  ['Umami', `<script data-website-id="abc" src="/u.js"></script>`, null],
  ['Matomo', `<script>_paq.push(['trackPageView'])</script>`, null],
  ['Meta Pixel', `<script>fbq('init', '123')</script>`, null],
  ['Hotjar', `<script src="https://static.hotjar.com/c/hotjar-1.js"></script>`, null],
  ['Clarity', `<script src="https://www.clarity.ms/tag/abc"></script>`, null],
]

test('every analytics signature fires on a planted snippet', () => {
  assert.equal(SIGNATURES.length, ANALYTICS_PROOFS.length)
  ANALYTICS_PROOFS.forEach(([name, snippet, id], i) => {
    assert.equal(SIGNATURES[i].name, name, `signature ${i} should be ${name}`)
    const found = detectAnalytics(snippet)
    assert.ok(found.some((f) => f.name === name), `${name} was not detected in its own snippet`)
    assert.equal(found.find((f) => f.name === name).id, id)
  })
})

test('detectAnalytics finds nothing in a page with no tag', () => {
  assert.deepEqual(detectAnalytics('<html><body><h1>Hello</h1></body></html>'), [])
})

test('detectAnalytics reports one entry per occurrence, so a doubled install is visible', () => {
  const html = `<script>gtag('config', 'G-AAAA1111');</script><script>gtag('config', 'G-AAAA1111');</script>`
  const found = detectAnalytics(html).filter((f) => f.name === 'GA4')
  assert.equal(found.length, 2)
  assert.deepEqual(found.map((f) => f.id), ['G-AAAA1111', 'G-AAAA1111'])
})

test('detectAnalytics keeps two different GA4 ids on one page apart', () => {
  const found = detectAnalytics(`gtag('config', 'G-AAAA1111'); gtag("config", "G-BBBB2222");`)
  assert.deepEqual(found.map((f) => f.id), ['G-AAAA1111', 'G-BBBB2222'])
})

test('detectAnalytics carries the matched text, so one snippet matching two alternatives is not two installs', () => {
  const html = `<script defer data-domain="x.test" src="https://plausible.io/js/script.js"></script>`
  const found = detectAnalytics(html).filter((f) => f.name === 'Plausible')
  assert.equal(found.length, 2)
  assert.equal(new Set(found.map((f) => f.match)).size, 2)
})

test('detectAnalytics tolerates a non-string body', () => {
  assert.deepEqual(detectAnalytics(null), [])
})

test('isCollectorUrl recognises a hit to each collector the browser tier watches for', () => {
  const hits = [
    'https://www.google-analytics.com/g/collect?v=2&tid=G-ABC',
    'https://analytics.google.com/g/collect?v=2',
    'https://www.googletagmanager.com/gtag/js?id=G-ABC',
    'https://plausible.io/api/event',
    'https://api.usefathom.com/',
    'https://eu.posthog.com/e/?ip=1',
    'https://site.test/api/collect',
    'https://analytics.site.test/matomo.php?idsite=1',
    'https://www.facebook.com/tr/?id=1&ev=PageView',
    'https://script.hotjar.com/modules.js',
    'https://c.clarity.ms/collect',
  ]
  for (const hit of hits) assert.ok(isCollectorUrl(hit), `${hit} should read as a collector hit`)
  assert.equal(COLLECTOR_HOSTS.length, hits.length)
})

test('isCollectorUrl leaves ordinary requests alone', () => {
  for (const miss of ['https://site.test/app.js', 'https://site.test/images/hero.png', 'https://fonts.googleapis.com/css2?family=X', '', null]) {
    assert.equal(isCollectorUrl(miss), false)
  }
})

test('the cookie-setting tool list is a subset of the detectable tools, and excludes the cookieless ones', () => {
  const names = new Set(SIGNATURES.map((s) => s.name))
  for (const tool of COOKIE_SETTING_TOOLS) assert.ok(names.has(tool), `${tool} is not a detectable tool`)
  for (const cookieless of ['Plausible', 'Fathom', 'Umami']) assert.ok(!COOKIE_SETTING_TOOLS.has(cookieless))
})
