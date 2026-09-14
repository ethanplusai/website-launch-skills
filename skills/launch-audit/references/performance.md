# Performance — what the page asks for, and what it costs

There are two very different kinds of finding in this dimension, and confusing them is the fastest
way to give bad advice. The HTTP tier reads the markup and the sizes the server declared: it can
say a page references three megabytes of assets and blocks rendering on a script in the head. It
cannot say how fast the page *is*. The browser tier measures — Lighthouse, on a throttled
connection, per form factor — and those numbers are the ones worth arguing about.

So: HTTP-tier findings are *hints about what to look at*. Browser-tier findings are *measurements*.
When no browser was available, `perf.browser-tier-required` says so, and every number in this
section is a description of what the page asks for rather than of how it performs.

---

## The HTTP tier — hints

### `perf.page-weight` — medium
**Means.** The HTML plus the assets the audit could size already exceeds 3 MB.
**At launch.** "Already" is the important word: this is a floor, not a total. Fonts, third-party
scripts and anything loaded after render are on top.
**Fix.** Work the largest asset first, and it is almost always an image — see `images.oversized`
and `images.legacy-format`. After images, fonts; after fonts, JavaScript.
**Cannot say.** What the page weighs in a browser, or what it weighs on a repeat visit.

### `perf.request-count` — low
**Means.** More than a hundred referenced images, scripts, stylesheets and frames on one page.
**At launch.** Each is a request and, for off-origin ones, potentially a new connection.
**Fix.** Bundle what you control; look hard at anything requesting dozens of small files.
**Cannot say.** How many of them are cached, parallelised, or never fetched.

### `perf.render-blocking-script` — medium
**Means.** A `<script src>` in the head with no `defer`, no `async` and no `type="module"`.
**At launch.** The browser stops parsing the document until that script has been fetched and run.
On a slow connection it is the difference between a page appearing in one second and in four.
**Fix.** Add `defer` to anything that touches the DOM, `async` to anything independent, and move
what you can to the end of the body.
*Any framework:* the framework's own bundles are usually already deferred; this finding almost
always points at a hand-added tag — an analytics snippet, a font loader, a chat widget.
**Cannot say.** Whether the script is actually slow to fetch.

### `perf.hero-preload-missing` — info
**Means.** The page's first image is neither preloaded nor marked `fetchpriority="high"`.
**At launch.** The browser only discovers the hero after parsing enough of the document to reach
it, which delays the largest paint on most pages by a measurable margin.
**Fix.** `<link rel="preload" as="image">` for the hero, or `fetchpriority="high"` on the `<img>`.
Do it for one image per page — preloading several defeats the purpose.
**Cannot say.** Which image is really the largest contentful paint. Lighthouse says that.

### `perf.font-display-missing` — low
**Means.** An `@font-face` block with no `font-display` descriptor.
**At launch.** By default the browser hides the text for up to three seconds while the font loads.
Visitors on a slow connection see an empty page that is fully rendered.
**Fix.** `font-display: swap` for body text, `optional` where the fallback is close enough.
Subset the font, and self-host it — a font loaded from another origin costs a DNS lookup, a
connection and a round trip before a single letter appears.
**Cannot say.** Whether the font is actually slow, or whether the fallback looks acceptable.

### `perf.third-party-scripts` — info
**Means.** Every script served from a host that is not this site, grouped by host.
**At launch.** Read this list once, out loud, with whoever owns the site. Each entry is a
connection, a dependency, a privacy question and a thing that can break the page from outside.
Sites routinely carry tags from tools nobody uses any more.
**Fix.** Remove what is not used. Defer what is. Self-host what you can.
**Cannot say.** What each script does, or what it costs — that needs the rendered tier.

### `perf.browser-tier-required` — info
**Means.** No page was rendered, so no Core Web Vital was measured.
**At launch.** This is the honesty line for this dimension. LCP, CLS, INP, and the cost of the
JavaScript once it runs are all unmeasured.
**Fix.** Re-run with the browser tier available.
**Cannot say.** Anything measured — which is the point.

---

## The browser tier — measurements

### `browser.lighthouse-score` — medium
**Means.** Lighthouse scored the page below the bar: 90 on desktop, 70 on mobile. The start page is
measured on both form factors; the rest of the sample on mobile.
**At launch.** Mobile on a throttled connection is the honest test, and it is the one people skip
because their own machine is fast and near the server.
**Fix.** Work the largest metric in the evidence first:
- **LCP** — the hero image or a blocking font, nearly always. See the hero findings above.
- **TBT** — JavaScript. Ship less of it, or ship it later.
- **CLS** — images and embeds with no reserved space. See `images.dimensions-missing`.
**Cannot say.** How the page performs for real visitors. Lab numbers vary between runs, and a
single measurement from one machine is a signal, not a verdict.

### `browser.lighthouse-summary` — info
**Means.** The full score and metric set for the page, recorded as a baseline.
**At launch.** Keep it. The number that matters later is the difference after the performance
work, and this is the only "before" you will get.
**Fix.** Nothing from this row alone.
**Cannot say.** The accessibility score here is a floor, not a pass — see `accessibility.md`.

### `browser.failed-requests` — medium
**Means.** Requests the page actually made that did not load, including ones built by script and
therefore invisible in the markup.
**At launch.** A failed request is either a missing asset or a broken integration, and it costs
time either way.
**Fix.** Read the url. A 404 on a font, an image or a stylesheet is a path problem; a 403 or a
blocked request is often a CSP or a consent tool.
**Cannot say.** Whether the failure mattered visually.

### `browser.console-errors` — medium
**Means.** The page logged JavaScript errors on load.
**At launch.** The markup can be perfect while the page does nothing: a widget throwing on init, a
missing global, an integration failing. Console errors are the only HTTP-invisible signal that the
page is broken rather than merely slow.
**Fix.** Read the message and the source url in the evidence. Errors from an off-origin script are
that vendor's; errors from your own bundle are a build or an environment variable.
**Cannot say.** Whether the error has any visible effect.

---

## A note on field data

Everything above is **lab** data: one machine, one connection, one moment. Field data — what real
visitors experienced — is what search engines actually use, and a newly launched domain has none.
It takes about 28 days of traffic before field metrics appear at all.

Say this to clients explicitly at launch, because otherwise a good lab score reads as a finished
job and a missing field score reads as a failure. Neither is true. PageSpeed Insights field data
and the `--psi-key` flag are out of scope for v1 of this tool; the report's **Not covered** section
says so on every run.

---

## Ordering the work

Performance findings are easy to over-report and hard to prioritise. A sequence that holds for
almost every site:

1. **Images.** Resize, compress, serve modern formats, and add dimensions. On a typical launch this
   is more than half the total weight and all of the layout shift.
2. **The hero.** One image, loaded eagerly, with high priority, at the right size. This is usually
   the whole largest-contentful-paint story.
3. **Fonts.** Self-host, subset, and set `font-display`. Two families and four weights is a budget,
   not a limitation.
4. **Third-party scripts.** Remove what nobody uses, defer the rest. This is the only item on the
   list that needs a conversation rather than a commit.
5. **Your own JavaScript.** Last, because it is the most work for the least certain gain on a
   content site — and because the four items above usually make the numbers acceptable without it.

Measure after each step rather than at the end. A Lighthouse run before and after is thirty
seconds and stops the work becoming faith-based.

---

## What this dimension cannot tell you

- How fast the site is for real visitors, anywhere but here, right now.
- What a script costs to execute, unless the browser tier ran.
- Whether the cause of a slow page is the origin, the CDN, or the network in between.
- Anything about pages the browser tier did not render. The sample is named in **Not covered**.
