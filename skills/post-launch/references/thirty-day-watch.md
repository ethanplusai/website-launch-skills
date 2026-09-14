# The thirty-day watch

A launch is not an event, it is a month. Most of what goes wrong at a cutover is invisible on the
day and obvious in week three, by which time nobody is looking. This is the schedule, what to read
where, and — the part that matters most — what normal looks like, so an ordinary post-launch dip is
not reported as a catastrophe.

Run it with:

    node scripts/post-launch.mjs --mode watch --url <production url> --day <n>

It prints what is overdue, what is due today, and what is coming in the next seven days, then runs
the automated part and records the run in `watch.json`.

**What a recorded run covers.** An automated task on an earlier day: re-running the checks on day 8
answers the day-3 question. It never covers a human task. Nothing a script does is evidence that
somebody opened Search Console, so those stay on the overdue list until a person clears them. That
is the honest answer and it is meant to be slightly annoying.

---

## Days 1–3, every day

| Task | Automated |
|---|---|
| Re-run the cutover checks | yes |
| Search Console: the Pages report, for new coverage errors | no |
| Review the 404 log — server logs, or Search Console Pages, "Not found" | no |
| Re-measure Core Web Vitals in the lab | yes |
| Confirm the site has stayed up since the cutover | no |

**What to look at.** In Search Console, the **Pages** report (not the old "Coverage" name): the
"Not indexed" reasons are where a launch problem surfaces first. "Excluded by noindex" on day two
means the blocker came back with a deploy. "Not found (404)" climbing means a redirect is missing.

**What healthy looks like.** Crawling *increases* sharply — a changed site invites a re-crawl.
Indexed count barely moves, because indexing lags crawling by days. Impressions dip. A 10–25% drop
in organic traffic in the first fortnight of a domain or url migration is ordinary and recovers; it
is not a reason to roll anything back on day two.

**What is not healthy.** Indexed pages falling while 404s rise — that is redirect coverage, not
lag. Any new "Excluded by noindex" or "Blocked by robots.txt" on urls that should be indexed.

---

## Days 3–7

| Task | Automated |
|---|---|
| Search Console: the sitemap is processed — submitted against indexed | no |
| Confirm the analytics conversion events are firing, not just pageviews | no |
| Redirect spot-check on the top twenty old urls | yes |
| Broken-link re-crawl of the live site | yes |

**The sitemap.** "Submitted 120, indexed 8" on day four is normal. On day twenty it is a problem.
What matters here is that the sitemap was *read* — a "Couldn't fetch" is a same-day fix.

**Conversion events.** Pageviews firing does not mean conversions are. A form that posts to a new
endpoint, or a thank-you page at a new url, breaks the event without breaking the tag. Submit the
form yourself and watch the event arrive.

**The top twenty old urls.** Not a sample of all of them — the twenty that earned the most traffic
before the launch. Take them from the pre-launch Search Console export. If the export was never
taken, say so plainly: it cannot be taken now, and this is the check that suffers.

---

## Week 2

| Task | Automated |
|---|---|
| Internal-link crawl as a bot would do it: orphans and depth | yes |
| Validate the structured data on production urls | yes |
| Re-check titles, descriptions and OG tags against the baseline | yes |
| Indexation count from the Search Console Pages report | no |

**Orphans and depth.** A rebuild moves navigation around. A page that is in the sitemap and linked
from nothing is a page search engines will quietly stop trusting. Anything a visitor should reach in
three clicks should be reachable in three links.

**Indexation count.** Use the Pages report. A `site:` query is not a measurement — it is a
rough, cached, personalised estimate, and people have made bad decisions from watching it move.

---

## Weeks 2–4, once a week

| Task | Automated |
|---|---|
| Organic traffic against the pre-launch export | no |
| Top-twenty keyword positions, if they are tracked | no |
| Review the 404 log | no |
| Core Web Vitals field data, once CrUX has twenty-eight days of it | no |

**Field data.** A new domain has no field data. CrUX needs 28 days of real traffic before Search
Console's Core Web Vitals report says anything, and a site below the traffic threshold never gets
it at all. Until then, lab numbers are the only measurement available and they are not the same
thing. Saying "the field data is empty because the domain is new" is the correct answer, not a gap.

**Traffic.** Compare against the pre-launch export, same weekday, same window. Week-on-week against
launch week compares against an anomaly.

---

## Day 30

**The retrospective.** Three questions, written down where the next launch will find them:

1. What regressed that the gate should have caught? Add a check to `pre-launch`.
2. What did the redirect map miss? Usually a whole template nobody listed — tags, pagination,
   author pages, a legacy path pattern.
3. What did we learn about this stack that the next launch on it should know?

**The old host.** It may be decommissioned only when **both** are true:

- Search Console shows no crawl of old urls, and
- the redirects have been in place for at least thirty days.

Until both hold, keep paying for the hosting and the domain. The redirect map is the only thing
carrying the old site's links and rankings across, and it only works while somebody is still
answering on that host. Domains are cheap; the links are not replaceable.

If the old host has to go earlier for a reason outside your control, say what it costs before it
happens rather than after.
