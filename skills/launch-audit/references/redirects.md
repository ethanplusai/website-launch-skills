# Cutover redirects — keeping the old site's urls alive

When a new site replaces an old one, every url the old site served is a promise already made:
somebody has it bookmarked, another site links to it, a search engine has it indexed and ranked.
A rebuild that drops those urls loses the rankings, the inbound links and the bookmarks all at
once — and the loss is invisible on the new site, which looks perfect. Traffic simply falls, three
weeks later, and by then the cause is hard to see.

This dimension runs only with `--old-url`. It crawls the old site the same way it crawled the new
one, then asks the **new** origin about every path the old site served, and reports what happens.
The full map is written to `redirects.csv` in the bundle, one row per old url, so it can be handed
to whoever owns the server configuration.

---

## Running it

    node scripts/launch-audit.mjs --url <new site> --old-url <old site>

Run it **before** DNS moves, against the new site at its staging or temporary address. That is the
only moment when both sites are reachable at once, and it is the whole reason the redirect map can
be built automatically at all. After the cutover, `post-launch` re-requests every row of the same
csv against production to confirm the rules were actually deployed.

---

## The findings

### `redirects.would-404` — high
**Means.** A url the old site served answers 404 or 410 on the new site, with no redirect.
**At launch.** Every link and bookmark to it is now dead. This is the finding that costs traffic.
**Fix.** Add a redirect to the closest equivalent page. The report includes a best-match
suggestion with a confidence score — treat high confidence as a proposal and low confidence as a
question, never as an answer. A url with no equivalent should redirect to the most relevant
section page, not to the home page: a home-page redirect is treated by search engines as a soft
404 and loses the same ranking a real 404 would.
**Cannot say.** Which new page is the right destination. Only somebody who knows the content can.

### `redirects.to-404` — high
**Means.** The old url *does* redirect — and lands on a 404.
**At launch.** Worse than no redirect, because the server looks like it handled the request and
every monitoring tool agrees.
**Fix.** Correct the target. This is usually a rule written against a url structure that then
changed again before launch.
**Cannot say.** Whether the destination existed when the rule was written.

### `redirects.new-site-error` — high
**Means.** The old url reaches something that is neither a success nor a missing page — a 500, a
403, a 401.
**At launch.** Broken or locked down rather than gone. A 403 on a whole path prefix often means the
new host has not been configured for that route at all.
**Fix.** Read the status. A 500 is an application error; a 403 is usually host configuration or a
password-protected preview that has not been lifted.
**Cannot say.** Whether the error is transient.

### `redirects.chain` — medium
**Means.** An old url takes two or more hops to arrive.
**At launch.** Each hop costs a round trip, some crawlers stop following after a few, and a chain
that starts on the old host over http can easily reach four.
**Fix.** Point each rule at the final url directly. Write rules against the canonical form —
right scheme, right host, right trailing slash — so the host's own normalisation does not add a
hop of its own.
**Cannot say.** Which hop to remove without seeing the rules.

### `redirects.wildcard-smell` — medium
**Means.** More than 30% of old urls land on one page.
**At launch.** This is the signature of a catch-all rule sending everything to the front page. It
makes the report look clean — nothing 404s — while every deep url loses its ranking to a soft 404.
**Fix.** Replace the wildcard with a real map for the urls that matter, and let the rest 404
honestly. A genuine 404 is better than a lie.
**Cannot say.** Whether a legitimate wildcard exists (a retired blog folder redirecting to the new
blog index is reasonable). Read the destination and decide.

### `redirects.summary` — info
**Means.** The count of old urls by outcome, and a pointer to `redirects.csv`.
**At launch.** Read this first. The shape of the numbers tells you whether there is a redirect map
at all, a partial one, or a wildcard.
**Fix.** Nothing. Open the csv.
**Cannot say.** Whether the destinations are the *right* pages, only what the server does.

### `redirects.old-url-required` — info
**Means.** The audit was given no `--old-url`, so no old url was checked.
**At launch.** If this site replaces one that is already live, this finding is the most important
line in the report: nothing here says whether its urls survived.
**Fix.** Re-run with `--old-url` while the old site is still reachable.
**Cannot say.** Whether a predecessor exists at all.

### `redirects.old-url-same-origin` — info
**Means.** The `--old-url` given is on the same origin as the site being audited.
**At launch.** No redirect map can be built: every path would trivially match itself.
**Fix.** Pass the old site's real address — usually the previous domain, or the old host's
temporary url if the domain has already moved.
**Cannot say.** What the old site served, since it was never crawled.

---

## Writing the rules

Generic advice that holds everywhere:

- **Use 301** (or 308 where the method must be preserved). A 302 does not consolidate ranking.
- **One hop.** Write each rule to the final url, not to another rule's input.
- **Preserve the query string** unless you have a reason not to — campaign parameters ride on it.
- **Case matters.** Old sites often served mixed-case urls; new hosts are usually case-sensitive.
- **Keep the old host alive** through the redirect period. A redirect on a domain that no longer
  resolves is not a redirect.
- **Keep the rules for at least a year.** Search engines need to see them repeatedly; the old host
  should only be decommissioned after a search console shows no crawls of old urls.

Where the rules live differs by stack:

- *Static hosts (Vercel, Netlify, Cloudflare Pages):* a redirects file or a `redirects` array in
  the project configuration, deployed with the site. This is the easiest case — the map is
  version-controlled next to the code.
- *Next / Nuxt / SvelteKit:* the framework's own redirect configuration is fine for a few dozen
  rules; past that, prefer the host's layer so a redirect does not need to boot the application.
- *Astro / Eleventy / Hugo:* these build static output, so the redirect map belongs to the host.
- *WordPress:* a redirect plugin is convenient and costs a database lookup per request; a
  server-level rule is faster. For hundreds of rules, use the server.

---

## Reading redirects.csv

One row per old url. The columns answer, in order: what the old site served, what the new origin
does with that path, where it lands, and what the audit suggests if the answer is nothing.

How to work it:

1. **Sort by outcome.** Every row that would 404 is work; everything else is confirmation.
2. **Group by path prefix.** Redirect maps are written per section, not per url. A hundred rows
   under one old folder is usually one rule.
3. **Check the suggestions, do not apply them.** The best-match column is string similarity with a
   confidence number. High confidence is a proposal worth a glance; low confidence is a question
   for whoever knows the content.
4. **Add the urls the crawl never saw.** The old site's crawl is capped and only finds urls that
   are still linked or listed. The complete list of urls that ever mattered lives in the old
   server's logs or in a search console's page report — export it and reconcile.
5. **Hand the file over, not a summary.** The csv is the deliverable for whoever owns the server
   configuration, and `post-launch` re-requests every row of it after the cutover.

---

## What this dimension cannot tell you

- Which new page an old url *should* go to. Best-match suggestions are string similarity plus a
  confidence number, nothing more.
- Whether the old site's crawl was complete. It is capped the same way the new one is, and the
  caps are named in **Not covered**. Old urls that were already gone before the audit ran were
  never seen at all — a server log or a search console export is the only complete list.
- Whether a redirect preserves ranking. Nothing outside a search console can say that.
- What happens after DNS moves. That is `post-launch --mode cutover`, re-requesting this same csv
  against production.
