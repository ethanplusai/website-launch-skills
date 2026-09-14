# Cutover day, in order

The checks run in the order of the day, not in order of severity. That is deliberate: on cutover
day the questions depend on each other, and answering one out of order gives you a confident wrong
answer. If DNS has not finished moving, every other check describes whichever host happened to
answer — possibly the old one — and you will spend an hour fixing a site nobody is being sent to.

Read the report top to bottom once, in this order, before you fix anything. Then fix in severity
order.

---

## 1. DNS — has it actually moved, everywhere?

**`cutover.dns-unexpected`** (high) · **`cutover.dns-propagation`** (info, high while they disagree)

The run asks four public resolvers — Google, Cloudflare, Quad9, OpenDNS — separately, rather than
asking the machine it happens to be running on. Your own resolver is the least representative
answer available: it may be your registrar's, your VPN's, or a cache you warmed yesterday.

**Why first.** Everything below is a statement about whatever host answered. Until the resolvers
agree, the rest of the report is provisional and should be read that way.

**What to do while they disagree.** Nothing but wait, and keep the old host serving. Propagation is
bounded by the TTL that was in place *before* the change — which is why `pre-launch` asks for the
TTL to be lowered 24 hours ahead. Re-run when they agree.

**What "unexpected" means.** A resolver whose answer does not *contain* the record you named in
`--expect-dns`. Containment, not equality: a host on a CNAME answers with the CNAME and the A
records behind it, so a correct `www=cname.host` has more in it than you asked for. On a launch that
moved to a new provider an unexpected answer is normal for an hour and alarming after a day.

**A resolver that could not be reached is neither.** It knows nothing, which is not the same as
answering wrongly, so it is excluded from both the expectation check and the agreement check and
named in **Not covered** with the count instead. A firewalled resolver must never read as a failed
cutover.

---

## 2. Transport — can anybody actually reach it?

**`cutover.https-cert-host`** (blocker) · **`cutover.http-redirect`** (high) ·
**`cutover.canonical-host`** (high)

**Why second.** A certificate that does not cover the host is a full-page browser warning, which no
ordinary visitor clicks through. It does not matter what the page says if nobody gets to it. This is
the most common launch-day failure on a managed host: the domain was added, the certificate was
issued for the previous name, and the dashboard says "deployed".

`http` must answer 301 or 308 to `https`, in one hop. `www` and the apex must be one canonical host,
with the other redirecting to it — and the certificate has to cover both, or the redirect itself
throws a warning.

---

## 3. The noindex — is the site allowed to exist?

**`cutover.noindex-live`** (blocker)

The staging noindex reaching production is the single most expensive launch mistake there is,
because it is invisible: the site looks perfect, everybody celebrates, and three weeks later
somebody asks why there is no traffic. It hides in three places and the check looks at all three —
the meta tag, the `X-Robots-Tag` response header, and a blanket `Disallow: /` in robots.txt.

**Why third.** It is a blocker, and it is the one blocker that costs more the longer it stands: the
crawl budget spent on those weeks does not come back. Fix it, redeploy, confirm it is gone, then
request indexing for the top pages.

---

## 4. Robots and sitemap on the live host

**`cutover.robots-live`** (high) · **`cutover.sitemap-live`** (high) ·
**`cutover.sitemap-references-staging`** (high)

A sitemap is a request to index exactly the urls in it. A generator configured with the staging site
url writes a sitemap full of staging urls, and a live host that serves it is asking search engines
to index the wrong copy of the site.

**Why here.** It follows the noindex because both are the same conversation with a crawler, and it
precedes the redirects because the sitemap is how the new urls get discovered at all. Submit the
sitemap only once this section is clean — submitting a staging sitemap is hard to take back.

---

## 5. Redirects — does every old url still land?

**`cutover.redirect-drift`** (high) · **`cutover.redirect-unverified`** (medium)

Every row of `redirects.csv` is re-requested **at the url it was written with**, not rewritten onto
the production origin. That is the real question: somebody has that url in a bookmark, a search
result or another site's link, and after DNS moved it resolves somewhere new. What happens?

A row passes when it answers a single permanent hop — 301 or 308 — to the destination the audit
recorded. It fails on a 302 or 307 (temporary: search engines keep the old url), on a chain (each
hop is a round trip and crawlers give up), on landing somewhere else, and on rows the audit flagged
before the launch that are still 404ing.

A row that answered **nothing at all** is a separate, quieter finding: `redirect-unverified`. It has
not been shown to have drifted and it has not been shown to be right. Mid-cutover the usual cause is
the old host's own DNS still settling; after that, it is a host somebody already switched off, which
is its own problem — the redirect map only works while something is still answering on it.

**Why here.** It needs DNS to have moved and it needs the site to be reachable, so it cannot come
earlier. It comes before the baseline diff because a redirect that drifted usually explains several
of the diff's findings.

---

## 6. The baseline diff

**`cutover.baseline-missing-page`** (high) · **`cutover.baseline-changed`** (medium) ·
**`cutover.baseline-new-redirect`** (medium)

Production, crawled now, against the site as it was recorded before the launch. See
`baseline-diff.md` for which fields are expected to move and which never are.

**Why here.** Everything above it can cause a diff finding, so reading the diff first would send you
chasing symptoms. A page "missing" because a redirect drifted is one fix, not two.

---

## 7. Analytics

**`cutover.analytics-missing`** (high) · **`cutover.analytics-not-firing`** (high, browser tier)

A launch that measures nothing cannot be reported on, and no analytics product backfills — the gap
is permanent. The first check compares against the baseline (or, with no baseline, looks for the
measurement id you named). The second needs the optional browser tier: it renders the page and
watches for a request to the tool's collector, which is the only way to tell an installed tag from a
working one.

**Why here.** It is not a blocker — the site works — but every hour it stays broken is an hour of
launch-week data nobody will ever have.

---

## 8. Forms

**`cutover.form-endpoint-down`** (high)

Every same-origin form action, and every third-party form embed, asked once with a GET. Nothing is
ever submitted. A 405 is a healthy answer from a POST-only endpoint; a 500, a 404 or no response at
all is a form that renders perfectly and silently loses every enquiry.

**This check is not enough on its own.** A 200 from an endpoint is not a delivered message. The
human item stands: somebody submits the form and the person who owns the inbox confirms it arrived.

---

## 9. The staging copy

**`cutover.staging-still-indexable`** (high)

A staging host answering 200, with no noindex, no robots block and no redirect, is a complete second
copy of the new site. Search engines choosing between two identical sites do not always choose the
one you launched, and the wrong one has no analytics, no conversions and a hostname nobody can put
on a business card.

Best to worst: take it down · authenticate it · return 410 · redirect it to production · noindex it.
The last one still serves the content to anything that ignores the tag.

---

## 10. The old host

**`cutover.old-host-serving-content`** (high)

If the old site still answers with its own pages, two sites are live with the same content and the
same purpose. Rankings split, old links keep people on the old one, and any form on it delivers
somewhere nobody is watching any more.

The old host must stay **alive and redirecting**, not switched off — see `thirty-day-watch.md` for
when it may finally go.

---

## 11. Security headers

**`cutover.security-headers-regressed`** (medium)

Header configuration rarely moves with the content. A rule that lived in the old host's config, or a
proxy that sat in front of the old site, does not exist on the new platform. This compares against
the baseline, so it only fires on something that used to be there.

---

## 12. The six things a person does

**`cutover.human-items`** (info)

Submit the sitemap · request indexing · confirm the Search Console property · verify analytics in
real time · keep the old host up · announce only after this report is clean.

**Why last.** Because the announcement is last. Everything above exists so that the final item can
be taken honestly, and an announcement made over a standing blocker cannot be withdrawn.
