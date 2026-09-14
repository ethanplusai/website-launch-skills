// Tolerant HTML extraction without a parser.
//
// parseHtml(html, baseUrl) walks the document once with a single regex and returns a `Page`
// snapshot that every check module reads. It is deliberately forgiving: unclosed tags, unquoted
// attributes, uppercase tags, comments, CDATA, doctypes and `<script>` bodies full of `<` all
// pass through without throwing. Nothing here validates markup; it only reports what it saw.
//
// Conventions worth knowing before you consume a Page:
// - Every url-bearing field is absolute, resolved against `<base href>` when present and the
//   supplied `baseUrl` otherwise. A url that cannot be resolved is `null`.
// - `alt` is `null` when the attribute is absent and `''` when it is present but empty.
// - `metaByName`/`metaByProperty` keys are lowercased; the first occurrence of a key wins.
//   `forms[].action` is `''` — not resolved — when the attribute is present but empty, because
//   `action=""` and a resolved page url are different facts and only the parser can tell them
//   apart. An absent attribute stays `null`.
//   `head.metaCounts` counts every `<meta>` in the head under `name:<name>` / `property:<property>`,
//   which is how a repeated tag stays visible despite those maps keeping only the first.
// - `width`/`height` are numbers only when the attribute is a plain integer, else `null`.
// - `inHead` follows the implied head a browser would build: it starts true, so a document
//   minified without its optional `<head>` tag still has a head, and it flips false at `<body>`
//   or at the first element that is not head content (`<html>` excepted, since it wraps both).
//   A `<meta>` after that point is the one `metaOutsideHead` counts.
// - `text` is visible text with whitespace collapsed. The contents of `script`, `style`,
//   `template`, `noscript` and `svg` are excluded; `textarea` content is kept literally, because
//   that is what a reader sees.
// - `labelled` means "has an accessible name, or does not need one". Controls that need no name
//   (hidden/submit/button/reset types, and controls hidden from assistive tech) report
//   `needsLabel: false`, so `inputs.filter((i) => !i.labelled)` is exactly the violation list.
// - `forms[].inputs` is form-scoped: controls outside a `<form>` are not reported. `hasCaptcha` is
//   page-scoped, since captcha widgets are routinely mounted outside the form they guard.
// - `iframes` and `scripts` carry `inForm`, and `forms[].inputs` carry `value`, because a form
//   embed and a placeholder form id are both invisible without them. `videos` reports the source a
//   browser would play (the `src` attribute, else the first nested `<source>`), whether it
//   autoplays unmuted, and whether any `<track>` is present.
// - `head.links` collects every `<link>` in the document, wherever it was written, because a
//   canonical or icon injected into the body is exactly the kind of mistake a check wants to see.
//   Each carries the resource kind it declares as `as`, so a `rel="preload"` can be told apart
//   from the thing it preloads.
// - `styles` is every stylesheet the document brings in, in the order it was written: an inline
//   `<style>` as `{inline: true, src: null, text}`, a `<link rel=stylesheet>` as `{inline: false,
//   src, text: null}`. The text of a linked stylesheet is not here because parsing does not fetch.
// - Inert content is not collected: `images`, `links`, `forms`, form controls, `iframes` and
//   `headings` inside `<template>`, `<noscript>` or `<svg>` are skipped, the way their text is.
// - A wrapping `<label>` names the first labelable control inside it and no more, which is what
//   the HTML spec says and what keeps an unclosed label from claiming the rest of the form. A
//   label carrying `for=` never claims a wrapped control.
//
// Cost: every position in the string is O(1) work. The tokenizer is sticky rather than global, so
// a `<` that starts no valid token is recovered explicitly instead of leaving the regex engine to
// backtrack across the rest of the document; `<`-free attribute classes keep a tag attempt from
// scanning past the next `<`; and the three forward scans ('>', '-->', ']]>') are memoized, since
// the cursor only ever moves forward. A tag whose attributes do contain `<` (`onclick="a<b"`) is
// still recovered, by the bounded lenient path.

// Sticky, and no attribute alternative may cross a `<`, so one attempt costs at most the distance
// to the next `<`. Comments, CDATA and declarations are skipped by the memoized scanners instead.
const TOKEN =
  /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s=/><]+(?:\s*=\s*(?:"[^"<]*"|'[^'<]*'|[^\s"'<>]+))?)*)\s*(\/?)>|([^<]+)/y
// The recovery path for a tag the strict pattern refused, bounded by MAX_TAG.
const LENIENT_TAG = /^<(\/?)([a-zA-Z][\w:-]*)([\s\S]*)$/
const MAX_TAG = 16384
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
const ENTITY = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }
const VOID = new Set(['img', 'br', 'hr', 'meta', 'link', 'input', 'source', 'track', 'wbr', 'area', 'base', 'col', 'embed', 'param'])
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title'])
const SUPPRESS_TEXT = new Set(['template', 'noscript', 'svg'])
const HEAD_TAGS = new Set(['head', 'title', 'meta', 'link', 'base', 'style', 'script', 'noscript', 'template'])
const HEADING_LEVEL = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 }
const LANDMARK_TAGS = new Set(['header', 'nav', 'main', 'footer', 'aside'])
const LANDMARK_ROLES = new Set(['banner', 'navigation', 'main', 'contentinfo', 'complementary', 'search', 'region', 'form'])
const CONTROL_TAGS = new Set(['input', 'select', 'textarea', 'button'])
// Opening one of these implicitly ends an unclosed heading, the way a browser would.
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'tr', 'ul',
])
// A `<div>` never ends a label (`<label><div>Name</div><input></label>` is ordinary markup), but
// anything structural does, so one unclosed label cannot leak across a list or a table.
const LABEL_BREAK = new Set([...BLOCK].filter((tag) => tag !== 'div'))
const NO_LABEL_TYPES = new Set(['hidden', 'submit', 'button', 'reset'])
const HONEYPOT_NAMES = new Set(['website', 'url', 'honeypot', 'hp', 'fax'])
const CAPTCHA = /recaptcha|hcaptcha|turnstile|cf-turnstile/i
const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden/i
const KNOWN_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'javascript'])
const URL_META = /^(og|twitter|al|fb):/
const URL_META_VALUE = /image|url|video|audio|src/
const SKIP_TARGET = /^#(main|content|maincontent|main-content|skip|primary)/i
const SKIP_WORD = /\bskip\b/i

function decode(value) {
  if (!value || value.indexOf('&') === -1) return value
  return value.replace(ENTITY, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()]
    return named === undefined ? match : named
  })
}

function collapse(value) {
  return value.replace(/\s+/g, ' ').trim()
}

function parseAttrs(source) {
  const attrs = Object.create(null)
  if (!source) return attrs
  ATTR.lastIndex = 0
  let m
  while ((m = ATTR.exec(source)) !== null) {
    const name = m[1].toLowerCase()
    if (name in attrs) continue
    const raw = m[2] ?? m[3] ?? m[4]
    attrs[name] = raw === undefined ? '' : decode(raw)
  }
  return attrs
}

function integer(value) {
  return value !== undefined && /^\d+$/.test(value.trim()) ? Number(value.trim()) : null
}

function lowerOrNull(value) {
  return value === undefined ? null : value.toLowerCase()
}

export function parseHtml(html, baseUrl) {
  const src = typeof html === 'string' ? html : String(html ?? '')
  const lower = src.toLowerCase()
  const declaredBase = typeof baseUrl === 'string' && baseUrl !== '' ? baseUrl : null
  let baseOrigin = null
  if (declaredBase) {
    try {
      baseOrigin = new URL(declaredBase).origin
    } catch {
      baseOrigin = null
    }
  }

  const page = {
    htmlAttrs: { lang: null, dir: null },
    head: {
      title: null, charset: null, viewport: null,
      metaByName: new Map(), metaByProperty: new Map(), metaCounts: new Map(),
      links: [], canonical: null, canonicalCount: 0, robots: null, base: null,
    },
    headings: [], h1Count: 0,
    images: [], links: [], forms: [], jsonld: [], scripts: [], iframes: [], videos: [], styles: [],
    text: '',
    metaOutsideHead: 0, duplicateIds: [], hasMain: false, landmarks: [], skipLink: false,
    tabindexPositive: 0, autofocus: 0,
  }

  const textParts = []
  const captures = []
  const suppressStack = []
  const formStack = []
  const seenIds = new Set()
  const duplicateIds = new Set()
  const labelFor = new Set()
  const landmarkSeen = new Set()
  const anchorMeta = []
  const controls = []
  // Every <link rel=stylesheet> gets a `styles` entry at the position it was written, paired with
  // its link object so the href resolved at the end lands in both places.
  const styleLinks = []
  // The implied head: a document may omit <head> entirely (a minifier drops the optional tag) and
  // a browser still parses the metas before the first body content as head content. Starting true
  // is what makes that document's <meta> tags count, and head.meta-duplicate see them at all.
  let inHead = true
  let labelPending = false
  let pictureDepth = 0
  const videoStack = []
  let currentScript = null
  let currentStyle = null

  // `from` only ever moves forward, so one memo per needle makes every lookup amortized O(1):
  // once a needle is absent from the tail it is absent for every later position too.
  function scanner(needle) {
    let at = -2
    return (from) => {
      if (at === -1) return -1
      if (at === -2 || at < from) at = src.indexOf(needle, from)
      return at
    }
  }
  const nextGt = scanner('>')
  const nextCommentEnd = scanner('-->')
  const nextCdataEnd = scanner(']]>')

  function pushText(value) {
    if (suppressStack.length > 0 || value === '') return
    textParts.push(value)
    for (const capture of captures) capture.parts.push(value)
  }

  function pushCaptureOnly(value) {
    if (suppressStack.length > 0 || value === '') return
    for (const capture of captures) capture.parts.push(value)
  }

  function finalizeCapture(capture) {
    const text = collapse(capture.parts.join(' '))
    capture.target.text = text
    if (capture.kind === 'heading') capture.target.empty = text === ''
  }

  function closeCapture(tag) {
    for (let i = captures.length - 1; i >= 0; i--) {
      if (captures[i].tag !== tag) continue
      for (let j = captures.length - 1; j >= i; j--) finalizeCapture(captures[j])
      captures.length = i
      return
    }
  }

  function closeHeadingCaptures() {
    const first = captures.findIndex((capture) => capture.kind === 'heading')
    if (first === -1) return
    for (let i = captures.length - 1; i >= first; i--) finalizeCapture(captures[i])
    captures.length = first
  }

  function openCapture(tag, kind, target) {
    closeCapture(tag)
    captures.push({ tag, kind, target, parts: [] })
  }

  function consumeRaw(tag, start) {
    const close = lower.indexOf(`</${tag}`, start)
    if (close === -1) return { content: src.slice(start), next: src.length }
    const gt = src.indexOf('>', close)
    return { content: src.slice(start, close), next: gt === -1 ? src.length : gt + 1 }
  }

  function recordMeta(attrs) {
    if (!inHead) page.metaOutsideHead++
    if (attrs.charset !== undefined && page.head.charset === null) page.head.charset = attrs.charset.trim().toLowerCase()
    const httpEquiv = lowerOrNull(attrs['http-equiv'])
    if (httpEquiv === 'content-type' && page.head.charset === null && attrs.content) {
      const found = /charset\s*=\s*([^;\s]+)/i.exec(attrs.content)
      if (found) page.head.charset = found[1].toLowerCase()
    }
    const content = attrs.content ?? ''
    // metaCounts is the only place a repeated meta is visible: the two maps below are first-wins,
    // by design, so `head.meta-duplicate` has nothing else to read. Head-only, because a meta in
    // the body is metaOutsideHead's finding rather than a duplicate of anything.
    const count = (key) => { if (inHead && key !== '') page.head.metaCounts.set(key, (page.head.metaCounts.get(key) ?? 0) + 1) }
    if (attrs.name !== undefined) {
      const key = attrs.name.trim().toLowerCase()
      count(key === '' ? '' : `name:${key}`)
      if (key !== '' && !page.head.metaByName.has(key)) page.head.metaByName.set(key, content)
      if (key === 'viewport' && page.head.viewport === null) page.head.viewport = content
      if (key === 'robots' && page.head.robots === null) page.head.robots = content.toLowerCase()
    }
    if (attrs.property !== undefined) {
      const key = attrs.property.trim().toLowerCase()
      count(key === '' ? '' : `property:${key}`)
      if (key !== '' && !page.head.metaByProperty.has(key)) page.head.metaByProperty.set(key, content)
    }
  }

  function recordControl(tag, attrs) {
    let type
    if (tag === 'input') type = lowerOrNull(attrs.type) ?? 'text'
    else if (tag === 'button') type = lowerOrNull(attrs.type) ?? 'submit'
    else type = tag
    const style = attrs.style ?? ''
    const atHidden =
      attrs['aria-hidden'] === 'true' || 'hidden' in attrs || HIDDEN_STYLE.test(style)
    const needsLabel = !NO_LABEL_TYPES.has(type) && !atHidden
    // A wrapping label names the first *labelable* control it contains and then stops. A control
    // that needs no name — a hidden input, a submit button, a honeypot — is not labelable, so it
    // neither takes the name nor swallows it: `<label><input type="hidden"><input type="checkbox">
    // Subscribe</label>` names the checkbox, which is what a browser does.
    const wrapped = labelPending && needsLabel
    if (wrapped) labelPending = false
    if (suppressStack.length > 0) return
    const form = formStack.length > 0 ? formStack[formStack.length - 1] : null
    if (!form) return
    const control = {
      type,
      name: attrs.name ?? null,
      id: attrs.id ?? null,
      value: attrs.value ?? null,
      labelled: false,
      needsLabel,
      required: 'required' in attrs,
    }
    const named =
      wrapped || attrs['aria-label'] !== undefined || attrs['aria-labelledby'] !== undefined
    controls.push({ control, named, id: attrs.id ?? null })
    form.inputs.push(control)
    const honeypot =
      atHidden ||
      (attrs.tabindex === '-1' && lowerOrNull(attrs.autocomplete) === 'off') ||
      (control.name !== null && HONEYPOT_NAMES.has(control.name.trim().toLowerCase()))
    if (honeypot) form.hasHoneypot = true
  }

  function handleOpen(name, attrs, selfClosing) {
    if (name === 'head') inHead = true
    else if (name === 'body') inHead = false
    // `<html>` wraps the head rather than ending it; everything else that is not head content is
    // the first body content, whether or not a <head> was ever opened.
    else if (inHead && name !== 'html' && !HEAD_TAGS.has(name)) inHead = false

    const id = attrs.id
    if (id !== undefined && id !== '') {
      if (seenIds.has(id)) duplicateIds.add(id)
      else seenIds.add(id)
    }
    if (attrs.tabindex !== undefined && Number(attrs.tabindex) > 0) page.tabindexPositive++
    if ('autofocus' in attrs) page.autofocus++

    const role = lowerOrNull(attrs.role)
    if (LANDMARK_TAGS.has(name) && !landmarkSeen.has(name)) {
      landmarkSeen.add(name)
      page.landmarks.push(name)
    }
    if (role !== null && LANDMARK_ROLES.has(role) && !landmarkSeen.has(role)) {
      landmarkSeen.add(role)
      page.landmarks.push(role)
    }
    if (name === 'main' || role === 'main') page.hasMain = true

    if (SUPPRESS_TEXT.has(name) && !selfClosing) suppressStack.push(name)
    const inert = suppressStack.length > 0
    if (BLOCK.has(name) || HEADING_LEVEL[name] !== undefined) closeHeadingCaptures()
    if (LABEL_BREAK.has(name)) labelPending = false

    switch (name) {
      case 'html':
        if (page.htmlAttrs.lang === null && attrs.lang !== undefined) page.htmlAttrs.lang = attrs.lang
        if (page.htmlAttrs.dir === null && attrs.dir !== undefined) page.htmlAttrs.dir = attrs.dir
        break
      case 'meta':
        recordMeta(attrs)
        break
      case 'base':
        if (page.head.base === null && attrs.href !== undefined) page.head.base = resolve(attrs.href, declaredBase)
        break
      case 'link': {
        const declared = {
          rel: attrs.rel === undefined ? null : collapse(attrs.rel).toLowerCase(),
          href: attrs.href ?? null,
          as: lowerOrNull(attrs.as),
          type: attrs.type ?? null,
          sizes: attrs.sizes ?? null,
          hreflang: attrs.hreflang ?? null,
        }
        page.head.links.push(declared)
        if (declared.rel !== null && declared.rel.split(/\s+/).includes('stylesheet')) {
          const entry = { inline: false, src: null, text: null }
          page.styles.push(entry)
          styleLinks.push({ entry, link: declared })
        }
        break
      }
      case 'a': {
        if (attrs.href === undefined || inert) break
        const link = {
          href: attrs.href, text: '', rel: attrs.rel === undefined ? null : collapse(attrs.rel).toLowerCase(),
          target: attrs.target ?? null, internal: false, scheme: 'other',
          ariaLabel: attrs['aria-label'] ?? null,
        }
        page.links.push(link)
        anchorMeta.push({ link, raw: attrs.href, cls: attrs.class ?? '' })
        openCapture('a', 'link', link)
        break
      }
      case 'img': {
        if (inert) break
        page.images.push({
          src: attrs.src ?? null,
          alt: attrs.alt === undefined ? null : attrs.alt,
          width: integer(attrs.width),
          height: integer(attrs.height),
          loading: lowerOrNull(attrs.loading),
          fetchpriority: lowerOrNull(attrs.fetchpriority),
          inPicture: pictureDepth > 0,
          srcset: attrs.srcset ?? null,
        })
        if (attrs.alt) pushCaptureOnly(attrs.alt)
        break
      }
      case 'picture':
        if (!selfClosing) pictureDepth++
        break
      case 'iframe':
        if (!inert) page.iframes.push({ src: attrs.src ?? null, title: attrs.title ?? null, inForm: formStack.length > 0 })
        break
      case 'video': {
        if (inert) break
        const video = {
          src: attrs.src ?? null,
          autoplay: 'autoplay' in attrs,
          muted: 'muted' in attrs,
          hasTrack: false,
          preload: lowerOrNull(attrs.preload),
        }
        page.videos.push(video)
        if (!selfClosing) videoStack.push(video)
        break
      }
      case 'source': {
        const video = videoStack.length > 0 ? videoStack[videoStack.length - 1] : null
        if (video !== null && video.src === null && attrs.src !== undefined) video.src = attrs.src
        break
      }
      case 'track': {
        const video = videoStack.length > 0 ? videoStack[videoStack.length - 1] : null
        if (video !== null) video.hasTrack = true
        break
      }
      case 'script': {
        const script = {
          src: attrs.src ?? null,
          inline: attrs.src === undefined,
          defer: 'defer' in attrs,
          async: 'async' in attrs,
          // A nomodule script is a fallback for browsers that cannot do modules. Every browser
          // that can ignores it entirely — it is never fetched and never run — so it is not a
          // script the page waits for, and a checker that treats it as one is wrong about every
          // build that still ships a legacy bundle.
          nomodule: 'nomodule' in attrs,
          type: lowerOrNull(attrs.type),
          inHead,
          inForm: formStack.length > 0,
        }
        page.scripts.push(script)
        currentScript = script
        break
      }
      case 'form': {
        // Pushed even when inert, so the matching `</form>` pops the right one; just not reported.
        const form = {
          action: attrs.action === undefined ? null : attrs.action,
          method: lowerOrNull(attrs.method) ?? 'get',
          inputs: [], hasHoneypot: false, hasCaptcha: false,
        }
        formStack.push(form)
        if (!inert) page.forms.push(form)
        break
      }
      case 'style': {
        // The text arrives from the raw-text scan below; an inert or self-closed <style> has none
        // to claim, so it never opens one.
        currentStyle = null
        if (inert || selfClosing) break
        currentStyle = { inline: true, src: null, text: '' }
        page.styles.push(currentStyle)
        break
      }
      case 'label':
        // A fresh label supersedes an unclosed one; `for=` targets an id, never a wrapped control.
        labelPending = !selfClosing && attrs.for === undefined
        if (attrs.for !== undefined) labelFor.add(attrs.for)
        break
      default:
        break
    }

    if (CONTROL_TAGS.has(name)) recordControl(name, attrs)

    if (HEADING_LEVEL[name] !== undefined && !inert) {
      const heading = { level: HEADING_LEVEL[name], text: '', empty: true }
      page.headings.push(heading)
      if (heading.level === 1) page.h1Count++
      openCapture(name, 'heading', heading)
    }
  }

  function handleClose(name) {
    const suppressIndex = suppressStack.lastIndexOf(name)
    if (suppressIndex !== -1) suppressStack.length = suppressIndex
    if (name === 'head' || name === 'body') inHead = false
    if (name === 'label' || name === 'form' || name === 'fieldset') labelPending = false
    if (name === 'picture' && pictureDepth > 0) pictureDepth--
    if (name === 'video' && videoStack.length > 0) videoStack.pop()
    if (name === 'form' && formStack.length > 0) formStack.pop()
    closeCapture(name)
  }

  function emitTag(closing, tagName, attrSource, selfMark, after) {
    const name = tagName.toLowerCase()
    if (closing) {
      handleClose(name)
      return after
    }
    const attrs = parseAttrs(attrSource)
    const selfClosing = selfMark || VOID.has(name)
    handleOpen(name, attrs, selfClosing)
    if (!RAW_TEXT.has(name) || selfClosing) return after
    const { content, next } = consumeRaw(name, after)
    if (name === 'title') {
      if (suppressStack.length === 0 && page.head.title === null) page.head.title = collapse(decode(content))
    } else if (name === 'textarea') {
      pushText(decode(content))
    } else if (name === 'script') {
      const type = currentScript === null ? null : currentScript.type
      if (type !== null && type.endsWith('ld+json')) {
        const entry = { raw: content.trim(), parsed: null, error: null }
        try {
          entry.parsed = JSON.parse(entry.raw)
        } catch (error) {
          entry.error = String((error && error.message) || error)
        }
        page.jsonld.push(entry)
      }
      currentScript = null
    } else if (name === 'style') {
      if (currentStyle !== null) currentStyle.text = content.trim()
      currentStyle = null
    }
    return next
  }

  // Comments, CDATA, doctypes and processing instructions: content dropped, never text.
  function skipDeclaration(at) {
    if (src.startsWith('<!--', at)) {
      const end = nextCommentEnd(at + 4)
      return end === -1 ? src.length : end + 3
    }
    if (lower.startsWith('<![cdata[', at)) {
      const end = nextCdataEnd(at + 9)
      return end === -1 ? src.length : end + 3
    }
    const gt = nextGt(at)
    return gt === -1 ? src.length : gt + 1
  }

  // Reached only at a `<` the strict pattern refused. Either a real tag whose attributes contain a
  // `<`, or a stray `<` in prose; both cost O(1) beyond the span they consume.
  function recoverStrayTag(at) {
    const after = src[at + 1] ?? ''
    if (after === '/' || (after >= 'a' && after <= 'z') || (after >= 'A' && after <= 'Z')) {
      const gt = nextGt(at)
      if (gt !== -1 && gt - at <= MAX_TAG) {
        const parts = LENIENT_TAG.exec(src.slice(at, gt))
        if (parts !== null) {
          const selfMark = parts[3].endsWith('/')
          return emitTag(parts[1] === '/', parts[2], selfMark ? parts[3].slice(0, -1) : parts[3], selfMark, gt + 1)
        }
      }
    }
    pushText('<')
    return at + 1
  }

  let cursor = 0
  while (cursor < src.length) {
    if (src.charCodeAt(cursor) === 0x3c) {
      const after = src.charCodeAt(cursor + 1)
      if (after === 0x21 || after === 0x3f) {
        cursor = skipDeclaration(cursor)
        continue
      }
    }
    TOKEN.lastIndex = cursor
    const match = TOKEN.exec(src)
    if (match === null) {
      cursor = recoverStrayTag(cursor)
      continue
    }
    const after = TOKEN.lastIndex
    if (match[5] !== undefined) {
      pushText(decode(match[5]))
      cursor = after
      continue
    }
    cursor = emitTag(match[1] === '/', match[2], match[3], match[4] === '/', after)
  }

  for (let i = captures.length - 1; i >= 0; i--) finalizeCapture(captures[i])
  captures.length = 0

  function resolve(href, against) {
    if (href === null || href === undefined) return null
    try {
      return against === null || against === undefined ? new URL(href).href : new URL(href, against).href
    } catch {
      try {
        return new URL(href).href
      } catch {
        return null
      }
    }
  }

  const effectiveBase = page.head.base ?? declaredBase

  function schemeOf(absolute, raw) {
    const source = absolute ?? raw
    const found = /^([a-z][a-z0-9+.-]*):/i.exec(source ?? '')
    if (found === null) return 'other'
    const scheme = found[1].toLowerCase()
    return KNOWN_SCHEMES.has(scheme) ? scheme : 'other'
  }

  for (const link of page.head.links) link.href = resolve(link.href, effectiveBase)
  for (const image of page.images) image.src = resolve(image.src, effectiveBase)
  for (const frame of page.iframes) frame.src = resolve(frame.src, effectiveBase)
  for (const video of page.videos) video.src = resolve(video.src, effectiveBase)
  for (const script of page.scripts) script.src = resolve(script.src, effectiveBase)
  for (const form of page.forms) {
    // An empty action is kept empty. Resolving it would produce the page's own url, which is also
    // what `action="/this-page"` produces, and the two are not the same thing to a check.
    form.action = form.action !== null && form.action.trim() === '' ? '' : resolve(form.action, effectiveBase)
  }
  for (const { link, raw } of anchorMeta) {
    link.href = resolve(raw, effectiveBase)
    link.scheme = schemeOf(link.href, raw)
    if (link.href !== null && baseOrigin !== null) {
      try {
        const origin = new URL(link.href).origin
        link.internal = origin !== 'null' && origin === baseOrigin
      } catch {
        link.internal = false
      }
    }
  }

  for (const map of [page.head.metaByName, page.head.metaByProperty]) {
    for (const [key, value] of map) {
      if (URL_META.test(key) && URL_META_VALUE.test(key)) map.set(key, resolve(value, effectiveBase) ?? value)
    }
  }

  for (const { entry, link } of styleLinks) entry.src = link.href

  for (const link of page.head.links) {
    if (link.rel === null) continue
    if (!link.rel.split(/\s+/).includes('canonical')) continue
    page.head.canonicalCount++
    if (page.head.canonical === null) page.head.canonical = link.href
  }

  for (const { control, named, id } of controls) {
    control.labelled = !control.needsLabel || named || (id !== null && labelFor.has(id))
  }

  const pageHasCaptcha = CAPTCHA.test(src)
  for (const form of page.forms) form.hasCaptcha = pageHasCaptcha

  page.skipLink = anchorMeta.some(
    ({ link, raw, cls }) => raw.startsWith('#') && (SKIP_TARGET.test(raw) || SKIP_WORD.test(cls) || SKIP_WORD.test(link.text)),
  )
  page.duplicateIds = Array.from(duplicateIds)
  page.text = collapse(textParts.join(' '))
  return page
}
