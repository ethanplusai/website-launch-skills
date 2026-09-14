# Reading the report

## The bundle

Cutover mode writes a dated directory; the watch reuses one stable directory for all thirty days, so
the newest report is always at the same path.

    website-launch/<slug>-post-launch-<date>/     cutover
    website-launch/<slug>-post-launch/            watch

| File | What it holds |
|---|---|
| `report.md` | the report a person reads: cutover verification in day order, then Not covered |
| `findings.json` | every finding, machine-readable, with its evidence |
| `crawl.json` | what the crawl reached: url, status, final url, depth, source |
| `baseline.json` | a fresh baseline of production, ready to be the next comparison |
| `baseline-diff.json` | the diff, when a baseline was given |
| `plan.json` | what was due, in watch mode |
| `watch.json` | the record of every watch run: day, time, blockers, high, bundle |
| `manifest.json` | what this run wrote, so a re-run can clear what it no longer produces |

`watch.json` is deliberately not part of the manifest: it outlives any one run and must never be
cleaned away by the next one.

## Severities

| Severity | What it means here | When to act |
|---|---|---|
| `blocker` | the launch has not really happened — nobody can reach the site, or search engines are told to forget it | before anything else, and before any announcement |
| `high` | something is losing traffic, enquiries or rankings right now | today |
| `medium` | something changed that somebody should explain | this week |
| `low` | worth knowing | when convenient |
| `info` | a listing, not a failure — the resolver answers, the human items | read it |

There are exactly two blockers: `cutover.https-cert-host` and `cutover.noindex-live`.

## Two orderings, on purpose

**`report.md` is in day order.** DNS, transport, the noindex, robots and sitemap, redirects, the
baseline diff, analytics, forms, staging, the old host, headers, people. That is the order the day
depends on itself, and reading the report in it stops you fixing a symptom of something further up.
A blocker is bolded `**BLOCKER**` wherever it falls, so it stays visible while you are reading step
six.

**The terminal summary is in severity order.** Blockers first, bolded, then the highs. That is the
order somebody acts in.

If the two seem to disagree, they do not: one is how to understand the day, the other is what to do
first.

## The check ids

| Step | Ids |
|---|---|
| 1. DNS | `cutover.dns-unexpected` · `cutover.dns-propagation` |
| 2. Transport | `cutover.https-cert-host` · `cutover.http-redirect` · `cutover.canonical-host` |
| 3. Noindex | `cutover.noindex-live` |
| 4. Robots & sitemap | `cutover.robots-live` · `cutover.sitemap-live` · `cutover.sitemap-references-staging` |
| 5. Redirects | `cutover.redirect-drift` · `cutover.redirect-unverified` |
| 6. Baseline | `cutover.baseline-missing-page` · `cutover.baseline-changed` · `cutover.baseline-new-redirect` |
| 7. Analytics | `cutover.analytics-missing` · `cutover.analytics-not-firing` |
| 8. Forms | `cutover.form-endpoint-down` |
| 9. Staging | `cutover.staging-still-indexable` |
| 10. Old host | `cutover.old-host-serving-content` |
| 11. Headers | `cutover.security-headers-regressed` |
| 12. People | `cutover.human-items` |

A watch day adds the `inventory`, `links`, `head` and `indexability` dimensions from `launch-audit`,
in their own sections below the cutover one. The other audit dimensions are not re-run: images,
performance and accessibility do not change because DNS moved, and running them daily would bury the
four that do.

## Not covered

Every run ends with it, and it always has content, because two of its lines are unconditional. Read
it before you conclude anything, and repeat it to whoever asked for the report **verbatim** — every
line, unedited, however long.

What lands there:

- **Inputs you did not give.** No `--baseline`, so nothing was compared. No `--redirects`, so no old
  url was re-requested. No `--staging-url`, so nothing confirmed the staging copy is sealed. No
  `--old-url`, no `--expect-dns`. Each is a named line, not a silence.
- **Rows the redirect map could not promise anything about** — the ones the audit recorded as
  `error` or `unknown`. (A row that *was* verifiable and simply did not answer is a finding instead,
  `cutover.redirect-unverified`.)
- **Public resolvers that could not be reached**, with how many of the four and which.
- **Caps.** A probe set that stopped at its limit, with the count and the cap.
- **The browser tier**, when Playwright is not installed, which is what makes
  `cutover.analytics-not-firing` unanswerable.
- **A TLS certificate that was never read**, which is what makes `cutover.https-cert-host`
  unanswerable. A certificate nobody looked at must never read like one that checked out.
- **Crashes.** A check that threw costs that check and says so by name. A finding that failed
  validation is dropped and says so. A report that is quietly short one check is worse than one that
  admits the gap.
- **The two things no crawl can ever see**, always last: copy against the signed-off documents, and
  pages against the agreed scope.

A skip is not a pass. `Not covered` is not a pass.

## Triage

1. **Read the whole report before fixing anything.** Thirteen findings from one drifted redirect is
   one fix, and you cannot see that one finding at a time.
2. **Fix causes, not symptoms.** DNS before transport, transport before content, redirects before
   the baseline diff.
3. **Re-run after each fix.** The run is cheap and the report is the only evidence.
4. **Do not announce until the blockers are gone.** Then work the six human items, and announce
   after them.
5. **Start the watch the same day.** A launch that is clean at 4pm can break at the next deploy.
