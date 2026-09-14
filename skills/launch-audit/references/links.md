# Links — does everything go where it says

A link is a promise, and at launch a lot of them are broken in ways nobody notices: a page renamed
late in the build, a menu item still pointing at the preview deployment, a footer address that
opens an empty mail window. The audit follows every same-origin link it finds and requests every
off-site link once, with low concurrency and a distinct "could not verify" state so a rate-limited
partner site is never reported as broken. It also looks at the links themselves — their text,
their targets, and the two protocol shortcuts (`mailto:` and `tel:`) that are the most common way
a contact page fails silently.

## How the audit checks a link

- **Same-origin links** are followed as part of the crawl, so a broken one is reported with every
  page that links to it. One wrong menu item shows up as a single url with a long referrer list —
  read the referrer count before you read the url, because it tells you whether the fix is in a
  template or on one page.
- **Off-site links** are requested once each, with low concurrency and a plain identifying user
  agent. A site that blocks unknown agents, rate-limits, or answers slowly produces
  `links.external-unverifiable`, never `links.external-broken`. The two are kept apart on purpose:
  reporting a working link as broken destroys trust in the rest of the report.
- **Link text** is read from the anchor's own text, then from an image's alt text inside it, then
  from `aria-label` — the same order a screen reader uses to build an accessible name.
- The external set is **capped**. Whatever the cap dropped is named in **Not covered**, so a short
  external section never means "all the outbound links are fine".

---

## Broken and misdirected

### `links.internal-broken` — high
**Means.** A same-origin link points at a url that answers 4xx or 5xx.
**At launch.** This is the finding visitors hit first. Internal links are also how search engines
discover and weight pages, so a broken one wastes both.
**Fix.** Correct the href, or restore the page. The evidence lists which pages link to it, so a
single wrong nav item is visible as one url with many referrers.
*Astro / Eleventy / Hugo:* a link-checking build plugin catches these before deploy.
*Next / Nuxt / SvelteKit:* links built from a slug field break when the slug changes; generate hrefs
from the same helper the routes use.
*WordPress:* changing a permalink structure after content exists breaks every hand-written link.
**Cannot say.** Which of the two — the link or the page — is the mistake.

### `links.external-broken` — medium
**Means.** An outbound link's target answers 404, 410 or a server error.
**At launch.** Outbound links age badly. A launch is the one moment they are all checked at once.
**Fix.** Update, replace, or remove. For a reference that matters, link an archived copy.
**Cannot say.** Whether the target is temporarily down. Check the ones that matter by hand.

### `links.external-unverifiable` — info
**Means.** The target timed out, refused an anonymous request, or rate-limited the audit.
**At launch.** **This is not a failure.** It is the honest middle state: nothing here proves the
link works, and nothing proves it does not.
**Fix.** Open each one once yourself.
**Cannot say.** Anything at all about the target — which is why it is reported separately from
broken links and repeated in **Not covered**.

### `links.to-dev-host` — blocker
**Means.** A link points at `localhost`, a tunnel url, a preview deployment or the staging host.
**At launch.** It is either a dead end for every visitor or a door into an internal system. Both
are worse than a 404.
**Fix.** Replace with the production url and then search the repository for the host string.
**Cannot say.** Every dev host — pass the ones you know with `--dev-host`.

### `links.to-http-on-https` — medium
**Means.** A page served over https links to a plain-http url.
**At launch.** A protocol downgrade, and in practice usually a link that now redirects or a host
that no longer serves http at all.
**Fix.** Rewrite to https. If the target has no https, decide whether to link it at all.
**Cannot say.** Whether the target supports https.

### `links.to-redirecting-internal` — low
**Means.** An internal link goes through a redirect to reach its page.
**At launch.** Every visit pays an extra round trip, and on a site freshly migrated it usually
means the link was written against the old url structure.
**Fix.** Point internal links at the final url — right host, right trailing-slash form.
**Cannot say.** Whether the redirect is permanent.

---

## Link text and accessible names

### `links.empty-anchor` — low
**Means.** A link with no text, no image alt and no `aria-label`.
**At launch.** A screen reader announces the url. Icon links — a social icon, a logo, a cart —
are the usual cause.
**Fix.** Add an `aria-label`, or alt text on the image inside.
**Cannot say.** Whether sighted users understand the icon.

### `links.hash-href` — low
**Means.** `href="#"`.
**At launch.** A placeholder that scrolls to the top instead of going anywhere. Usually a menu
item nobody finished, or a control that should be a `<button>`.
**Fix.** Give it a real destination, or make it a button.
**Cannot say.** Whether a script attaches behaviour to it.

### `links.javascript-href` — medium
**Means.** `href="javascript:…"`.
**At launch.** It is not a link — it cannot be opened in a new tab, copied, or followed by a
crawler, and it does nothing if the script fails.
**Fix.** Use a `<button>` for an action; use a real url for navigation.
**Cannot say.** What the script does.

### `links.same-text-different-target` — info
**Means.** Two links with the same label point at different places.
**At launch.** Screen readers offer a list of links by text; "Read more" five times is five
identical entries.
**Fix.** Make the text describe the destination, or add context with `aria-label`.
**Cannot say.** Whether surrounding text makes the difference obvious visually.

### `links.generic-anchor-text` — info
**Means.** Anchor text like "click here" or "read more".
**At launch.** It describes the gesture rather than the destination, which helps neither visitors
nor search engines.
**Fix.** Put the destination in the words.
**Cannot say.** How many are acceptable. This is a count, not a verdict.

### `links.skip-link-missing` — low
**Means.** No "skip to content" link at the top of the page.
**At launch.** Every keyboard user tabs through the whole navigation on every page.
**Fix.** A visually hidden link that becomes visible on focus and targets the main landmark.
**Cannot say.** Whether an existing skip link is reachable — the browser tier's keyboard pass and
a manual tab test cover that.

---

## Protocol links and new tabs

### `links.mailto-invalid` — medium
**Means.** A `mailto:` with an empty or malformed address.
**At launch.** Clicking it opens an empty mail window. On a contact page this is the whole point
of the page failing quietly.
**Fix.** Correct the address. Watch for obfuscation scripts that build the href at runtime.
**Cannot say.** Whether the mailbox is monitored — that is an ops item.

### `links.tel-invalid` — medium
**Means.** A `tel:` containing words, or too few digits to be a number.
**At launch.** Tapping it on a phone dials nothing.
**Fix.** Use the full international form in the href (`tel:+441234567890`) and display whatever
format you like in the text.
**Cannot say.** Whether the number is the right one — see `content.phone-variants`.

### `links.noopener-missing` — low
**Means.** `target="_blank"` without `rel="noopener"`.
**At launch.** Modern browsers imply it, so this is mostly hygiene — but it is one attribute.
**Fix.** Add `rel="noopener noreferrer"` to new-tab links, especially user-supplied ones.
**Cannot say.** Whether the browsers your visitors use already imply it.

---

## What this dimension cannot tell you

- Whether a link *should* exist. A missing link is invisible to a crawler.
- Whether an external page still says what it said when it was linked.
- Whether a link works behind a login — the audit is anonymous.
- Anything about links on pages the crawl did not reach, or about the externals past the cap. Both
  are named in **Not covered**.
