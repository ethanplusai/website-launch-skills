# Images & media — the heaviest thing on most pages

Images are usually the largest bytes a page ships, the most common cause of layout shift, and the
part of a site most likely to be described to a screen reader as `IMG_4821.JPG`. The audit fetches
every image the crawled pages display — including every `srcset` candidate — because the bytes are
the evidence: the size it weighs, the format it really is, and the hash that proves two pages ship
the same file under two names. Video is checked for the two things that make it hostile: sound
nobody asked for, and no captions.

## How the audit sees an image

Every `<img src>` and every `srcset` candidate on every crawled page is fetched with GET, because
three of the findings below can only be made from the bytes: the real weight, the real format
(a `.png` that is actually a JPEG is common, and so is the reverse), and the content hash that
proves two urls are one file. Dimensions are measured from the file header rather than trusted
from the markup, which is how `head.og-image-small` can disagree with a declared `og:image:width`.

The image set is **capped** — it is the one probe set a large crawl really can fill — and whatever
the cap dropped is named in **Not covered**.

---

## Accessibility and layout

### `images.alt-missing` — high
**Means.** An `<img>` with no `alt` attribute at all.
**At launch.** A screen reader falls back to reading the file name aloud. Note that `alt=""` is
correct and is not reported: an empty alt is how you say "this image is decorative".
**Fix.** Describe what the image conveys in context, not what it depicts. A photo of a team on an
About page is "The team outside the workshop", not "group of people".
*WordPress:* the alt field in the media library is per-attachment, so an image reused in two places
carries one description — check it reads correctly in both.
*Any CMS:* make the alt field required in the content model rather than hoping.
**Cannot say.** Whether existing alt text is any good. That judgement is yours, and the report's
evidence lists the text it found.

### `images.dimensions-missing` — medium
**Means.** Neither `width`/`height` attributes nor an aspect-ratio style.
**At launch.** The page reflows as each image arrives — text jumps under a reader's eye, and the
layout-shift metric is the one Core Web Vital that is entirely avoidable in markup.
**Fix.** Emit the intrinsic width and height on every `<img>`; CSS can still resize it.
*Astro / Next / Nuxt:* the built-in image component adds them from the source file.
*Eleventy / Hugo:* the image shortcodes do the same.
*WordPress:* core adds them; a theme building its own `<img>` tags will not.
**Cannot say.** Whether the declared ratio matches the file.

---

## Loading strategy

### `images.lazy-on-first-image` — medium
**Means.** `loading="lazy"` on the first image on the page.
**At launch.** The hero is almost always the largest contentful paint. Lazy-loading it delays the
one picture the visitor is waiting for, and measurably worsens the metric it decides.
**Fix.** Load the hero eagerly, and add `fetchpriority="high"`. Lazy-load everything below it.
**Cannot say.** Which image is genuinely the largest paint — that needs a render, and the browser
tier's Lighthouse run reports it.

### `images.not-lazy-below-fold` — low
**Means.** Images past the third load eagerly.
**At launch.** Every one of them competes with the content the visitor can actually see.
**Fix.** `loading="lazy"` on everything below the fold.
**Cannot say.** Where the fold is. "Past the third image" is a heuristic, not a measurement.

### `images.legacy-format` — low
**Means.** A bare `.jpg` or `.png` with no `<picture>` and no `srcset`.
**At launch.** Modern formats are typically 25–50% smaller for the same quality, and every current
browser takes them.
**Fix.** Generate modern formats at build time and offer them with a fallback.
*Static hosts:* several offer image transformation at the edge, which avoids a build step.
**Cannot say.** Whether the saving is worth a build change on a small site.

### `images.oversized` — medium
**Means.** A single image over half a megabyte.
**At launch.** Usually a photo straight from a camera or an uncompressed export. One of these can
outweigh every other byte on the page.
**Fix.** Resize to the largest size actually displayed, then compress. Serve responsive sizes with
`srcset` so a phone never downloads the desktop version.
**Cannot say.** How large the image looks on screen, only what it weighs.

### `images.broken` — high
**Means.** An `<img src>` answers 404 or an error.
**At launch.** A visible hole in the page, plus a failed request on every view.
**Fix.** Correct the path. A base-path or case-sensitivity difference between a local machine and
the server is the usual cause — many local filesystems ignore case and no web server does.
**Cannot say.** Whether a `srcset` candidate covers for the broken `src`.

### `images.duplicate-across-pages` — low
**Means.** The same file, byte for byte, served under two different urls.
**At launch.** No visitor ever gets the second one from cache, so the same picture is downloaded
twice.
**Fix.** Reference one url. Usually one image uploaded twice into a media library.
**Cannot say.** Whether the duplication is deliberate (a versioned asset, say).

---

## Video

### `images.video-autoplay-sound` — medium
**Means.** `<video autoplay>` without `muted`.
**At launch.** Browsers block it, and where they do not it is the worst possible first impression.
**Fix.** Add `muted` and `playsinline` for a background video; otherwise require a click.
**Cannot say.** Whether the video is decorative or the point of the page.

### `images.video-captions-missing` — info
**Means.** A `<video>` with no `<track>`.
**At launch.** Unusable to anyone who cannot hear it — and to the much larger group watching with
the sound off.
**Fix.** Add a captions track. An auto-generated transcript, corrected by hand, is enough.
**Cannot say.** Whether the video has speech in it at all.

---

## Reviewing images by hand

The findings above are mechanical. Three questions remain that no check can answer, and they are
worth ten minutes with the screenshots the browser tier captured:

1. **Is this the real image, or a placeholder?** Stock photography that survived to launch is the
   single most common embarrassing find, and it is invisible to every check here — the file loads,
   weighs a sensible amount and has alt text.
2. **Does the alt text read correctly in context?** Read the page aloud, substituting the alt text
   where each image sits. Repetition ("Image of…", the same description three times) is obvious
   this way and invisible in a list.
3. **Does the image survive its crop?** A hero that reads well at desktop width can lose the
   subject entirely on a phone. Compare the mobile and desktop screenshots of the same page.

---

## Budgets worth agreeing

Numbers are easier to hold a line on than principles. Reasonable defaults for a content site:

- **Hero image:** under 200 KB, served responsively so a phone gets a phone-sized file.
- **Any single image:** under 500 KB — the threshold `images.oversized` uses.
- **Total page weight:** under 1.5 MB on first load, which `perf.page-weight` measures against a
  more forgiving 3 MB floor.
- **Formats:** modern format first with a JPEG or PNG fallback; SVG for logos and icons; never an
  SVG as a social card.
- **Dimensions:** every `<img>` carries width and height, without exception.

Write them into the content guidelines, not just the review. A budget that only exists in an audit
is re-litigated on every upload.

---

## What this dimension cannot tell you

- Whether an image is the right image, or whether it is a placeholder from a stock library. That is
  the screenshot pass in `reading-the-report.md`.
- Whether alt text is accurate or useful.
- Whether an image is visually broken rather than technically broken — a black rectangle loads
  perfectly well.
- Anything about images past the probe cap, or on pages the crawl did not reach. Both are named in
  **Not covered**.
