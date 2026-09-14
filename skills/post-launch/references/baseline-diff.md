# The baseline diff

`baseline.json` is a snapshot of a site: one record per page plus a handful of site-level facts.
`pre-launch` and `launch-audit` both write one. `post-launch` crawls production, builds the same
shape, and compares.

The comparison is only as good as the baseline. A baseline taken against staging is the right
comparison for "did the deploy survive the cutover". A baseline taken against the *old* site is the
right comparison for "did the rebuild keep what the old site had" — and it is a different question
with a much noisier answer, because a rebuild changes titles on purpose.

**Say which one you used.** A diff full of changed titles is alarming against staging and expected
against a predecessor.

---

## What a baseline records

Per page, keyed by url:

| Field | What it is | Moves at a launch? |
|---|---|---|
| `status` | the HTTP status the crawl got | no — a change here is a finding |
| `finalUrl` | where the request landed | no |
| `redirectChain` | the hops it took | no — a new chain is `baseline-new-redirect` |
| `title` | the `<title>` | sometimes, on purpose |
| `description` | the meta description | sometimes, on purpose |
| `canonical` | the canonical url | **almost never** |
| `robotsMeta` | the robots meta content | **never, except deliberately** |
| `h1` | the first h1 | sometimes |
| `jsonldTypes` | the schema types on the page | rarely |
| `analyticsTags` | which analytics tools were detected | **never** |
| `headers` | content-type, cache-control, x-robots-tag | rarely |
| `imageCount`, `linkCount` | counts, for context | freely |

Site level: `host`, `https`, `hsts`, `cert.expires`, `robotsTxtHash`, `sitemapUrls`,
`securityHeaders`.

---

## The four findings, and how to read each

### `cutover.baseline-missing-page` (high)

A url the baseline recorded that a crawl of production no longer reaches. Two causes, and they need
different fixes:

- **The page is gone.** Restore it, or redirect its url to whatever replaced it. A 404 on a url that
  existed last week loses every link to it.
- **The page is there and nothing links to it any more.** The crawl follows links and the sitemap;
  a page in neither is a page search engines will also stop reaching. Link it, or list it.

Check the crawl caps in **Not covered** before you act: a page dropped by `max-pages` is missing
from the crawl, not from the site.

### `cutover.baseline-changed` (medium)

One finding per field that moved, with before and after. Triage by field:

- **`canonical` changed** — take this seriously. A canonical that moved, or became relative, or now
  points at another page, hands that page's ranking somewhere else. Almost never intentional.
- **`robotsMeta` appeared** — a `noindex` on a page that did not have one is the site-wide blocker's
  quieter sibling. Was it intended for the thank-you page and applied to the layout?
- **`title` / `description` changed** — expected on a rebuild, unexpected on a deploy. What to look
  for is not the change but the *shape* of it: every page now carrying the same title, or a title
  that reverted to the framework default, or a description that is empty.
- **`h1` changed** — usually copy. Worth a glance, rarely worth a fix.
- **`jsonldTypes` changed** — a lost `Organization` or `Product` type means a rich result will stop
  appearing. A gained one is usually fine.

### `cutover.baseline-new-redirect` (medium)

A url that answered directly before and takes a hop now. Fine as a decision, expensive as an
accident: every internal link, sitemap entry and search result pointing at the old url now pays a
round trip, and the moment a second rule lands on the same path you have a chain.

If the move was intended, update the internal links and the sitemap so nothing depends on the
redirect. The redirect stays — for external links — but the site should not need it.

### `cutover.analytics-missing` (high)

A page that carried a tag in the baseline and carries none now. Nearly always one layout that lost
the snippet, which means it is one fix affecting many pages — group it that way when you report.

With no baseline, this falls back to `--expect-analytics <id>`: it looks for that exact measurement
id in the source of the start page. That is a weaker check and the report says so.

---

## Site-level: `securityHeaders`

`cutover.security-headers-regressed` (medium) fires per header that the baseline had and production
does not. The usual cause is that the header was never set by the application: it came from the old
host's config, or from a proxy in front of the old site, and the new platform has its own defaults.

Compare the whole set rather than the one header named. If one moved, the rest of the configuration
probably did not come across either.

---

## What the diff cannot tell you

- **Whether a change was intended.** It reports movement; a person decides. Never describe a diff
  entry as damage without saying which.
- **Anything about a page the baseline never saw.** New pages appear in `newPages` and are not
  findings — the baseline had nothing to say about them.
- **Anything about a page the crawl did not reach this time.** Read the caps in **Not covered**
  before concluding a page is gone.
- **Copy.** Two different titles are two strings. Whether the new one is *right* needs the
  signed-off copy and a person reading both.
