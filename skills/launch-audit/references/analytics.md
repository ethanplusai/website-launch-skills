# Analytics & tracking — will you be able to tell whether this worked

A launch without measurement is a launch you cannot learn from. The question this dimension answers
is narrow and important: is something counting, is it counting everywhere, is it counting once,
and is it counting into the right property. It also raises the two questions that are not
engineering questions at all — whether a cookie is set before anybody was asked, and whether the
tools measuring the site are tools the site's owner knows about.

The HTTP tier reads the markup: which tools' signatures appear, with which ids, on which pages.
The browser tier watches the network: whether a hit is actually sent. The gap between the two is
the single most valuable finding here, because a tag that is installed and not firing looks
perfect in the source.

---

## Installed, or not

### `analytics.none-detected` — high
**Means.** No analytics signature anywhere on the crawled site.
**At launch.** No baseline. Whatever happens in the first month cannot be compared to anything,
and "did the new site work?" becomes an opinion.
**Fix.** Install something before launch, not after — a day of missing data is a day you cannot
reconstruct. A privacy-first, cookieless tool is enough for most sites and avoids the consent
question below entirely.
**Cannot say.** Whether measurement happens server-side, at the edge, or in a tag manager the
audit's signature list does not know.

### `analytics.summary` — info
**Means.** The list of every tool detected, with its ids and how many pages carry it.
**At launch.** Read it once and ask "did we mean to install all of these?". Sites accumulate tags:
an agency's, a previous agency's, a campaign that ended two years ago. Each one is a third-party
script and a privacy disclosure.
**Fix.** Remove what nobody uses.
**Cannot say.** Whether a detected tag is configured correctly, or who has access to the property.

### `analytics.missing-on-pages` — medium
**Means.** The tag is on most pages and absent from some.
**At launch.** Usually one template that builds its own `<head>` — a landing page, a checkout, a
campaign page. The pages that matter most are the ones most likely to be special-cased.
**Fix.** Put the tag in the one layout every page inherits from, and delete every other copy.
*Astro / Eleventy / Hugo:* a page using a different base layout.
*Next / Nuxt / SvelteKit:* a route group with its own root layout.
*WordPress:* a page builder template that bypasses the theme header.
**Cannot say.** Whether the missing pages get traffic.

### `analytics.duplicate-install` — medium
**Means.** One page installs the same tool twice.
**At launch.** Pageviews double and bounce rate halves, so every number is wrong in a way that
looks plausible. It is usually discovered months later.
**Fix.** Find the second copy — commonly a tag in the layout and the same tag added again through
a plugin or a tag manager.
**Cannot say.** Whether the duplicate actually double-counts; some tools deduplicate.

### `analytics.inconsistent-ids` — high
**Means.** Two different measurement ids for one tool across the site.
**At launch.** Half the traffic reports to a property nobody is looking at. The usual cause is an
old property id surviving in one template through a rebuild.
**Fix.** Decide which property is the real one, use that id everywhere, and archive the other so
it cannot be confused later.
**Cannot say.** Which property is the one with the history in it.

---

## Firing, or not (browser tier)

### `browser.analytics-not-firing` — high
**Means.** A tag is present in the markup and the page made no request to that tool's collector.
**At launch.** This is the failure the HTTP tier structurally cannot see. Causes, in rough order
of frequency: a consent gate that never resolves; a misconfigured or non-existent property id; a
content-security-policy blocking the collector; a script error earlier on the page stopping
execution before the tag runs; an ad blocker in the rendering environment.
**Fix.** Open the page, open the network panel, filter for the collector host, and reload. Then
check the property's real-time view — that is the only proof that data arrives.
**Cannot say.** Whether the hit was *recorded* at the other end. A request leaving the browser is
necessary and not sufficient.

### `browser.consent-missing` — info
**Means.** Cookies were set on load, by a cookie-setting tool, with no consent banner visible.
**At launch.** This is the shape of a GDPR/ePrivacy problem, and it is a question for a lawyer and
the site's owner rather than a bug to fix in a template. Report it as a question.
**Fix.** Either gate the cookie-setting tools behind consent, or move to a tool that does not set
cookies. A banner that appears *after* the cookie is set solves nothing.
**Cannot say.** Whether the site is subject to those rules, whether the tool is exempt, or whether
consent was obtained some other way. The audit never clicks a banner, so it also cannot say what
happens once somebody accepts.

---

## The verification pass — before you call analytics done

The audit proves installation and, with a browser, transmission. Four things remain, and all four
need somebody logged in:

1. **Real-time check.** Load the site, watch the property's real-time view, confirm your own visit
   appears. Do this for every tool in `analytics.summary` that anybody actually uses.
2. **Conversion event.** A form submission or a phone tap should register as an event. A launch
   where "pageviews" is the only metric cannot answer the question the client will ask.
3. **Access.** The client must own the property, not the agency. Confirm the client's account has
   admin access before launch — recovering a property from a departed contractor is a long month.
4. **Search Console.** Verify the production property and submit the sitemap. It is the only place
   indexing problems become visible, and it collects no history before it is verified.

Items 3 and 4 appear in the report's **Ops & access readiness** checklist as human items, because
no request can confirm them.

---

## How the detection works, and what it misses

The HTTP tier matches a bundled list of tag signatures against each page's HTML: the snippet
shapes and id formats used by the common analytics, tag-management, product-analytics and
advertising tools. It reports the tool's name and, where the signature exposes one, the
measurement id.

Three consequences worth knowing before you trust a clean section:

- **A tag manager hides its contents.** A container in the markup is one detection; the ten tags it
  injects are not in the HTML at all. On a site using one, read `browser.analytics-not-firing` and
  the container's own published version rather than this list.
- **Server-side and edge measurement is invisible.** There is nothing in the markup to detect, so a
  site measured entirely server-side reports `analytics.none-detected`. That is a true statement
  about the markup and a false impression about the site — check before raising it.
- **An unknown tool is not reported.** The signature list covers the common tools; something
  bespoke will not appear. `perf.third-party-scripts` lists every off-origin script, which is the
  place an unrecognised collector shows up.

---

## What this dimension cannot tell you

- Whether data is arriving in the property. Only the property's own view says that.
- Whether the property is configured — goals, filters, excluded traffic, retention.
- Whether measurement is happening server-side or at the edge, where there is nothing in the
  markup to detect.
- Whether the site's tracking is lawful where its visitors are.
- Anything about pages the crawl or the browser sample did not cover — both are named in
  **Not covered**.
