# Ops & access readiness — the jobs that are not in the markup

Every other dimension in this report is a fact about the site. This one is mostly a list of jobs a
person has to do, and it exists because the worst launch days are never caused by markup. They are
caused by nobody having the registrar login, the analytics property belonging to a contractor who
left, the form notifications going to an address that bounces, or a staging password still live on
a copy of the site that search engines have now indexed.

Three of these can be answered over HTTP and are. The rest are marked `[human]` in the report's
**Ops & access readiness** section, and they stay marked that way until somebody says otherwise.
An unticked human item is not a finding and is not a pass — it is a question that has not been
asked yet.

---

## What the audit can answer

### `ops.email-auth` — medium
**Means.** The domain publishes no SPF record, no DMARC record, or no DKIM key under any of the
common selectors.
**At launch.** This is where "the contact form doesn't work" usually comes from. The form submits
fine; the notification lands in a spam folder, or is rejected outright, and nobody sees it.
A domain that has just moved hosts is the most likely to have lost these records.
**Fix.**
- **SPF** — one TXT record on the domain starting `v=spf1`, listing everything that sends mail as
  the domain (the mail provider, the form provider, any newsletter tool), ending in `-all`. There
  must be exactly one SPF record; two is a failure, not a merge.
- **DKIM** — the provider gives you the record; publish it and send yourself a test message.
- **DMARC** — a TXT record at `_dmarc.<domain>` starting `v=DMARC1; p=none; rua=mailto:…`. Start
  at `p=none`, read the reports for a few weeks, then tighten to `quarantine` and `reject`.
**Cannot say.** Whether the records are *correct*, only whether they exist. The DKIM finding is
the least certain of the three: a key published under a selector not on the list would be missed,
so confirm with whoever runs the mail before acting on it.

### `ops.legal-pages` — medium
**Means.** Nothing anywhere on the crawled site links to a privacy policy, terms, or a cookie
policy — searched in both link text and hrefs.
**At launch.** Whether a site is *required* to publish these depends on what it collects and where
its visitors are, which no crawler can answer. Whether it links to any of them is a fact, and the
answer being "no" is far more often an oversight than a decision.
**Fix.** Publish what the site actually needs and link it from the footer, where people look.
**Cannot say.** Whether the policies are adequate, current, or apply. That is a lawyer's question.

### `ops.checklist` — info (human)
**Means.** The thirteen readiness items, each marked with the check that verifies it or as
somebody's job.
**At launch.** Walk it with whoever owns the site, out loud, before the cutover.
**Fix.** Tick the human items yourself; the automatic ones are answered by the findings above.
**Cannot say.** Anything. It is a list of questions.

---

## The checklist, and what each item really means

**Hosting account provisioned; access confirmed** `[human]`
Not "we have a hosting account" — *log in*. Confirm the client owns it, or that there is a written
agreement about who does. An agency-owned hosting account is a hostage situation waiting to happen.

**Domain registrar access tested; DNS control confirmed** `[human]`
Log into the registrar and confirm you can edit a record *before* the day of the cutover. This is
the single most common reason a launch slips: nobody can find the registrar login, and the domain
was bought five years ago on a personal card.

**Analytics property live; conversion event defined** `[auto: analytics]`
The audit confirms a tag is installed and, with a browser, that it fires. It cannot confirm the
property is the client's, that anybody has access, or that a form submission registers as an event.
Do all three by hand — see `analytics.md`.

**Search Console (and Bing Webmaster) verified; sitemap submitted** `[human]`
Verify the **production** property, not staging, and do it before the cutover so history starts on
day one. Submit the sitemap after DNS has moved. This is the only place indexing problems ever
become visible.

**Form notifications route to a monitored inbox; test submission received** `[auto: forms]`
The audit inventories forms and never submits one. Somebody must, and must confirm the message
arrives in an inbox a named person reads — not a shared address nobody opens. See `forms.md`.

**Email authentication: SPF, DKIM, DMARC present** `[auto: ops.email-auth]`
See above. Re-check after DNS moves: these records live in the same zone that just changed.

**Privacy policy, terms, and cookie policy published where required** `[auto: ops.legal-pages]`
The audit checks a link exists. Whether the policies are right is not a question a tool can ask.

**Chat / booking widgets installed and tested (if used)** `[human]`
Open each one and complete a booking or start a chat. Third-party widgets fail quietly and often
restrict themselves to named domains, so one tested on staging can stop working at launch.

**Uptime monitoring in place** `[human]`
Something must notice when the site goes down that is not a customer. Monitor the home page and at
least one deep page — a soft-404 catch-all will keep answering 200 for a broken application.

**Backups configured and a restore tested** `[human]`
A backup nobody has restored is a belief, not a backup. Restore one somewhere disposable.

**Staging credentials and any secrets shared during the build rotated** `[human]`
Anything typed into a chat, an email or a shared document during the build is now public as far as
security is concerned. Rotate it after launch, on a date, not "soon".

**Custom 404 returns a real 404** `[auto: host.soft-404]`
Verified automatically. See `host.md`.

**Search engines allowed on production** `[auto: indexability.site-noindex]`
Verified automatically, and the single most important line in the whole report. See
`indexability.md`.

---

## The order these happen in

Several of these items depend on each other, and doing them out of order is what turns a launch
into a week. The dependency chain, shortest to longest:

1. **Registrar and hosting access, tested.** Everything else waits on this. Confirm a week ahead,
   not on the day.
2. **Search Console verified on the production property, before DNS moves.** Verification can be
   done by DNS record or by a file on the site; doing it early means history starts on day one.
3. **Email authentication checked before and after the move.** SPF, DKIM and DMARC live in the
   same DNS zone that is about to change. Records that survive a nameserver change are a happy
   accident, not a rule.
4. **Form test submissions after DNS, again.** A form tested on staging is a form tested from a
   different hostname, and some providers care.
5. **Sitemap submitted after the production site is serving.** Submitting a sitemap that names
   urls the live host does not serve yet wastes the crawl.
6. **Credential rotation after launch, on a date.** Not "soon" — a date, with an owner.

`post-launch --mode cutover` re-checks the mechanical half of this list the moment DNS has moved,
and `--mode watch` carries the rest through the first thirty days.

---

## What this dimension cannot tell you

- Who has access to anything. Every access question is answered by logging in, not by a request.
- Whether an inbox is monitored, whether a backup restores, or whether a monitor alerts anyone.
- Whether the legal pages are adequate, current, or required.
- Whether the DNS records are correct — only whether they exist.
