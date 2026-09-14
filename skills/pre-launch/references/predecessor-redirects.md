# Predecessor redirects — keeping the old site's urls alive

When a new site replaces an old one, every url the old site served is a promise already made.
Somebody has it bookmarked. Another site links to it. A search engine has it indexed, ranked, and
sending traffic. A rebuild that drops those urls loses the rankings, the inbound links and the
bookmarks all at once — and the loss is invisible from the new site, which looks perfect. Traffic
simply falls, three weeks later, and by then the cause is hard to see.

The gate's `predecessor` group runs only with `--predecessor-url`, and it runs against the **live**
old site. That matters: the moment DNS moves, the old site stops answering and this check can
never be run again. Run it while both are up.

---

## The method

### 1. The sitemap is the source of truth

Not the old site's navigation, not somebody's memory of it, and not a crawl. A sitemap is what the
old site *told search engines it had*, and those are the urls with links and rankings attached
today. The gate fetches `robots.txt`, follows its `Sitemap:` lines, tries the conventional paths if
there are none, and expands a sitemap index one level.

**It fails closed.** A child sitemap that will not fetch or will not parse is not "fewer urls to
check" — it is an unknown number of urls nobody checked, and reporting coverage of the rest would
be a lie the size of whatever that child contained. `predecessor.coverage` fails and names the
child. Make it reachable and run again.

A sitemap that does not exist is also a failure, not a pass. If the old site genuinely has none,
export the url list from Search Console (Pages report) or the old server's access logs, publish it
as a sitemap on the old host, and run the gate again. Guessing the list is how a migration loses
the pages nobody remembered.

### 2. Same path first

The best redirect is the one you do not need. If `/about` existed on the old site, publishing
`/about` on the new site preserves the ranking with no rule, no hop and nothing to maintain. Before
writing a single redirect, go through the old url list and keep every path you reasonably can.

Changing a url needs a reason better than "the new framework prefers it".

### 3. One explicit rule per url that moved

For each old path with no equivalent at the same path, write **one** rule to **one** destination,
with a **301**, in the host's redirect file:

    /old-services/consulting    →  /services/consulting

The destination must be the page that replaces it — the closest real equivalent. A redirect to the
homepage is treated by search engines as a soft 404 and loses the ranking exactly as a 404 would;
it is the polite-looking version of deleting the page.

A path with no equivalent at all may 410 (Gone). That is a legitimate decision, but it is a
decision a person makes, not a default.

### 4. No wildcards over content

`predecessor.wildcard-redirects` fails on any catch-all rule whose prefix covers old content urls,
and quotes the rule. This is the check people most want to argue with, so: a rule like

    /legacy/:path*  →  /

answers forty different old articles with one page. It *looks* like coverage — every url returns
200, nothing 404s, the spot-check passes — and every one of those forty urls loses its ranking,
because the destination is not about what the url promised. Forty explicit rules are tedious to
write once and correct forever.

A wildcard is fine over a path space with no content: an old `/wp-admin/*`, a query-string handler,
a language prefix that maps one-to-one.

### 5. No chains, no loops

`predecessor.redirect-chains` fails when a rule's destination is itself another rule's source.
Every extra hop costs latency and a little authority, and a chain assembled over two migrations
usually ends in a loop nobody notices until the page serves nothing at all. Flatten every chain so
each source points straight at its final destination.

### 6. Take the Search Console baseline before DNS moves

This is the human checklist's `gsc-baseline` item and it belongs in this method too, because it is
the other one-way door. Export twelve months of performance data and the Pages coverage report
from the **old** property before the cutover. Afterwards, the old property stops collecting, and
you lose the only way to tell whether the migration cost traffic or the season did.

### 7. Keep the old host up through propagation

DNS does not switch; it propagates. For hours after the change, some resolvers still answer with
the old address, and every visitor they send arrives at the old host. If it is off, those visitors
get nothing. Keep it serving — and serving redirects to the new site once the new site is live —
until Search Console shows no crawling of old urls, which is rarely sooner than 30 days.

### 8. Do not delete the old sitemap

Leave the old sitemap in place on the old host and keep it submitted. It is what tells search
engines which old urls to re-crawl, which is how they discover the redirects and transfer the
rankings. Deleting it slows the migration down for no benefit at all.

---

## Reading the findings

### `predecessor.coverage`
**Means.** An old url exists neither at the same path in the build nor as an explicit
non-wildcard redirect. Every leftover is listed, one per evidence line.
**Fix.** Same path, or one explicit 301 to the closest equivalent. Work the list; do not
generalise it into a pattern.
**Cannot say.** Which new page is the right destination for a given old url. Only somebody who
knows the content can.

### `predecessor.wildcard-redirects`
**Means.** A catch-all rule stands in for urls that need their own destinations. The rule is
quoted, with the old urls it swallows.
**Fix.** Replace it with one rule per url. Keep the wildcard only over paths that had no content.

### `predecessor.redirect-chains`
**Means.** A rule's destination is another rule's source (a chain), or the walk returned to where
it started (a loop).
**Fix.** Point each source directly at its final destination. Break the loop.

---

## After the cutover

`launch-audit --old-url` writes a `redirects.csv` while both sites are reachable, and `post-launch`
re-requests every row of it against production to confirm the rules were actually deployed. Run
the audit before DNS moves, keep the csv, and hand it to whoever owns the server configuration.
