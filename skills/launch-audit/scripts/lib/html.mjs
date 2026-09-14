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
// - `width`/`height` are numbers only when the attribute is a plain integer, else `null`.
// - `inHead` is true only inside an explicit `<head>` element, so a body-only document reports
//   every `<meta>` it finds through `metaOutsideHead`.
// - `text` is visible text with whitespace collapsed. The contents of `script`, `style`,
//   `template`, `noscript` and `svg` are excluded; `textarea` content is kept literally, because
//   that is what a reader sees.
// - `labelled` means "has an accessible name, or does not need one". Controls that need no name
//   (hidden/submit/button/reset types, and controls hidden from assistive tech) report
//   `needsLabel: false`, so `inputs.filter((i) => !i.labelled)` is exactly the violation list.
// - `forms[].inputs` is form-scoped: controls outside a `<form>` are not reported. `hasCaptcha` is
//   page-scoped, since captcha widgets are routinely mounted outside the form they guard.
// - `head.links` collects every `<link>` in the document, wherever it was written, because a
//   canonical or icon injected into the body is exactly the kind of mistake a check wants to see.

const TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|([^<]+)/g
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
const ENTITY = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: '\u00a0' }
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
      metaByName: new Map(), metaByProperty: new Map(),
      links: [], canonical: null, canonicalCount: 0, robots: null, base: null,
    },
    headings: [], h1Count: 0,
    images: [], links: [], forms: [], jsonld: [], scripts: [], iframes: [],
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
  let inHead = false
  let labelOpen = 0
  let pictureDepth = 0
  let currentScript = null

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

  function consumeRaw(tag) {
    const start = TOKEN.lastIndex
    const close = lower.indexOf(`</${tag}`, start)
    if (close === -1) {
      TOKEN.lastIndex = src.length
      return src.slice(start)
    }
    const gt = src.indexOf('>', close)
    TOKEN.lastIndex = gt === -1 ? src.length : gt + 1
    return src.slice(start, close)
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
    if (attrs.name !== undefined) {
      const key = attrs.name.trim().toLowerCase()
      if (key !== '' && !page.head.metaByName.has(key)) page.head.metaByName.set(key, content)
      if (key === 'viewport' && page.head.viewport === null) page.head.viewport = content
      if (key === 'robots' && page.head.robots === null) page.head.robots = content.toLowerCase()
    }
    if (attrs.property !== undefined) {
      const key = attrs.property.trim().toLowerCase()
      if (key !== '' && !page.head.metaByProperty.has(key)) page.head.metaByProperty.set(key, content)
    }
  }

  function recordControl(tag, attrs) {
    const form = formStack.length > 0 ? formStack[formStack.length - 1] : null
    if (!form) return
    let type
    if (tag === 'input') type = lowerOrNull(attrs.type) ?? 'text'
    else if (tag === 'button') type = lowerOrNull(attrs.type) ?? 'submit'
    else type = tag
    const style = attrs.style ?? ''
    const atHidden =
      attrs['aria-hidden'] === 'true' || 'hidden' in attrs || HIDDEN_STYLE.test(style)
    const control = {
      type,
      name: attrs.name ?? null,
      id: attrs.id ?? null,
      labelled: false,
      needsLabel: !NO_LABEL_TYPES.has(type) && !atHidden,
      required: 'required' in attrs,
    }
    const named =
      labelOpen > 0 || attrs['aria-label'] !== undefined || attrs['aria-labelledby'] !== undefined
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
    else if (inHead && !HEAD_TAGS.has(name)) inHead = false

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
    if (BLOCK.has(name) || HEADING_LEVEL[name] !== undefined) closeHeadingCaptures()

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
      case 'link':
        page.head.links.push({
          rel: attrs.rel === undefined ? null : collapse(attrs.rel).toLowerCase(),
          href: attrs.href ?? null,
          type: attrs.type ?? null,
          sizes: attrs.sizes ?? null,
          hreflang: attrs.hreflang ?? null,
        })
        break
      case 'a': {
        if (attrs.href === undefined) break
        const link = {
          href: attrs.href, text: '', rel: attrs.rel === undefined ? null : collapse(attrs.rel).toLowerCase(),
          target: attrs.target ?? null, internal: false, scheme: 'other',
        }
        page.links.push(link)
        anchorMeta.push({ link, raw: attrs.href, cls: attrs.class ?? '' })
        openCapture('a', 'link', link)
        break
      }
      case 'img': {
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
        page.iframes.push({ src: attrs.src ?? null, title: attrs.title ?? null })
        break
      case 'script': {
        const script = {
          src: attrs.src ?? null,
          inline: attrs.src === undefined,
          defer: 'defer' in attrs,
          async: 'async' in attrs,
          type: lowerOrNull(attrs.type),
          inHead,
        }
        page.scripts.push(script)
        currentScript = script
        break
      }
      case 'form':
        formStack.push({
          action: attrs.action === undefined ? null : attrs.action,
          method: lowerOrNull(attrs.method) ?? 'get',
          inputs: [], hasHoneypot: false, hasCaptcha: false,
        })
        page.forms.push(formStack[formStack.length - 1])
        break
      case 'label':
        if (!selfClosing) labelOpen++
        if (attrs.for !== undefined) labelFor.add(attrs.for)
        break
      default:
        break
    }

    if (CONTROL_TAGS.has(name)) recordControl(name, attrs)

    if (HEADING_LEVEL[name] !== undefined) {
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
    if (name === 'label' && labelOpen > 0) labelOpen--
    if (name === 'picture' && pictureDepth > 0) pictureDepth--
    if (name === 'form' && formStack.length > 0) formStack.pop()
    closeCapture(name)
  }

  TOKEN.lastIndex = 0
  let match
  while ((match = TOKEN.exec(src)) !== null) {
    if (match[5] !== undefined) {
      pushText(decode(match[5]))
      continue
    }
    const tag = match[2]
    if (tag === undefined) continue
    const name = tag.toLowerCase()
    if (match[1] === '/') {
      handleClose(name)
      continue
    }
    const attrs = parseAttrs(match[3])
    const selfClosing = match[4] === '/' || VOID.has(name)
    handleOpen(name, attrs, selfClosing)
    if (!RAW_TEXT.has(name) || selfClosing) continue
    const raw = consumeRaw(name)
    if (name === 'title') {
      if (suppressStack.length === 0 && page.head.title === null) page.head.title = collapse(decode(raw))
    } else if (name === 'textarea') {
      pushText(decode(raw))
    } else if (name === 'script') {
      const type = currentScript === null ? null : currentScript.type
      if (type !== null && type.endsWith('ld+json')) {
        const entry = { raw: raw.trim(), parsed: null, error: null }
        try {
          entry.parsed = JSON.parse(entry.raw)
        } catch (error) {
          entry.error = String((error && error.message) || error)
        }
        page.jsonld.push(entry)
      }
      currentScript = null
    }
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
  for (const script of page.scripts) script.src = resolve(script.src, effectiveBase)
  for (const form of page.forms) form.action = resolve(form.action, effectiveBase)
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
