import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SIGNATURES, detectAnalytics, COLLECTOR_HOSTS, COOKIE_SETTING_TOOLS, isCollectorUrl } from '../skills/launch-audit/scripts/lib/detect/analytics.mjs'
import {
  PLACEHOLDER_TEXT, PLACEHOLDER_IDS, PLACEHOLDER_URLS, DEV_HOSTS, SECRETS, scanText,
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
  ['REPLACE_WITH_ token', 'forms: { contact: \'REPLACE_WITH_FORM_ID\' }', 'replace_with_care() is a function name'],
  ['Sample Post', 'Sample Post — Delete Me', 'Sample Post-Op Instructions'],
  ['Delete Me', 'Sample Post — Delete Me', 'ask us to delete me from the list'],
]

const ID_PROOFS = [
  ['G-XXXXXXX', 'gtag("config","G-XXXXXXX")', 'gtag("config","G-4BCD1234")'],
  ['G-PLACEHOLDER', 'G-PLACEHOLDER', 'G-REALIDXYZ'],
  ['UA-123-4', 'UA-123456-1', 'UA-thing'],
  ['formspree placeholder', 'https://formspree.io/f/your-form-id', 'https://formspree.io/f/mabcdefg'],
  ['GTM-XXXX', 'GTM-XXXXXX', 'GTM-ABC1234'],
]

// The one list that has to be read from markup: the host is a defect only as the value of an href or
// src. The near-miss is the hint on every contact form, which is why a bare-host pattern would not do.
const URL_PROOFS = [
  ['example.com in an href or src', '<a href="https://example.com/book">Book</a>', '<input type="email" placeholder="you@example.com">'],
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
  ['PLACEHOLDER_URLS', PLACEHOLDER_URLS, URL_PROOFS],
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

// The strings a starter template ships with, plus REPLACE_ME and lorem ipsum, which were already
// caught, so the whole set is proved in one place. Each has to fire on the exact text it appears as,
// and none may fire on the same words in ordinary use.
test('the starter placeholders are each caught as written', () => {
  const caught = (text) => scanText(text, PLACEHOLDER_TEXT).map((hit) => hit.match)
  assert.deepEqual(caught('contact: REPLACE_WITH_FORM_ID'), ['REPLACE_WITH_FORM_ID'])
  assert.deepEqual(caught("publicBase: 'REPLACE_WITH_THIS_SITES_BUCKET_URL',"), ['REPLACE_WITH_THIS_SITES_BUCKET_URL'])
  assert.deepEqual(caught('<h1>Sample Post — Delete Me</h1>'), ['Sample Post', 'Delete Me'])
  assert.deepEqual(caught('Sample Posts'), ['Sample Posts'])
  assert.deepEqual(caught('REPLACE_ME'), ['REPLACE_ME'])
  assert.deepEqual(caught('Lorem ipsum dolor sit amet'), ['Lorem ipsum'])
})

test('ordinary uses of the same words are not placeholders', () => {
  for (const fine of [
    'You can ask us to delete me and my records from the list.',
    'Please delete my data.',
    'A sample of our work, in a post about aftercare.',
    'Sample Post-Op Instructions',
    'Download our sample post-op instructions',
    'a sample posting of the rota',
    'replace_with_care()',
    'REPLACE_WITH', // no token after it
    'Replace with a calmer shade.',
  ]) {
    assert.deepEqual(scanText(fine, PLACEHOLDER_TEXT), [], fine)
  }
})

// A link to the documentation host, read the way a check reads it: raw markup, one match per
// pattern, and the match is the attribute so the evidence line is something a person can find.
test('PLACEHOLDER_URLS fires on example.com as the value of an href or src, however it is written', () => {
  const hits = [
    ['<a href="https://example.com/book">Book</a>', 'href="https://example.com/book'],
    ["<a href='https://www.example.com/'>", "href='https://www.example.com/"],
    ['<a href=https://example.com>', 'href=https://example.com'],
    ['<a HREF = "https://EXAMPLE.COM/x">', 'HREF = "https://EXAMPLE.COM/x'],
    ['<a href="mailto:hello@example.com">Email</a>', 'href="mailto:hello@example.com'],
    ['<link rel="canonical" href="https://example.com/">', 'href="https://example.com/'],
    ['<img src="https://pub-1.r2.dev/example.com/assets/img/blog/sample-post/og-1024.webp" alt="">', 'src="https://pub-1.r2.dev/example.com/assets/img/blog/sample-post/og-1024.webp'],
    ['<img data-src="//example.com/lazy.png">', 'src="//example.com/lazy.png'],
    ['<iframe src="https://example.com:8443/embed"></iframe>', 'src="https://example.com:8443/embed'],
  ]
  for (const [markup, match] of hits) {
    const found = scanText(markup, PLACEHOLDER_URLS)
    assert.equal(found.length, 1, markup)
    assert.equal(found[0].match, match, markup)
  }
})

test('PLACEHOLDER_URLS leaves the hint, the sentence and every other host alone', () => {
  for (const fine of [
    '<input type="email" placeholder="you@example.com">',
    '<input type="url" placeholder="https://example.com" name="website">',
    '<p>Write to you@example.com or visit https://example.com for an example.</p>',
    '<a href="https://notexample.com/">x</a>',
    '<a href="https://my-example.com/">x</a>',
    '<a href="https://example.community/">x</a>',
    '<a href="https://example.com.au/">x</a>',
    '<a href="/about" title="see example.com">x</a>',
    '<a href="https://example.org/">x</a>',
    '<img srcset="https://example.com/a.png 1x" alt="">',
  ]) {
    assert.deepEqual(scanText(fine, PLACEHOLDER_URLS), [], fine)
  }
})

test('PLACEHOLDER_URLS finds nothing in visible text, which is why it is never run over it', () => {
  assert.deepEqual(scanText('Book at example.com today', PLACEHOLDER_URLS), [])
})

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
    'https://www.googletagmanager.com/g/collect?v=2&tid=G-1',
    'https://plausible.io/api/event',
    'https://api.usefathom.com/',
    'https://eu.posthog.com/e/?ip=1',
    'https://site.test/api/collect',
    'https://analytics.site.test/matomo.php?idsite=1',
    'https://www.facebook.com/tr/?id=1&ev=PageView',
    'https://in.hotjar.com/api/v2/client/sites/1/data',
    'https://vc.hotjar.com/api/v2/client/ping',
    'https://c.clarity.ms/collect',
  ]
  for (const hit of hits) assert.ok(isCollectorUrl(hit), `${hit} should read as a collector hit`)
  assert.equal(COLLECTOR_HOSTS.length, hits.length)
})

// The distinction the whole browser.analytics-not-firing check rests on: loading the library is
// not sending a hit. A list that matched gtag.js or the hotjar script would call every GA4 site
// instrumented, including the ones whose tag never fires.
test('isCollectorUrl does not mistake a library url for a hit', () => {
  const libraries = [
    'https://www.googletagmanager.com/gtag/js?id=G-1',
    'https://www.googletagmanager.com/gtm.js?id=GTM-1',
    'https://www.google-analytics.com/analytics.js',
    'https://static.hotjar.com/c/hotjar-1.js',
    'https://cdn.usefathom.com/script.js',
    'https://plausible.io/js/script.js',
    'https://www.clarity.ms/tag/abc',
  ]
  for (const library of libraries) assert.equal(isCollectorUrl(library), false, `${library} is a library, not a hit`)
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
