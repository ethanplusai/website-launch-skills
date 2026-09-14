# Indexability — can this site be found at all

Everything else in the report assumes search engines can see the site. This dimension checks that
assumption: whether the site invites crawlers or turns them away, whether the sitemap and
`robots.txt` describe the site that actually exists, and whether each page says which url counts.
It also covers **crawl & inventory** — what the audit could and could not reach — because "this
page was never crawled" and "this page cannot be indexed" are the same failure seen from two
sides. A single left-over staging directive here is the one finding that can make an otherwise
perfect launch invisible, which is why the first check in this file is the only `blocker` the
auditor ever raises on its own.

Read this dimension first. If `indexability.site-noindex` fires on production, nothing below it
matters until it is fixed.

---

## Crawl & inventory

### `inventory.target-unreachable` — blocker
**Means.** The audit could not read the url it was pointed at. Its title says which of three:

- *The start url was never fetched* — the crawl never asked. Usually `robots.txt` disallows it;
  the depth limit and the page budget can also do it. There is no status code, because nothing
  answered and nothing declined to.
- *The start url never answered* — the crawl asked and got nothing back: DNS, TLS, a refused
  connection, a timeout.
- *The start url answered, and nothing the crawl fetched was a page* — a 200 carrying a PDF, a
  JSON document or an empty body, with no HTML anywhere else in the crawl either.

**At launch.** This is the one finding that says the rest of the report is *empty* rather than
*clean*. Every HTTP-tier check reads the crawl, and a crawl of nothing gives every one of them
nothing to object to — so an audit of a host that does not exist otherwise prints `blocker 0` and
a page of green, indistinguishable from a site that passed. Read the second sentence of the
detail: it says whether *nothing* was read, or only some of it. A start url that failed while the
sitemap seeded pages that did parse leaves a report that is narrow rather than empty, and it says
which pages it covers.
**Fix.** Depends on the state. Allow the url in `robots.txt` (or re-run with `--ignore-robots`,
which is reported in `Not covered`); check the url for a typo, check DNS for its host, check that
the host is serving and that a firewall or WAF is not refusing an unfamiliar user agent; or point
the audit at an HTML page. If the site is behind a VPN or basic auth, this tool cannot reach it at
all — that is out of scope, and the report says so rather than pretending.
**Cannot say.** Whether the site is down for everyone or only from here. One machine's failure to
connect is not a global outage, and this check does not claim it is.

### `inventory.non-200-page` — high
**Means.** A url the site links to, or lists in its sitemap, answered 4xx or 5xx.
**At launch.** These are the pages visitors and crawlers will hit on day one. A 404 on a linked
page is a dead end; a 500 is a page that will be retried, indexed as an error, and then dropped.
**Fix.** Fix the route or remove the link and the sitemap entry. A page that is genuinely gone
should 404 or 410 deliberately and not be linked from anywhere.
**Cannot say.** Whether the page is *supposed* to exist. Only the site's owner knows that.

### `inventory.unreachable-page` — medium
**Means.** The request failed outright — DNS, TLS, a refused connection, a timeout — so there is
no status code at all.
**At launch.** This is usually a host that is not finished, a certificate that does not cover the
name, or a firewall that dislikes an unfamiliar user agent. All three are launch blockers in
practice even though the audit cannot prove which one it is.
**Fix.** Request the url yourself from outside the office network and read the error.
**Cannot say.** Whether the failure is the site's fault or the network's between here and it.

### `inventory.orphan-page` — medium
**Means.** The sitemap advertises a page that nothing on the site links to.
**At launch.** An orphan can be indexed but never browsed. Search engines treat internal links as
a vote of importance, so an orphan starts with none.
**Fix.** Link it from somewhere real — a nav item, an index page, a related-content block — or
drop it from the sitemap if it is not meant to be found.
**Cannot say.** Whether the page is deliberately unlinked (a campaign landing page often is).

### `inventory.unlisted-page` — low
**Means.** A page the crawl reached by following links is missing from the sitemap.
**At launch.** Not fatal — crawlers follow links — but the sitemap is the fastest path to
discovery for a brand-new domain with no inbound links yet, which is exactly the launch case.
**Fix.** Regenerate the sitemap after the final build rather than by hand.
*Astro:* the sitemap integration reads the built routes, so a page missing here usually means the
route is excluded or the build ran before the page existed.
*Next / Nuxt / SvelteKit:* a dynamic sitemap route has to enumerate the same data source the pages
do; when it drifts, this is the finding.
*WordPress:* check the post type is marked public and is not excluded in the SEO plugin.
**Cannot say.** Whether the omission was deliberate.

### `inventory.deep-page` — low
**Means.** The crawl only reached the page at depth four or deeper.
**At launch.** Depth is a rough proxy for how much a site believes in a page. Anything important
that sits four clicks down is hard for both people and crawlers to find.
**Fix.** Add a link from a hub page, a footer section, or a category index.
**Cannot say.** Whether the page matters. A deep archive page is fine; a deep service page is not.

### `inventory.capped` — info
**Means.** The crawl or one of the probe sets stopped at its limit, and this names what it did not
look at.
**At launch.** This is the honesty line. Treat it as "unknown", never as "clean".
**Fix.** Re-run with a higher `--max-pages` or `--max-depth` if the capped urls matter.
**Cannot say.** Anything about the urls it skipped — that is the point of the finding.

---

## Robots and crawl directives

### `indexability.site-noindex` — blocker
**Means.** A `noindex` meta tag, an `X-Robots-Tag: noindex` header, or a blanket `Disallow: /` is
telling every search engine to stay away from the whole site.
**At launch.** This is the single most common launch disaster: the staging setting that shipped.
The site looks perfect and is invisible, often for weeks before anybody notices.
**Fix.** Remove the directive from the production deployment, then request indexing for the home
page.
*Astro / Eleventy / Hugo:* usually a hard-coded `<meta name="robots">` in the base layout.
*Next / Nuxt / SvelteKit:* usually an environment-conditional that reads the wrong variable in the
production build.
*WordPress:* Settings → Reading → "Discourage search engines", which also sets the header.
*Static hosts (Vercel, Netlify, Cloudflare Pages):* preview deployments add the header themselves;
confirm you are testing the production domain and not a preview url.
**Cannot say.** Whether this is intentional — pass `--staging` when auditing a staging target and
the finding drops to `info`.

### `indexability.page-noindex-in-sitemap` — high
**Means.** A page the sitemap advertises tells crawlers not to index it.
**At launch.** The two signals contradict each other. Search engines resolve it by dropping the
page and trusting the sitemap a little less.
**Fix.** Decide which is right: remove the `noindex`, or remove the sitemap entry.
**Cannot say.** Which of the two was the mistake.

### `indexability.nosnippet-unintended` — low
**Means.** A page carries `nosnippet`, `noarchive` or a `max-snippet` that suppresses its search
result text.
**At launch.** The page ranks and then shows no description, which costs clicks silently.
**Fix.** Remove the directive unless the page is paywalled or licensed content.
**Cannot say.** Whether the suppression is a legal or licensing requirement.

### `indexability.robots-unfetchable` — high
**Means.** `robots.txt` returned an error rather than a file or a clean 404.
**At launch.** A 404 means "crawl everything" and is fine. A 5xx means "stay out entirely" to
several major crawlers, which is not.
**Fix.** Serve a real `robots.txt`, or let the path 404 cleanly.
*Static hosts:* a catch-all rewrite that routes `/robots.txt` into the app is the usual cause.
**Cannot say.** Whether the error is intermittent; it was fetched once.

### `indexability.robots-sitemap-line-missing` — medium
**Means.** A sitemap exists but `robots.txt` never names it.
**At launch.** The `Sitemap:` line is where crawlers look first on a domain they have never seen.
**Fix.** Add `Sitemap: https://<production host>/sitemap.xml` to `robots.txt`.
**Cannot say.** Whether the sitemap was submitted in a search console instead.

### `indexability.robots-sitemap-other-host` — high
**Means.** The `Sitemap:` line points at a different host from the site being audited.
**At launch.** This is nearly always the old domain or the staging host, and it means the sitemap
that gets read describes a different site.
**Fix.** Make the sitemap url absolute against the production host and rebuild.
**Cannot say.** Whether a cross-host sitemap is deliberate (it is valid when both hosts are
verified in the same search console property, but it is rarely what was meant).

### `indexability.robots-blocks-assets` — high
**Means.** A `Disallow` rule covers CSS or JavaScript the pages load.
**At launch.** Google renders pages before ranking them. Blocked CSS means it sees an unstyled
page, and it will judge layout, mobile-friendliness and content accordingly.
**Fix.** Remove the rule. There is almost never a reason to hide a stylesheet from a crawler.
*WordPress:* legacy advice to block `/wp-includes/` and `/wp-content/plugins/` is the usual source.
**Cannot say.** Whether a blocked asset is actually used above the fold.

### `indexability.ai-crawler-policy` — info
**Means.** The table of what the site currently tells each AI crawler, split between the ones that
gather training data and the ones that fetch a page to answer a live question.
**At launch.** Most sites have never made this decision; this finding exists so it gets made
rather than inherited from a template.
**Fix.** Decide, then write it down. Blocking training crawlers and allowing search-answer
crawlers is a common middle position; blocking everything removes the site from AI answers too.
**Cannot say.** Whether any crawler obeys the file. It is a request, not a control.

### `indexability.llms-txt` — info
**Means.** Whether `/llms.txt` exists and is shaped like the proposal describes.
**At launch.** Optional and not standardised. Reported so the choice is visible.
**Fix.** Add one if you want a curated map of the site for language models; nothing breaks without.
**Cannot say.** Whether anything reads it.

---

## The sitemap

### `indexability.sitemap-missing` — high
**Means.** No sitemap at any conventional path, and none named in `robots.txt`.
**At launch.** A new domain has no inbound links. The sitemap is the discovery mechanism.
**Fix.** Generate one at build time and reference it from `robots.txt`.
*Astro:* the sitemap integration. *Next / Nuxt / SvelteKit:* a sitemap route or a build-time
generator. *Eleventy / Hugo:* a template that walks the collection list. *WordPress:* core emits
one at `/wp-sitemap.xml`; an SEO plugin replaces it at `/sitemap_index.xml`.
**Cannot say.** Whether one exists at an unconventional path nothing advertises.

### `indexability.sitemap-invalid` — high
**Means.** The sitemap, or a child of a sitemap index, did not parse or could not be fetched.
**At launch.** A crawler that cannot parse the file gets nothing from it, and a partly-broken
index is worse than none because it looks fine.
**Fix.** Validate the XML, and confirm every `<loc>` in the index resolves.
**Cannot say.** Which generator produced it.

### `indexability.sitemap-url-not-200` — high
**Means.** A url the sitemap lists does not answer 200.
**At launch.** Every one of these is a page the site is actively advertising as live and is not.
**Fix.** Regenerate the sitemap from the current route list, not from a stored copy.
**Cannot say.** Whether the url used to work.

### `indexability.sitemap-noindexed-url` — high
**Means.** A sitemap url is blocked by `robots.txt` or carries a `noindex` header.
**At launch.** Same contradiction as `page-noindex-in-sitemap`, from the other direction.
**Fix.** Remove the url from the sitemap or lift the block.
**Cannot say.** Which signal was intended.

### `indexability.sitemap-other-host` — high
**Means.** The sitemap lists urls on a different host from the one being audited.
**At launch.** The sitemap was generated against staging or the pre-migration domain.
**Fix.** Set the site url in the build configuration and regenerate.
*Astro:* `site` in the config. *Next / Nuxt / SvelteKit:* the public site-url environment variable.
*Hugo:* `baseURL`. *WordPress:* Settings → General → Site Address.
**Cannot say.** Whether the other host is a legitimate alternate.

### `indexability.sitemap-too-large` — medium
**Means.** One sitemap file exceeds 50,000 urls.
**At launch.** Crawlers stop reading at the limit; everything past it is invisible.
**Fix.** Split into several sitemaps behind a sitemap index.
**Cannot say.** Whether the extra urls matter.

### `indexability.sitemap-lastmod-future` — low
**Means.** A `<lastmod>` is dated in the future.
**At launch.** Crawlers discount `lastmod` values they cannot believe, which removes the one
signal that tells them what changed since last time.
**Fix.** Stamp `lastmod` from the content's real modification time, or omit it.
**Cannot say.** Whether the clock or the generator is wrong.

---

## Canonicals and language

### `indexability.canonical-missing` — medium
**Means.** The page declares no canonical url.
**At launch.** Any site reachable at more than one url — www and apex, with and without a trailing
slash, with tracking parameters — needs one page to be the authoritative one.
**Fix.** Emit a self-referencing absolute canonical on every indexable page.
*Astro / Eleventy / Hugo:* one line in the base layout built from the configured site url.
*Next / Nuxt / SvelteKit:* the head/metadata helper, fed by the same public site url.
*WordPress:* core emits one; a theme that builds its own `<head>` may not.
**Cannot say.** Whether duplicate urls actually exist.

### `indexability.canonical-relative` — medium
**Means.** The canonical is a path rather than a full url.
**At launch.** A relative canonical resolves against whatever host served the page, so it says
something different on www, on apex and on staging — which defeats the purpose.
**Fix.** Make it absolute, including the scheme and the production host.
**Cannot say.** Whether the relative form currently resolves correctly by accident.

### `indexability.canonical-other-host` — high
**Means.** The canonical points at a different host.
**At launch.** This tells search engines the real page lives somewhere else — usually staging or
the old domain — and hands the ranking to a url that may not exist.
**Fix.** Set the site url in the build configuration and rebuild; check any hard-coded values.
**Cannot say.** Whether a cross-host canonical is a deliberate syndication choice.

### `indexability.canonical-to-redirect-or-404` — high
**Means.** The canonical points at a url that redirects or does not exist.
**At launch.** A canonical has to point at a final, 200-answering url. One that redirects is
ignored, and one that 404s can deindex the page that declared it.
**Fix.** Point it at the final url, not the pre-redirect form (watch trailing slashes and
www/apex).
**Cannot say.** Whether the redirect target is the right page.

### `indexability.canonical-multiple` — high
**Means.** The page declares more than one canonical url.
**At launch.** Search engines ignore all of them when they conflict.
**Fix.** Find the second source — usually a theme and a plugin, or a layout and a page-level
override — and remove one.
**Cannot say.** Which one was intended.

### `indexability.canonical-header-mismatch` — medium
**Means.** A `Link: rel="canonical"` header disagrees with the tag in the markup.
**At launch.** Usually a CDN or an edge rule adding a header nobody remembers configuring.
**Fix.** Remove whichever is wrong; keep one source of truth.
**Cannot say.** Which layer added the header.

### `indexability.hreflang-invalid` — medium
**Means.** An `hreflang` value is not a valid language or language-region code.
**At launch.** Invalid codes are dropped silently, so the cluster stops working without an error.
**Fix.** Use a language subtag, optionally a hyphen and a region subtag: `en`, `en-gb`, `pt-br`.
**Cannot say.** Whether the code names the language the page is actually written in.

### `indexability.hreflang-not-reciprocal` — medium
**Means.** A page points at an alternate that does not point back.
**At launch.** Search engines discard one-way clusters entirely, so a partly-wired set of
translations behaves as if none of it existed.
**Fix.** Every page in a cluster lists every page in the cluster, including itself.
**Cannot say.** Whether the missing page exists at all.

### `indexability.hreflang-no-x-default` — low
**Means.** The cluster has no `x-default` entry.
**At launch.** Nothing tells a search engine what to serve a visitor whose language you do not
cover.
**Fix.** Add `hreflang="x-default"` pointing at the language selector or the primary language.
**Cannot say.** Whether you want a default at all.

---

## What this dimension cannot tell you

- Whether a page *should* be indexed. Every "should" here is a business decision.
- What search engines have actually indexed. That lives in a search console, not in the markup.
- Whether a directive is obeyed. `robots.txt` and `hreflang` are requests to well-behaved crawlers.
- Anything about a url the crawl never reached — see `inventory.capped` and the report's
  **Not covered** section.
