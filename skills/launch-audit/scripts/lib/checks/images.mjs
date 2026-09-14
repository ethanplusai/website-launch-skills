// Images and video: is every picture there, described, sized, and no heavier than it needs to be?
//
// Pure over the audit context. _ctx.mjs has already fetched every `<img src>` and every srcset
// candidate the crawl saw into `probes.images`, with the bytes, so weight and content hash are
// read from a response the audit already has rather than from a second request.
//
// Shape of the findings:
//
// - Everything that is a property of the markup — a missing alt, a missing size, an eager image
//   below the fold — is one finding per page listing the images at fault, rather than one finding
//   per image. A page with forty undescribed images is one job, not forty.
// - `images.duplicate-across-pages` is the exception: it groups by content hash, because the
//   subject is the file rather than any page. It fires only when *two or more urls* carry the same
//   bytes across two or more pages. One url reused on every page is caching working correctly, and
//   reporting a site's logo as a duplicate of itself would be noise on every site that has one.
// - An image the context has no response for is unknown, not broken. `probes.images` is capped,
//   and a url that never answered (`status: 0`) proves nothing about the image.
//
// `<video>` lives here rather than in its own dimension because it is the same question about a
// heavier asset: a video that autoplays with sound is the loudest thing a site can do to a
// visitor, and one without captions is unusable for part of the audience.

import { createHash } from 'node:crypto'
import { defineCheck } from '../registry.mjs'

const PHASE = 'launch-audit'
const DIMENSION = 'images'
const TIER = 'http'
const EVIDENCE_LIMIT = 10

// Past this weight an image is the reason a page is slow, whatever else is on it.
const OVERSIZED_BYTES = 500_000
// The first three images are roughly what fits above the fold on a phone; deferring one of those
// delays the thing the visitor is looking at, and loading the rest eagerly delays everything else.
const ABOVE_FOLD = 3
const LEGACY_EXTENSION = /\.(?:jpe?g|png)$/i

const url = (value) => ({ type: 'url', value })
const status = (value) => ({ type: 'status', value })
const html = (value) => ({ type: 'html', value })
const text = (value) => ({ type: 'text', value })
const metric = (value) => ({ type: 'metric', value })

const define = (def) => defineCheck({ phase: PHASE, dimension: DIMENSION, tier: TIER, ...def })
const emit = (check, overrides) => check.mk({ title: check.title, ...overrides })

const htmlPages = (ctx) => ctx.crawl.pages.filter((p) => p.page !== null && p.status >= 200 && p.status < 300)
const plural = (n, one, many) => (n === 1 ? one : many)
const kb = (bytes) => `${Math.round(bytes / 1024)} KB`

// The bytes a response weighed on the wire: what net reported it received, falling back to the
// body it kept. A recorded response may state the first without carrying the second.
function weightOf(response) {
  if (typeof response?.bytes === 'number' && response.bytes > 0) return response.bytes
  if (response?.bodyBytes instanceof Uint8Array) return response.bodyBytes.length
  if (typeof response?.body === 'string') return response.body.length
  return null
}

// The path of a url, for "does this end in .jpg" — a query string must not decide the answer.
function pathOf(src) {
  try {
    return new URL(src).pathname
  } catch {
    return src
  }
}

function perPage(ctx, check, select, describe) {
  const out = []
  for (const entry of htmlPages(ctx)) {
    const hits = select(entry)
    if (hits.length === 0) continue
    out.push(emit(check, { page: entry.url, ...describe(hits, entry) }))
  }
  return out
}

const withSrc = (entry) => entry.page.images.filter((image) => image.src !== null)

export const altMissing = define({
  id: 'images.alt-missing',
  severity: 'high',
  title: 'An image has no alt attribute',
  catches: 'An <img> with no alt at all, which a screen reader announces by reading out the file name.',
  run(ctx) {
    // alt="" is a decision — "this image says nothing a reader needs" — and is left alone. Only a
    // missing attribute is an omission.
    return perPage(ctx, altMissing, (entry) => entry.page.images.filter((image) => image.alt === null), (hits, entry) => ({
      detail: `${hits.length} ${plural(hits.length, 'image has', 'images have')} no alt attribute. A screen reader falls back to reading the file name, and a browser that cannot load the image shows nothing in its place.`,
      evidence: [url(entry.url), ...hits.slice(0, EVIDENCE_LIMIT).map((image) => html(`<img src="${image.src}"> — no alt`))],
      fix: 'Describe what the image shows, or write alt="" if it is purely decorative.',
    }))
  },
})

export const dimensionsMissing = define({
  id: 'images.dimensions-missing',
  severity: 'medium',
  title: 'An image declares no width or height',
  catches: 'An <img> with neither attribute, so the page reflows when it loads.',
  run(ctx) {
    return perPage(ctx, dimensionsMissing, (entry) => entry.page.images.filter((image) => image.width === null && image.height === null), (hits, entry) => ({
      detail: `${hits.length} ${plural(hits.length, 'image declares', 'images declare')} neither width nor height. The browser cannot reserve space for them, so the text jumps as each one arrives — the layout shift a visitor experiences as the page moving under their thumb.`,
      evidence: [url(entry.url), ...hits.slice(0, EVIDENCE_LIMIT).map((image) => html(`<img src="${image.src}"> — no width/height`))],
      fix: 'Give every image its intrinsic width and height attributes, and let CSS size it from there.',
    }))
  },
})

export const lazyOnFirstImage = define({
  id: 'images.lazy-on-first-image',
  severity: 'medium',
  title: 'The first image on the page is lazy-loaded',
  catches: 'loading="lazy" on the hero image, which delays the one picture the visitor is waiting for.',
  run(ctx) {
    return perPage(ctx, lazyOnFirstImage, (entry) => {
      const first = withSrc(entry)[0]
      return first !== undefined && first.loading === 'lazy' ? [first] : []
    }, (hits, entry) => ({
      detail: `The first image on this page carries loading="lazy". The browser will not even start fetching it until it has worked out the layout, which delays the largest thing on the screen and the score that measures it.`,
      evidence: [url(entry.url), html(`<img src="${hits[0].src}" loading="lazy">`)],
      fix: 'Drop loading="lazy" from the first image, and consider fetchpriority="high" on it instead.',
    }))
  },
})

export const notLazyBelowFold = define({
  id: 'images.not-lazy-below-fold',
  severity: 'low',
  title: 'Images below the fold load eagerly',
  catches: 'Images past the third with no loading="lazy", downloaded before anyone scrolls to them.',
  run(ctx) {
    return perPage(ctx, notLazyBelowFold, (entry) => withSrc(entry).slice(ABOVE_FOLD).filter((image) => image.loading !== 'lazy'), (hits, entry) => ({
      detail: `${hits.length} ${plural(hits.length, 'image', 'images')} below the first ${ABOVE_FOLD} load eagerly. They compete for bandwidth with the content actually on screen, and most visitors never scroll far enough to see them.`,
      evidence: [url(entry.url), ...hits.slice(0, EVIDENCE_LIMIT).map((image) => html(`<img src="${image.src}"> — no loading="lazy"`))],
      fix: 'Add loading="lazy" to every image below the fold.',
    }))
  },
})

export const legacyFormat = define({
  id: 'images.legacy-format',
  severity: 'low',
  title: 'An image is served only as JPEG or PNG',
  catches: 'A bare .jpg or .png with no <picture> and no srcset, so no browser can take a smaller modern format.',
  run(ctx) {
    return perPage(ctx, legacyFormat, (entry) => entry.page.images.filter((image) => (
      image.src !== null && LEGACY_EXTENSION.test(pathOf(image.src)) && !image.inPicture && (image.srcset === null || image.srcset.trim() === '')
    )), (hits, entry) => ({
      detail: `${hits.length} ${plural(hits.length, 'image is', 'images are')} offered only as JPEG or PNG, with no <picture> and no srcset. Every browser in use can take AVIF or WebP, which are routinely half the size for the same picture.`,
      evidence: [url(entry.url), ...hits.slice(0, EVIDENCE_LIMIT).map((image) => url(image.src))],
      fix: 'Serve AVIF or WebP from a <picture>, keeping the JPEG or PNG as the <img> fallback.',
    }))
  },
})

export const oversized = define({
  id: 'images.oversized',
  severity: 'medium',
  title: 'An image is larger than half a megabyte',
  catches: 'A photo shipped straight from the camera, or an uncompressed export.',
  run(ctx) {
    return perPage(ctx, oversized, (entry) => {
      const hits = []
      for (const image of withSrc(entry)) {
        const response = ctx.probes.images.get(image.src)
        if (response === undefined || response.status !== 200) continue
        const bytes = weightOf(response)
        if (bytes === null || bytes <= OVERSIZED_BYTES) continue
        hits.push({ image, bytes, truncated: response.truncated === true })
      }
      return hits
    }, (hits, entry) => ({
      detail: `${hits.length} ${plural(hits.length, 'image on this page weighs', 'images on this page weigh')} more than ${kb(OVERSIZED_BYTES)}. On a phone connection that is seconds of waiting for one picture.`,
      // A body over the read cap is never downloaded, so its size is the server's word and not a
      // measurement. "declared" is the difference between a number this audit counted and a number
      // it was told.
      evidence: [url(entry.url), ...hits.slice(0, EVIDENCE_LIMIT).map((hit) => metric(
        `${hit.image.src} — ${hit.truncated ? 'declared ' : ''}${hit.bytes} bytes (${kb(hit.bytes)})`,
      ))],
      fix: 'Resize each one to the largest size it is ever displayed at, then compress it; a modern format usually halves it again.',
    }))
  },
})

export const broken = define({
  id: 'images.broken',
  severity: 'high',
  title: 'An image does not load',
  catches: 'An <img src> that answers 404 or an error — a hole in the page where a picture should be.',
  run(ctx) {
    return perPage(ctx, broken, (entry) => {
      const hits = []
      for (const image of withSrc(entry)) {
        const response = ctx.probes.images.get(image.src)
        // Not probed, or never answered: unknown, and unknown is not a finding.
        if (response === undefined || response.status === 0 || response.status === 200) continue
        hits.push({ image, response })
      }
      return hits
    }, (hits, entry) => ({
      detail: `${hits.length} ${plural(hits.length, 'image on this page does', 'images on this page do')} not load. The visitor sees the alt text, or a broken-image icon, where the picture was meant to be.`,
      evidence: [url(entry.url), ...hits.flatMap((hit) => [url(hit.image.src), status(hit.response.status)]).slice(0, EVIDENCE_LIMIT * 2)],
      fix: 'Fix the path, or upload the file that is missing.',
    }))
  },
})

export const duplicateAcrossPages = define({
  id: 'images.duplicate-across-pages',
  severity: 'low',
  title: 'The same image file is served under two urls',
  catches: 'One picture uploaded twice under different names, so no visitor ever gets it from cache.',
  run(ctx) {
    const groups = new Map()
    for (const entry of htmlPages(ctx)) {
      for (const image of withSrc(entry)) {
        const response = ctx.probes.images.get(image.src)
        if (response === undefined || response.status !== 200) continue
        if (!(response.bodyBytes instanceof Uint8Array) || response.bodyBytes.length === 0) continue
        const hash = createHash('sha256').update(response.bodyBytes).digest('hex')
        if (!groups.has(hash)) groups.set(hash, { urls: new Set(), pages: new Set(), bytes: response.bodyBytes.length })
        const group = groups.get(hash)
        group.urls.add(image.src)
        group.pages.add(entry.url)
      }
    }
    const out = []
    for (const [hash, group] of groups) {
      // Two urls, because one url on many pages is the browser cache doing its job.
      if (group.urls.size < 2 || group.pages.size < 2) continue
      const urls = [...group.urls]
      const pages = [...group.pages]
      out.push(emit(duplicateAcrossPages, {
        page: pages[0],
        detail: `${urls.length} urls serve byte-for-byte the same ${kb(group.bytes)} image across ${pages.length} pages. Each one is downloaded separately, so moving between those pages refetches a picture the visitor already has.`,
        evidence: [
          text(`sha256 ${hash.slice(0, 16)}…`),
          ...urls.slice(0, EVIDENCE_LIMIT).map(url),
          ...pages.slice(0, EVIDENCE_LIMIT).map((page) => text(`used on ${page}`)),
        ],
        fix: 'Keep one copy, and point every page at that url.',
      }))
    }
    return out
  },
})

export const videoAutoplaySound = define({
  id: 'images.video-autoplay-sound',
  severity: 'medium',
  title: 'A video autoplays with sound',
  catches: '<video autoplay> without muted — a browser blocks it, and where it does not, it is the worst first impression a site can make.',
  run(ctx) {
    return perPage(ctx, videoAutoplaySound, (entry) => entry.page.videos.filter((video) => video.autoplay && !video.muted), (hits, entry) => ({
      detail: `${hits.length} ${plural(hits.length, 'video', 'videos')} on this page autoplay without muted. Every current browser refuses to start them, so the autoplay silently does nothing — and on the browsers that do allow it, the visitor gets sound they did not ask for.`,
      evidence: [url(entry.url), ...hits.slice(0, EVIDENCE_LIMIT).map((video) => html(`<video src="${video.src ?? '(no src)'}" autoplay> — not muted`))],
      fix: 'Add muted to any video that autoplays, or drop autoplay and let the visitor press play.',
    }))
  },
})

export const videoCaptionsMissing = define({
  id: 'images.video-captions-missing',
  severity: 'info',
  title: 'A video has no captions',
  catches: 'A <video> with no <track>, which is unusable to anyone who cannot hear it or is not using sound.',
  run(ctx) {
    return perPage(ctx, videoCaptionsMissing, (entry) => entry.page.videos.filter((video) => !video.hasTrack), (hits, entry) => ({
      detail: `${hits.length} ${plural(hits.length, 'video', 'videos')} on this page carry no <track>. Anyone who is deaf, or watching with the sound off — which is most people, most of the time — gets nothing from them.`,
      evidence: [url(entry.url), ...hits.slice(0, EVIDENCE_LIMIT).map((video) => html(`<video src="${video.src ?? '(no src)'}"> — no <track>`))],
      fix: 'Add a <track kind="captions"> with a WebVTT file for each video.',
    }))
  },
})

export const checks = [
  altMissing,
  dimensionsMissing,
  lazyOnFirstImage,
  notLazyBelowFold,
  legacyFormat,
  oversized,
  broken,
  duplicateAcrossPages,
  videoAutoplaySound,
  videoCaptionsMissing,
]
