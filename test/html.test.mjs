import { test } from 'node:test'
import { performance } from 'node:perf_hooks'
import assert from 'node:assert/strict'
import { readFixture } from './helpers.mjs'
import { parseHtml } from '../skills/launch-audit/scripts/lib/html.mjs'

test('extracts head metadata with absolute urls', () => {
  const p = parseHtml(readFixture('html/full-head.html'), 'https://x.test/dir/page')
  assert.equal(p.head.title, 'Full Head')
  assert.equal(p.head.canonical, 'https://x.test/dir/page')
  assert.equal(p.head.metaByName.get('description'), 'A description.')
  assert.equal(p.head.metaByProperty.get('og:image'), 'https://x.test/og.png')
  assert.equal(p.head.links.find((l) => l.rel === 'icon').href, 'https://x.test/favicon.svg')
  assert.equal(p.htmlAttrs.lang, 'en')
})

test('full head reports charset, viewport, robots, icons, manifest, and alternates', () => {
  const p = parseHtml(readFixture('html/full-head.html'), 'https://x.test/dir/page')
  assert.equal(p.htmlAttrs.dir, 'ltr')
  assert.equal(p.head.charset, 'utf-8')
  assert.equal(p.head.viewport, 'width=device-width, initial-scale=1')
  assert.equal(p.head.robots, 'index,follow')
  assert.equal(p.head.base, null)
  assert.equal(p.head.metaByProperty.get('og:title'), 'Full Head')
  assert.equal(p.head.metaByName.get('twitter:card'), 'summary_large_image')
  assert.equal(p.head.metaByName.get('theme-color'), '#000')
  const icon = p.head.links.find((l) => l.rel === 'icon')
  assert.equal(icon.type, 'image/svg+xml')
  assert.equal(p.head.links.find((l) => l.rel === 'apple-touch-icon').href, 'https://x.test/apple-touch-icon.png')
  assert.equal(p.head.links.find((l) => l.rel === 'manifest').href, 'https://x.test/site.webmanifest')
  const alt = p.head.links.find((l) => l.rel === 'alternate')
  assert.equal(alt.hreflang, 'fr')
  assert.equal(alt.href, 'https://x.test/fr/dir/page')
})

test('full head reports body structure, image details, iframes, and scripts', () => {
  const p = parseHtml(readFixture('html/full-head.html'), 'https://x.test/dir/page')
  assert.equal(p.hasMain, true)
  assert.deepEqual(p.landmarks, ['nav', 'main'])
  assert.equal(p.skipLink, true)
  assert.equal(p.h1Count, 1)
  assert.deepEqual(p.images[0], {
    src: 'https://x.test/a.png', alt: 'A', width: 10, height: 10,
    loading: 'lazy', fetchpriority: null, inPicture: false, srcset: null,
  })
  assert.deepEqual(p.iframes, [{ src: 'https://x.test/e', title: 'Embed', inForm: false }])
  assert.equal(p.scripts.length, 1)
  assert.deepEqual(p.scripts[0], { src: 'https://x.test/app.js', inline: false, defer: true, async: false, type: null, inHead: false, inForm: false })
  assert.ok(p.text.includes('A paragraph of visible copy.'))
  assert.equal(p.metaOutsideHead, 0)
  assert.deepEqual(p.duplicateIds, [])
  assert.equal(p.tabindexPositive, 0)
  assert.equal(p.autofocus, 0)
})

test('survives messy markup and reports body meta, duplicate ids, positive tabindex', () => {
  const p = parseHtml(readFixture('html/messy.html'), 'https://x.test/')
  assert.equal(p.images[0].src, 'https://x.test/x.png')
  assert.equal(p.images[0].alt, '')
  assert.equal(p.metaOutsideHead, 1)
  assert.deepEqual(p.duplicateIds, ['dup'])
  assert.equal(p.tabindexPositive, 1)
  assert.ok(!p.text.includes('<div>'))
})

test('messy markup still yields title, uppercase tags, unquoted attrs, and collapsed text', () => {
  const p = parseHtml(readFixture('html/messy.html'), 'https://x.test/')
  assert.equal(p.head.title, 'Messy & Unclosed')
  assert.equal(p.head.charset, 'utf-8')
  assert.equal(p.htmlAttrs.lang, 'en')
  assert.equal(p.h1Count, 1)
  assert.equal(p.headings[0].text, 'Messy page')
  assert.equal(p.links[0].href, 'https://x.test/next')
  assert.equal(p.links[0].text, 'Next')
  assert.ok(p.text.includes("'quoted'"), p.text)
  assert.ok(p.text.includes('&copy;'), 'unknown entities are left as-is')
})

test('text excludes script, style, template, noscript, and svg content', () => {
  const p = parseHtml(readFixture('html/messy.html'), 'https://x.test/')
  for (const excluded of ['scripted', 'document.write', 'content:', 'noscript copy', 'template copy', 'svg copy', 'icon']) {
    assert.ok(!p.text.includes(excluded), `text should not include ${excluded}: ${p.text}`)
  }
  assert.ok(p.text.includes('raw <b>not markup</b>'), 'textarea content is literal text')
})

test('jsonld blocks parse individually', () => {
  const p = parseHtml(readFixture('html/jsonld.html'), 'https://x.test/')
  assert.equal(p.jsonld.length, 2)
  assert.equal(p.jsonld[0].parsed['@type'], 'Organization')
  assert.match(p.jsonld[1].error, /JSON/)
})

test('jsonld keeps raw text and nulls the counterpart field', () => {
  const p = parseHtml(readFixture('html/jsonld.html'), 'https://x.test/')
  assert.equal(p.jsonld[0].error, null)
  assert.equal(p.jsonld[1].parsed, null)
  assert.ok(p.jsonld[0].raw.includes('"@type":"Organization"'))
  assert.equal(p.scripts.filter((s) => s.type === 'application/ld+json').length, 2)
  assert.equal(p.scripts[0].inHead, true)
})

test('forms report labels, honeypots, and dead actions', () => {
  const p = parseHtml(readFixture('html/forms.html'), 'https://x.test/')
  assert.equal(p.forms[0].inputs.filter((i) => !i.labelled).length, 1)
  assert.equal(p.forms[0].hasHoneypot, true)
  assert.equal(p.forms[1].action, 'https://x.test/#')
})

test('form controls carry type, name, id, required, and method defaults', () => {
  const p = parseHtml(readFixture('html/forms.html'), 'https://x.test/')
  assert.equal(p.forms.length, 2)
  assert.equal(p.forms[0].action, 'https://x.test/subscribe')
  assert.equal(p.forms[0].method, 'post')
  assert.equal(p.forms[1].method, 'get')
  const email = p.forms[0].inputs.find((i) => i.name === 'email')
  assert.deepEqual(
    { type: email.type, id: email.id, required: email.required, labelled: email.labelled, needsLabel: email.needsLabel },
    { type: 'email', id: 'email', required: true, labelled: true, needsLabel: true },
  )
  const city = p.forms[0].inputs.find((i) => i.name === 'city')
  assert.equal(city.labelled, false)
  assert.equal(city.required, false)
  assert.equal(p.forms[0].hasCaptcha, false)
  assert.equal(p.forms[1].inputs.map((i) => i.type).join(','), 'search,tel,select')
})

test('labelled is true for label-for, wrapping label, aria-label, and aria-labelledby', () => {
  const html = `<form>
    <label for="a">A</label><input id="a" name="a">
    <label>B <input name="b"></label>
    <input name="c" aria-label="C">
    <input name="d" aria-labelledby="lbl">
    <input name="e">
  </form>`
  const p = parseHtml(html, 'https://x.test/')
  const by = Object.fromEntries(p.forms[0].inputs.map((i) => [i.name, i.labelled]))
  assert.deepEqual(by, { a: true, b: true, c: true, d: true, e: false })
})

test('label association works when the label element follows the input', () => {
  const p = parseHtml('<form><input id="late" name="late"><label for="late">Late</label></form>', 'https://x.test/')
  assert.equal(p.forms[0].inputs[0].labelled, true)
})

test('hidden, submit, and button controls are listed but need no label', () => {
  const html = '<form><input type="hidden" name="h"><input type="submit" value="Go"><button>Send</button><input name="x"></form>'
  const p = parseHtml(html, 'https://x.test/')
  const inputs = p.forms[0].inputs
  assert.equal(inputs.length, 4)
  assert.deepEqual(inputs.map((i) => i.needsLabel), [false, false, false, true])
  assert.deepEqual(inputs.map((i) => i.labelled), [true, true, true, false])
  assert.equal(inputs.filter((i) => i.needsLabel && !i.labelled).length, 1)
})

test('honeypots are detected from styles, attributes, and well-known names', () => {
  const cases = [
    '<form><input name="a" style="display:none"></form>',
    '<form><input name="a" style="visibility: hidden"></form>',
    '<form><input name="a" hidden></form>',
    '<form><input name="a" aria-hidden="true"></form>',
    '<form><input name="a" tabindex="-1" autocomplete="off"></form>',
    '<form><input name="website"></form>',
    '<form><input name="url"></form>',
    '<form><input name="honeypot"></form>',
    '<form><input name="hp"></form>',
    '<form><input name="fax"></form>',
  ]
  for (const html of cases) assert.equal(parseHtml(html, 'https://x.test/').forms[0].hasHoneypot, true, html)
  assert.equal(parseHtml('<form><input name="email" tabindex="-1"></form>', 'https://x.test/').forms[0].hasHoneypot, false)
})

test('captcha is detected from recaptcha, hcaptcha, and turnstile markers', () => {
  for (const marker of ['g-recaptcha', 'h-captcha hcaptcha', 'cf-turnstile', 'turnstile']) {
    const p = parseHtml(`<form><input name="a"></form><div class="${marker}"></div>`, 'https://x.test/')
    assert.equal(p.forms[0].hasCaptcha, true, marker)
  }
  assert.equal(parseHtml('<form><input name="a"></form>', 'https://x.test/').forms[0].hasCaptcha, false)
})

test('heading outline and h1 count', () => {
  const p = parseHtml('<h1>A</h1><h3>skip</h3><h2></h2>', 'https://x.test/')
  assert.equal(p.h1Count, 1)
  assert.deepEqual(p.headings.map((h) => h.level), [1, 3, 2])
  assert.equal(p.headings[2].empty, true)
})

test('heading emptiness collapses whitespace and counts image alt text', () => {
  const p = parseHtml('<h2>   </h2><h2><img src="/l.png" alt="Logo"></h2><h2><img src="/l.png" alt=""></h2>', 'https://x.test/')
  assert.deepEqual(p.headings.map((h) => h.empty), [true, false, true])
  assert.equal(p.headings[1].text, 'Logo')
})

test('links are classified internal/external and resolved', () => {
  const p = parseHtml('<a href="/a">a</a><a href="https://o.test/">o</a><a href="mailto:x@y.z">m</a>', 'https://x.test/p/')
  assert.equal(p.links[0].href, 'https://x.test/a')
  assert.equal(p.links[0].internal, true)
  assert.equal(p.links[1].internal, false)
  assert.equal(p.links[2].scheme, 'mailto')
})

test('link schemes cover http, https, mailto, tel, javascript, and other', () => {
  const html = '<a href="http://x.test/h">h</a><a href="https://x.test/s">s</a><a href="mailto:a@b.c">m</a>' +
    '<a href="tel:+15551234">t</a><a href="javascript:void(0)">j</a><a href="ftp://x.test/f">f</a>'
  const p = parseHtml(html, 'https://x.test/')
  assert.deepEqual(p.links.map((l) => l.scheme), ['http', 'https', 'mailto', 'tel', 'javascript', 'other'])
  assert.deepEqual(p.links.map((l) => l.internal), [false, true, false, false, false, false])
})

test('links keep rel, target, and collapsed text', () => {
  const p = parseHtml('<a href="/a" rel="NOFOLLOW noopener" target="_blank">  Read   more </a>', 'https://x.test/')
  assert.deepEqual(p.links[0], {
    href: 'https://x.test/a', text: 'Read more', rel: 'nofollow noopener', target: '_blank', internal: true, scheme: 'https',
    ariaLabel: null,
  })
})

test('a base element rebases relative urls', () => {
  const p = parseHtml('<head><base href="/sub/"><link rel="canonical" href="page"></head><body><img src="i.png" alt=""></body>', 'https://x.test/dir/')
  assert.equal(p.head.base, 'https://x.test/sub/')
  assert.equal(p.head.canonical, 'https://x.test/sub/page')
  assert.equal(p.images[0].src, 'https://x.test/sub/i.png')
})

test('alt is null when absent and empty string when present but empty', () => {
  const p = parseHtml('<img src="/a.png"><img src="/b.png" alt=""><img src="/c.png" alt=" Spaced ">', 'https://x.test/')
  assert.deepEqual(p.images.map((i) => i.alt), [null, '', ' Spaced '])
})

test('image dimensions, loading, fetchpriority, srcset, and picture membership', () => {
  const html = '<picture><source srcset="/a.webp"><img src="/a.png" alt="A" srcset="/a@2x.png 2x" width="100%" height="40" fetchpriority="high"></picture><img src="/b.png" alt="B">'
  const p = parseHtml(html, 'https://x.test/')
  assert.equal(p.images[0].inPicture, true)
  assert.equal(p.images[0].width, null)
  assert.equal(p.images[0].height, 40)
  assert.equal(p.images[0].fetchpriority, 'high')
  assert.equal(p.images[0].srcset, '/a@2x.png 2x')
  assert.equal(p.images[0].loading, null)
  assert.equal(p.images[1].inPicture, false)
})

test('meta keys are lowercased and url-bearing values resolved', () => {
  const p = parseHtml('<head><meta NAME="Description" content="D"><meta PROPERTY="OG:Image" content="/o.png"><meta name="Twitter:Card" content="summary"></head>', 'https://x.test/dir/')
  assert.equal(p.head.metaByName.get('description'), 'D')
  assert.equal(p.head.metaByProperty.get('og:image'), 'https://x.test/o.png')
  assert.equal(p.head.metaByName.get('twitter:card'), 'summary')
  assert.equal(p.head.metaByName.get('Description'), undefined)
})

test('canonical is the first of its kind and canonicalCount reports duplicates', () => {
  const p = parseHtml('<head><link rel="canonical" href="/one"><link rel="canonical" href="/two"></head>', 'https://x.test/')
  assert.equal(p.head.canonical, 'https://x.test/one')
  assert.equal(p.head.canonicalCount, 2)
  const none = parseHtml('<head></head>', 'https://x.test/')
  assert.equal(none.head.canonical, null)
  assert.equal(none.head.canonicalCount, 0)
})

test('robots is lowercased content or null', () => {
  assert.equal(parseHtml('<head><meta name="robots" content="NOINDEX, Nofollow"></head>', 'https://x.test/').head.robots, 'noindex, nofollow')
  assert.equal(parseHtml('<head><title>t</title></head>', 'https://x.test/').head.robots, null)
})

test('script placement in head is recorded from the tokenizer head state', () => {
  const p = parseHtml('<head><script src="/h.js"></script></head><body><script>var a = 1</script></body>', 'https://x.test/')
  assert.deepEqual(p.scripts.map((s) => s.inHead), [true, false])
  assert.deepEqual(p.scripts.map((s) => s.inline), [false, true])
  assert.equal(p.scripts[1].src, null)
})

test('a body-only document parses without a head', () => {
  const p = parseHtml(readFixture('html/no-head.html'), 'https://x.test/')
  assert.equal(p.head.title, null)
  assert.equal(p.htmlAttrs.lang, null)
  assert.equal(p.htmlAttrs.dir, null)
  // The loose meta comes before any body content, so it belongs to the head a browser implies.
  assert.equal(p.metaOutsideHead, 0)
  assert.equal(p.head.metaCounts.get('name:description'), 1)
  assert.equal(p.h1Count, 1)
  assert.equal(p.links[0].href, 'https://x.test/somewhere')
  assert.equal(p.head.canonical, null)
  assert.deepEqual(p.head.links, [])
})

test('entities decode named, decimal, and hex forms and leave unknown ones alone', () => {
  const p = parseHtml('<p>a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#65; &#x42; &nbsp; &bogus;</p>', 'https://x.test/')
  assert.equal(p.text, `a & b <c> "d" 'e' A B &bogus;`)
})

test('attribute values are entity decoded', () => {
  const p = parseHtml('<a href="/a?x=1&amp;y=2">t</a><img src="/i.png" alt="A &amp; B">', 'https://x.test/')
  assert.equal(p.links[0].href, 'https://x.test/a?x=1&y=2')
  assert.equal(p.images[0].alt, 'A & B')
})

test('comments, cdata, and doctypes never leak into text', () => {
  const p = parseHtml('<!DOCTYPE html><!-- hidden note --><p>Shown</p><![CDATA[ cdata note ]]>', 'https://x.test/')
  assert.equal(p.text, 'Shown')
})

test('void and self-closing elements never wait for a closing tag', () => {
  const p = parseHtml('<p>one<br><hr/><img src="/a.png" alt="A" /><input name="x">two</p>', 'https://x.test/')
  assert.equal(p.text, 'one two')
  assert.equal(p.images.length, 1)
})

test('unclosed headings and anchors still resolve their text', () => {
  const p = parseHtml('<h1>First<h2>Second<p>body<a href="/a">link', 'https://x.test/')
  assert.deepEqual(p.headings.map((h) => h.text), ['First', 'Second'])
  assert.equal(p.links[0].text, 'link')
})

test('landmarks include roles as well as elements', () => {
  const p = parseHtml('<header>h</header><div role="navigation">n</div><div role="main">m</div><footer>f</footer>', 'https://x.test/')
  assert.deepEqual(p.landmarks, ['header', 'navigation', 'main', 'footer'])
  assert.equal(p.hasMain, true)
})

test('skip links are detected by fragment target, class, or text', () => {
  assert.equal(parseHtml('<a href="#main">Jump</a>', 'https://x.test/').skipLink, true)
  assert.equal(parseHtml('<a href="#x" class="skip-link">Anything</a>', 'https://x.test/').skipLink, true)
  assert.equal(parseHtml('<a href="#x">Skip to content</a>', 'https://x.test/').skipLink, true)
  assert.equal(parseHtml('<a href="#x">Back to top</a>', 'https://x.test/').skipLink, false)
})

test('autofocus and positive tabindex are counted across the document', () => {
  const p = parseHtml('<input name="a" autofocus><div tabindex="2">a</div><div tabindex="0">b</div><a href="/a" tabindex="-1">c</a><button autofocus>go</button>', 'https://x.test/')
  assert.equal(p.autofocus, 2)
  assert.equal(p.tabindexPositive, 1)
})

test('a script containing markup and a raw textarea do not break the token stream', () => {
  const p = parseHtml('<script>var a = "</div>" + \'<p>\'; if (a < 1) {}</script><h1>After</h1>', 'https://x.test/')
  assert.equal(p.h1Count, 1)
  assert.equal(p.headings[0].text, 'After')
  assert.equal(p.text, 'After')
})

test('a one megabyte document parses quickly and keeps its text', () => {
  const block = `<p>${'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(10)}</p>\n`
  const html = `<!DOCTYPE html><html lang="en"><head><title>Big</title></head><body>${block.repeat(2000)}</body></html>`
  assert.ok(html.length > 1_000_000, `fixture should exceed 1MB, got ${html.length}`)
  const started = Date.now()
  const p = parseHtml(html, 'https://x.test/')
  const elapsed = Date.now() - started
  assert.ok(p.text.length > 900_000, `expected >900k chars of text, got ${p.text.length}`)
  assert.equal(p.text.split('lorem').length - 1, 20_000)
  assert.ok(elapsed < 2000, `expected parse under 2000ms, took ${elapsed}ms`)
})

test('parsing tolerates empty, non-string, and baseless input', () => {
  const empty = parseHtml('', 'https://x.test/')
  assert.equal(empty.text, '')
  assert.equal(empty.h1Count, 0)
  const noBase = parseHtml('<a href="/a">a</a><a href="https://o.test/b">b</a>', '')
  assert.equal(noBase.links[0].href, null)
  assert.equal(noBase.links[0].internal, false)
  assert.equal(noBase.links[1].href, 'https://o.test/b')
})

test('a wrapping label names only the first control inside it', () => {
  const p = parseHtml('<form><label>Name <input name="a">\n<input name="b"><input name="c"></form>', 'https://x.test/')
  const by = Object.fromEntries(p.forms[0].inputs.map((i) => [i.name, i.labelled]))
  assert.deepEqual(by, { a: true, b: false, c: false })
})

test('an unclosed label does not leak across structure, and a for= label never wraps', () => {
  const rows = parseHtml('<form><ul><li><label>A <input name="a"></li><li><input name="b"></li></ul></form>', 'https://x.test/')
  assert.deepEqual(rows.forms[0].inputs.map((i) => i.labelled), [true, false])
  const targeted = parseHtml('<form><label for="a">A<input name="b"><input id="a" name="a"></form>', 'https://x.test/')
  assert.deepEqual(targeted.forms[0].inputs.map((i) => [i.name, i.labelled]), [['b', false], ['a', true]])
  const wrapper = parseHtml('<form><label><div>Name</div><input name="a"></label></form>', 'https://x.test/')
  assert.equal(wrapper.forms[0].inputs[0].labelled, true)
})

test('template, noscript, and svg content is inert and never collected', () => {
  const inert = '<template><img src="/t.png"><a href="/t">t</a></template><noscript><img src="/n.png"></noscript>'
  const p = parseHtml(`${inert}<svg><a href="/s"><image href="/s.png"></a><h1>svg</h1></svg>`, 'https://x.test/')
  assert.equal(p.images.length, 0)
  assert.equal(p.links.length, 0)
  assert.equal(p.headings.length, 0)
  const live = parseHtml('<img src="/t.png"><a href="/t">t</a><img src="/n.png">', 'https://x.test/')
  assert.equal(live.images.length, 2)
  assert.equal(live.links.length, 1)
})

test('inert forms, controls, and iframes are not reported either', () => {
  const p = parseHtml('<template><form action="/t"><input name="a"></form><iframe src="/t"></iframe></template>', 'https://x.test/')
  assert.deepEqual(p.forms, [])
  assert.deepEqual(p.iframes, [])
  const nested = parseHtml('<form action="/real"><input name="real"><template><input name="ghost"></template></form>', 'https://x.test/')
  assert.equal(nested.forms.length, 1)
  assert.deepEqual(nested.forms[0].inputs.map((i) => i.name), ['real'])
})

test('a tag whose attribute value contains a raw < is still recovered', () => {
  const p = parseHtml('<a href="/a" onclick="if (a<b) return false">Go</a><p>after</p>', 'https://x.test/')
  assert.equal(p.links.length, 1)
  assert.equal(p.links[0].href, 'https://x.test/a')
  assert.equal(p.links[0].text, 'Go')
  assert.equal(p.text, 'Go after')
})

test('a stray < in prose stays text and does not eat the document', () => {
  const p = parseHtml('<p>5 < 6 and 7 > 4</p><h1>Still here</h1>', 'https://x.test/')
  assert.equal(p.h1Count, 1)
  assert.ok(p.text.includes('5 < 6 and 7 > 4'), p.text)
})

test('unterminated tags and comments do not backtrack quadratically', () => {
  const cases = [
    ['unterminated attributes', '<a b='.repeat(50_000)],
    ['unterminated tag names', '<a '.repeat(166_000)],
    ['bare angle brackets', '<'.repeat(100_000)],
    ['unterminated quoted attributes', '<a b="c'.repeat(50_000)],
    ['unterminated comments', '<!--'.repeat(50_000)],
    ['unterminated declarations', '<!'.repeat(50_000)],
  ]
  for (const [label, html] of cases) {
    const started = performance.now()
    const p = parseHtml(html, 'https://x.test/')
    const elapsed = performance.now() - started
    assert.equal(typeof p.text, 'string')
    assert.ok(elapsed < 500, `${label} (${html.length} chars) took ${elapsed.toFixed(1)}ms, expected under 500ms`)
  }
})

test('counts every meta occurrence in the head by name and by property', () => {
  const p = parseHtml(
    `<!doctype html><html><head>
      <meta name="description" content="first">
      <meta name="Description" content="second">
      <meta property="og:image" content="https://x.test/a.png">
      <meta property="og:image" content="https://x.test/b.png">
      <meta name="viewport" content="width=device-width">
      <meta name="keywords" property="og:keywords" content="both">
    </head><body><meta name="description" content="in the body"></body></html>`,
    'https://x.test/',
  )
  assert.equal(p.head.metaCounts.get('name:description'), 2)
  assert.equal(p.head.metaCounts.get('property:og:image'), 2)
  assert.equal(p.head.metaCounts.get('name:viewport'), 1)
  assert.equal(p.head.metaCounts.get('name:keywords'), 1)
  assert.equal(p.head.metaCounts.get('property:og:keywords'), 1)
  assert.equal(p.head.metaCounts.get('name:missing'), undefined)
  // First-wins stays first-wins, and a meta outside the head is counted nowhere but metaOutsideHead.
  assert.equal(p.head.metaByName.get('description'), 'first')
  assert.equal(p.metaOutsideHead, 1)
})

test('a document minified past its head tag still has a head', () => {
  const p = parseHtml(
    '<!doctype html><html lang=en><meta charset=utf-8>'
    + '<meta name=viewport content="width=device-width, initial-scale=1"><title>Minified</title>'
    + '<meta name=description content="first"><meta name=description content="second">'
    + '<link rel=icon href=/favicon.ico><h1>Minified</h1><p>Body copy.</p>',
    'https://x.test/',
  )
  assert.equal(p.metaOutsideHead, 0)
  assert.equal(p.head.metaCounts.get('name:description'), 2)
  assert.equal(p.head.charset, 'utf-8')
  assert.equal(p.head.title, 'Minified')
  assert.equal(p.head.links[0].href, 'https://x.test/favicon.ico')
})

test('the implied head ends at the first body content, and at <body>', () => {
  const afterContent = parseHtml('<html><title>t</title><h1>Heading</h1><meta name="description" content="late">', 'https://x.test/')
  assert.equal(afterContent.metaOutsideHead, 1)
  assert.equal(afterContent.head.metaCounts.get('name:description'), undefined)

  const afterBody = parseHtml('<html><title>t</title><body><meta name="description" content="late">', 'https://x.test/')
  assert.equal(afterBody.metaOutsideHead, 1)
  assert.equal(afterBody.head.metaCounts.size, 0)
})

test('an explicit head is unaffected by the implied one', () => {
  const p = parseHtml(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="description" content="in"></head>'
    + '<body><meta name="description" content="out"><p>Copy.</p></body></html>',
    'https://x.test/',
  )
  assert.equal(p.metaOutsideHead, 1)
  assert.equal(p.head.metaCounts.get('name:description'), 1)
  assert.equal(p.head.metaByName.get('description'), 'in')
})

// --------------------------------------------------------- additions for the forms, images and
// links dimensions: a wrapping label must reach the control it actually names, a <video> has to be
// visible at all, and an embed has to say whether it sits inside a form.

test('a wrapping label skips a hidden input and names the control that needs a name', () => {
  const p = parseHtml('<form><label><input type="hidden" name="x"><input type="checkbox" name="x"> Subscribe</label></form>', 'https://x.test/')
  const [hidden, checkbox] = p.forms[0].inputs
  assert.equal(hidden.needsLabel, false)
  assert.equal(checkbox.needsLabel, true)
  assert.equal(checkbox.labelled, true)
})

test('a wrapping label still stops at the first control that does need a name', () => {
  const p = parseHtml('<form><label><input name="a"><input name="b"> Both</label></form>', 'https://x.test/')
  assert.deepEqual(p.forms[0].inputs.map((i) => [i.name, i.labelled]), [['a', true], ['b', false]])
})

test('form controls keep their value, which is where a placeholder form id hides', () => {
  const p = parseHtml('<form><input type="hidden" name="form-id" value="your-form-id"><input name="email"></form>', 'https://x.test/')
  assert.deepEqual(p.forms[0].inputs.map((i) => i.value), ['your-form-id', null])
})

test('anchors keep aria-label, so an icon link with an accessible name is not an empty one', () => {
  const p = parseHtml('<a href="/a" aria-label="Home"></a><a href="/b"></a>', 'https://x.test/')
  assert.deepEqual(p.links.map((l) => l.ariaLabel), ['Home', null])
})

test('iframes and scripts report whether they sit inside a form', () => {
  const p = parseHtml(
    '<form action="/x"><iframe src="/embed" title="Form"></iframe><script src="/embed.js"></script></form><iframe src="/other"></iframe><script src="/app.js"></script>',
    'https://x.test/',
  )
  assert.deepEqual(p.iframes.map((f) => [f.src, f.inForm]), [['https://x.test/embed', true], ['https://x.test/other', false]])
  assert.deepEqual(p.scripts.map((s) => [s.src, s.inForm]), [['https://x.test/embed.js', true], ['https://x.test/app.js', false]])
})

test('videos report their source, autoplay, muted, preload and whether they carry a track', () => {
  const p = parseHtml(
    '<video src="/loud.mp4" autoplay preload="auto"></video>' +
    '<video muted autoplay><source src="/quiet.webm" type="video/webm"><track kind="captions" src="/c.vtt"></video>',
    'https://x.test/',
  )
  assert.deepEqual(p.videos, [
    { src: 'https://x.test/loud.mp4', autoplay: true, muted: false, hasTrack: false, preload: 'auto' },
    { src: 'https://x.test/quiet.webm', autoplay: true, muted: true, hasTrack: true, preload: null },
  ])
})

test('a video inside inert content is not reported', () => {
  const p = parseHtml('<template><video src="/a.mp4" autoplay></video></template>', 'https://x.test/')
  assert.deepEqual(p.videos, [])
})

test('an empty action stays empty, and every other action is resolved', () => {
  const p = parseHtml(
    '<form action=""></form><form></form><form action="#"></form><form action="/contact"></form>',
    'https://x.test/current-page',
  )
  assert.deepEqual(p.forms.map((f) => f.action), [
    '', null, 'https://x.test/current-page#', 'https://x.test/contact',
  ])
})

test('an apostrophe entity is decoded, so copy that uses one reads as written', () => {
  const p = parseHtml("<p>Tom&apos;s shop</p>", 'https://x.test/')
  assert.equal(p.text, "Tom's shop")
})

test('parseHtml collects every stylesheet, inline and linked, in document order', () => {
  const p = parseHtml(
    '<!doctype html><html><head>' +
    '<link rel="stylesheet" href="/a.css">' +
    '<style>@font-face{font-family:X;src:url(/x.woff2)}</style>' +
    '<link rel="preload" as="image" href="/hero.webp">' +
    '</head><body><style media="print">.b{color:red}</style></body></html>',
    'https://x.test/',
  )
  assert.deepEqual(p.styles.map((s) => [s.inline, s.src]), [
    [false, 'https://x.test/a.css'],
    [true, null],
    [true, null],
  ])
  assert.match(p.styles[1].text, /@font-face/)
  assert.equal(p.styles[2].text, '.b{color:red}')
  assert.equal(p.styles[0].text, null)
})

test('a <link> reports the resource kind it declares, so a preload can be told apart', () => {
  const p = parseHtml(
    '<link rel="preload" as="image" href="/hero.webp"><link rel="stylesheet" href="/a.css">',
    'https://x.test/',
  )
  assert.equal(p.head.links[0].as, 'image')
  assert.equal(p.head.links[1].as, null)
})

test('a <style> inside inert content is not collected', () => {
  const p = parseHtml('<template><style>@font-face{font-family:Y}</style></template>', 'https://x.test/')
  assert.deepEqual(p.styles, [])
})
