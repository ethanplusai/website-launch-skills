# Head & metadata — what the page says about itself

The `<head>` is the part of a page nobody looks at and everybody sees: it is the text in a search
result, the card when a link is shared, the icon in a browser tab, the language a screen reader
speaks, and the structured data that decides whether a listing gets stars and a price. It is also
the part most likely to still hold a starter template's defaults, because nothing on screen breaks
when it is wrong. Findings here are cheap to fix and expensive to leave: a duplicated title across
forty pages is one template edit, and it is also forty pages competing with each other.

---

## Title and description

### `head.title-missing` — high
**Means.** The page has no `<title>`.
**At launch.** Search results and browser tabs fall back to the url, which reads as broken.
**Fix.** Give every route a title. Build it from the page's own data, never a constant.
**Cannot say.** What the title should say.

### `head.title-framework-default` — high
**Means.** The title is a starter-template default — `Document`, `Astro`, `Create Next App`, `Home`.
**At launch.** It is the clearest possible signal that a page shipped unfinished.
**Fix.** Set the real title in the layout and in each route that overrides it.
*Astro / Eleventy / Hugo:* the base layout's fallback title is usually the culprit.
*Next / Nuxt / SvelteKit:* a default in the root metadata that a route forgot to override.
**Cannot say.** Whether an unusual title is a default from a template it does not know.

### `head.title-duplicate` — high
**Means.** Several pages share one title.
**At launch.** Search engines pick one page per query; identical titles make them choose for you,
and the search result gives a visitor no way to tell the pages apart.
**Fix.** Template it: page name, then a separator, then the site name.
*WordPress:* the SEO plugin's title template for that post type.
**Cannot say.** Whether two pages are genuinely the same thing.

### `head.title-length` — low
**Means.** The title is under ten characters or past about sixty.
**At launch.** Long titles are truncated mid-word in results; very short ones waste the line.
**Fix.** Aim for the most specific words first, so a truncation still reads.
**Cannot say.** The exact cut-off, which varies by device and query.

### `head.description-missing` — medium
**Means.** No meta description.
**At launch.** The search snippet becomes whatever sentence the crawler finds first, which is
often a cookie notice or a nav label.
**Fix.** Write one per page, describing what the page is for.
**Cannot say.** Whether the auto-generated snippet is acceptable.

### `head.description-duplicate` — medium
**Means.** One description repeated across pages, usually the site tagline.
**At launch.** Same problem as duplicate titles, in the line beneath them.
**Fix.** Write per page, or generate from the page's own first paragraph.
**Cannot say.** Which page deserves the shared text.

### `head.description-length` — low
**Means.** Under fifty characters or past about a hundred and sixty.
**At launch.** Short descriptions waste the space; long ones are cut.
**Fix.** One or two sentences that would make somebody click.
**Cannot say.** How a given query will rewrite the snippet.

---

## Headings and document basics

### `head.h1-missing` — medium
**Means.** No `<h1>` on the page.
**At launch.** The main heading was styled as a `div`, so nothing announces what the page is —
to a screen reader or to a crawler.
**Fix.** Make the visible page title an `h1`. Style it however you like.
**Cannot say.** Which element was *meant* to be the heading.

### `head.h1-multiple` — low
**Means.** More than one `h1`.
**At launch.** Common when the site name in the header is an `h1` alongside the page heading.
Not harmful on its own; it weakens the signal.
**Fix.** One `h1` per page; the site name belongs in a link, not a heading.
**Cannot say.** Whether the extra heading is deliberate in a sectioned layout.

### `head.heading-skip` — low
**Means.** A level is skipped — `h1` then `h3`.
**At launch.** Screen reader users navigate by heading level, so a skipped level reads as a
missing section.
**Fix.** Choose levels by structure and set size in CSS.
**Cannot say.** Whether the structure is wrong or only the markup.

### `head.heading-empty` — low
**Means.** A heading with no text.
**At launch.** Usually a spacer or an unfilled CMS field. It announces nothing and interrupts.
**Fix.** Remove it, or fill it.
**Cannot say.** Whether an image inside it carries the meaning — check the alt text.

### `head.lang-missing` — medium
**Means.** `<html>` has no `lang` attribute.
**At launch.** Screen readers guess a pronunciation, and browsers guess whether to offer
translation. Both guess wrong regularly.
**Fix.** Set `lang` on the root element, per language.
**Cannot say.** Whether the declared language matches the content.

### `head.charset-missing` — low
**Means.** No character encoding declared.
**At launch.** Anything but plain ASCII may render as mojibake, and the browser has to re-parse.
**Fix.** `<meta charset="utf-8">` as the first thing in the head.
**Cannot say.** Whether the server's content-type header already declares it.

### `head.viewport-missing` — high
**Means.** No viewport meta tag.
**At launch.** Phones render the page at desktop width and shrink it. The site is unusable on
mobile and marked as such by search engines.
**Fix.** `<meta name="viewport" content="width=device-width, initial-scale=1">`.
**Cannot say.** Whether the layout is responsive — only that it is not being told to be.

### `head.viewport-blocks-zoom` — medium
**Means.** `user-scalable=no` or a maximum scale of 1.
**At launch.** It removes pinch-zoom from everyone, including people who need it to read.
**Fix.** Delete those values.
**Cannot say.** Whether a library added the tag rather than the author.

### `head.duplicate-id` — low
**Means.** The same `id` on two elements.
**At launch.** Breaks label targets, in-page anchors and any script selecting by id.
**Fix.** Make ids unique; generate them from stable content keys.
**Cannot say.** Which of the two is the one being targeted.

### `head.meta-outside-head` — medium
**Means.** A meta tag sits in the body.
**At launch.** Nothing reads it there, so the page appears to have no description or no card.
**Fix.** Move it into the head — usually a component rendering meta tags in the wrong slot.
**Cannot say.** Whether a script moves it at runtime.

### `head.meta-duplicate` — low
**Means.** The same meta name declared twice.
**At launch.** Only the first is used, and it is usually not the one somebody edited.
**Fix.** Find the second source — a layout and a page both emitting it.
**Cannot say.** Which one was intended.

---

## Icons, manifest and theme

### `head.favicon-missing` — medium
**Means.** No icon is linked.
**At launch.** Every tab, bookmark and history entry shows a blank square.
**Fix.** Ship an icon and link it. Modern sites need very few sizes; one SVG plus one PNG covers
most of it.
**Cannot say.** Whether a root `/favicon.ico` is being picked up implicitly by browsers.

### `head.favicon-broken` — medium
**Means.** A declared icon url does not load.
**At launch.** Same visible result as having none, plus a 404 on every page view.
**Fix.** Correct the path — usually a leading-slash or base-path change.
**Cannot say.** Whether a different icon is being served from the root by convention.

### `head.apple-touch-icon-missing` — low
**Means.** No `apple-touch-icon`.
**At launch.** A site saved to an iOS home screen is shown as a screenshot of the page.
**Fix.** Add a 180×180 PNG and link it.
**Cannot say.** Whether anyone saves the site to a home screen.

### `head.manifest-missing` — info
**Means.** No web app manifest.
**At launch.** Only matters if the site should be installable.
**Fix.** Add one if you want install prompts and a proper app name.
**Cannot say.** Whether the site wants to be an app.

### `head.theme-color-missing` — info
**Means.** No `theme-color`.
**At launch.** Mobile browser chrome stays default grey instead of matching the brand.
**Fix.** One meta tag, ideally one per colour scheme.
**Cannot say.** Which colour is right.

---

## Social cards

### `head.og-missing` — medium
**Means.** An Open Graph property is absent.
**At launch.** A shared link renders as a bare url with no title, description or image, in every
chat app and social network.
**Fix.** Emit `og:title`, `og:description`, `og:image`, `og:url` and `og:type` from the page's own
data, in the layout so no route can forget.
**Cannot say.** How each network will render the result.

### `head.og-image-broken` — high
**Means.** The card image url does not load.
**At launch.** Every share of every page becomes a text-only preview, and the caches that store it
are slow to refresh after a fix.
**Fix.** Correct the url and make it absolute — relative og:image values are the usual cause.
**Cannot say.** Whether a network has already cached the broken version.

### `head.og-image-not-raster` — medium
**Means.** The card image is an SVG, or not an image.
**At launch.** Social networks do not render SVG cards; the preview falls back to nothing.
**Fix.** Export a PNG or JPEG.
**Cannot say.** Whether a raster version exists elsewhere.

### `head.og-image-small` — medium
**Means.** The card image is smaller than 1200×630.
**At launch.** It is upscaled into blur or cropped into a small square.
**Fix.** Generate cards at 1200×630. Most frameworks have a build-time card generator.
**Cannot say.** How each network crops.

### `head.og-image-dimensions-missing` — low
**Means.** No `og:image:width` / `og:image:height`.
**At launch.** The first share of a page renders before the image is fetched and measured, which
is exactly the share that matters.
**Fix.** Emit both alongside the image url.
**Cannot say.** Whether the declared dimensions match the file — the audit measures the bytes.

### `head.og-url-mismatch` — medium
**Means.** `og:url` and the canonical disagree.
**At launch.** Shares, likes and counts accumulate against two different urls.
**Fix.** Emit both from one value.
**Cannot say.** Which one is right.

### `head.twitter-card-missing` — low
**Means.** No card format declared.
**At launch.** Some networks fall back to Open Graph cleanly; others render plain text.
**Fix.** Add `twitter:card` — `summary_large_image` for a 1200×630 image.
**Cannot say.** Whether the Open Graph fallback is sufficient for your audience.

---

## Structured data

### `head.jsonld-invalid` — high
**Means.** A JSON-LD block does not parse.
**At launch.** The whole block is discarded — a trailing comma costs the entire schema.
**Fix.** Generate JSON-LD by serialising an object, never by string concatenation in a template.
*WordPress:* two plugins both emitting schema is a common source of malformed output.
**Cannot say.** Whether the data would have been correct if it parsed.

### `head.jsonld-missing-required` — medium
**Means.** A node parses but lacks a property its type requires.
**At launch.** It cannot produce the rich result it was written for, silently.
**Fix.** Fill the missing property, or drop the type if the data does not exist.
**Cannot say.** Whether the rich result would appear even when complete — that is a ranking
decision, not a markup one.

### `head.jsonld-url-broken` — medium
**Means.** A `url`, `logo` or `image` inside the structured data does not load.
**At launch.** A broken logo url disqualifies the organisation card.
**Fix.** Use absolute, production urls; generate them from the same site-url value the canonical
uses.
**Cannot say.** Whether the image meets each rich result's size rules.

### `head.jsonld-on-noindex` — low
**Means.** Structured data on a page that is not indexable.
**At launch.** Harmless, and usually a sign that the noindex is the accident.
**Fix.** Check which of the two is wrong.
**Cannot say.** Which one was intended.

### `head.jsonld-types-summary` — info
**Means.** The inventory of schema types the site declares, grouped by template.
**At launch.** Read it once: an unexpected type, or a type on only half the pages of a template,
is visible here and nowhere else.
**Fix.** Nothing, unless the list surprises you.
**Cannot say.** Whether the types are the right ones for the business.

---

## Rendered head (browser tier)

### `browser.rendered-head-differs` — medium
**Means.** After JavaScript ran, the title, description, canonical or robots meta is different from
what the server sent.
**At launch.** A crawler that executes JavaScript sees one thing and a crawler that does not sees
another. When the difference is the canonical or the robots directive, it is an indexing bug that
is reproducible only in a browser — which is why it takes the browser tier to find it.
**Fix.** Render the head on the server. A client-side head library that overwrites values after
load is the usual cause.
**Cannot say.** Which version a given crawler used.

---

## What this dimension cannot tell you

- Whether the words are good. Titles, descriptions and headings are judged here for presence,
  uniqueness and length — never for quality. That pass is yours, from the evidence in the report.
- Whether structured data reflects reality. A `Product` with a price is checked for shape, not
  truth.
- How any particular network renders a card. Sizes here follow the common minimums.
