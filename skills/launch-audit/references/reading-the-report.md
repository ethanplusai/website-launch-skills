# Reading the report

The bundle is evidence, not a verdict. This file is how to turn it into something a person can act
on: how to read severities, how to do the one review no checker can do (look at the screenshots),
how to treat **Not covered**, and how to phrase all of it to somebody who paid for the site.

---

## What is in the bundle

    report.md        the whole report: findings by dimension, ops checklist, Not covered
    findings.json    the same findings, machine-readable
    crawl.json       every url reached, its status, depth and how it was found
    baseline.json    a snapshot of the site, for post-launch to diff against
    manifest.json    exactly which files this run wrote, itself excluded
    redirects.csv    one row per old url (only with --old-url)
    screenshots/     desktop, tablet and mobile, per rendered page (browser tier only)
    lighthouse/      the scores and metrics Lighthouse measured, per rendered page and form factor

Read `report.md`. Open `crawl.json` when you need to know whether a page was reached at all, and
`redirects.csv` when you are handing a redirect map to whoever owns the server. Open a
`lighthouse/` file when somebody disputes a performance finding — it holds every audit behind the
score, not just the number the report quotes.

---

## Severities, and what they actually mean

| Severity | What it means | What to do |
|---|---|---|
| `blocker` | The site is broken or invisible for everyone. | Fix before launch. There is no version of this that waits. |
| `high` | A real failure with real cost — lost enquiries, lost rankings, a broken page. | Fix before launch, or have a reason. |
| `medium` | Wrong, and it will cost something eventually. | Fix in the first week. |
| `low` | Hygiene. Worth doing while somebody is already in the file. | Batch it. |
| `info` | A fact, not a failure. Inventories, summaries, counts. | Read once. Some of these are the most useful lines in the report. |

Two things about this table that matter more than the table:

- **`info` is not noise.** `analytics.summary`, `perf.third-party-scripts`, `head.jsonld-types-summary`
  and `forms.inventory` are lists of what the site actually contains. The value is in reading them
  and noticing what should not be there.
- **A count is not a score.** Forty `low` findings from one template is one fix. One `blocker` is a
  launch. Never present the total.

**Read the findings in this order:** blockers, then `Not covered`, then the screenshots, then
everything else. `Not covered` comes second on purpose — knowing what was not checked changes how
you read a clean section.

---

## The screenshot review

The browser tier captures full-page screenshots at three widths. `browser.screenshots-for-review`
lists the paths. This is the only part of the audit that can answer "does this page actually look
right", and it takes about a minute per page.

Open the mobile and desktop shots of the same page side by side, and look for:

1. **Layout breakage.** Overlapping blocks, a footer on top of content, a sidebar underneath the
   page, text over an image. Usually one component without a max-width.
2. **Horizontal overflow.** A page wider than the screen. `browser.horizontal-overflow` reports it
   at each width; the screenshot tells you *which element* — look for the one thing extending past
   the right edge, usually a table, a wide image, a `<pre>` block, or a fixed pixel width.
3. **Missing images.** A gap, a broken-image icon, an alt-text string sitting on its own. Check
   this against `images.broken` — an image that loads but is a plain white rectangle appears only
   here.
4. **Clipped or truncated text.** Headings cut off mid-word, buttons with the label spilling out,
   a card whose text is hidden by a fixed height. This is almost always worse on mobile, and
   almost always in a language with longer words than the one the design was made in.
5. **Navigation that does not collapse.** At phone width the menu should be a button, or the links
   should fit. Links still spread across the top, or spilling off the edge, is a half-finished
   responsive nav. `browser.nav-not-collapsed` reports the common shape of this — a toggle inside
   the `<nav>` with its links still on screen — and says nothing at all when the toggle sits beside
   the `<nav>` rather than inside it, which is how several component libraries write a header. The
   screenshot catches the rest, and on that shape the screenshot is all you have.
6. **Placeholder imagery.** Stock photography that survived to launch, a grey box where a portrait
   should be, the same photo three times, a logo at the wrong aspect ratio. Nothing mechanical can
   find this. It is the single most common embarrassing thing left on a launched site.

Also worth a glance: consent banners covering the whole first screen on mobile, chat widgets
sitting on top of the primary button, and anything that looks like it is still loading.

If no browser was available, there are no screenshots, `Not covered` says so, and **this entire
review did not happen.** Say that when you present the report; do not let its absence read as a
pass.

---

## How to treat `Not covered`

Every report ends with a section that names what the audit did not look at: urls dropped by caps,
probe sets that hit a limit, checks that could not run, tools that were not installed, external
links that could not be verified, anything `--ignore-robots` masked, and two things no crawl can
ever see — copy against the source documents, and the pages that exist against the pages that were
agreed.

Three rules, and they are not negotiable:

1. **Repeat it verbatim.** Every time you present the report, in full, unedited. It is not a
   footnote; it is the boundary of the claim you are making.
2. **A skip is not a pass.** "The browser tier did not run" does not mean the site is accessible
   and fast. It means nobody looked.
3. **Never summarise it away.** "Some minor caveats" is how a report starts lying. If the list is
   long, that is information about the audit, and the client is entitled to it.

The two lines at the end of every report — copy versus source, pages versus scope — are there
because they are the two failures that hurt most and that no tool can ever reach. Somebody has to
sit with the signed-off content document and the page list and compare them by hand. Say so.

---

## The three judgment passes

The report hands over evidence for three reviews that only a person can do. Do all three before
presenting anything:

1. **Screenshots** — the checklist above.
2. **Forms** — classify each one first-party, third-party or dead, and confirm somebody has
   submitted each one and received it. See `forms.md`.
3. **Contact details** — collect every phone number, address and email the report found into one
   list and confirm which are current. See `content.md`.

---

## Presenting it to a client

Structure the summary the way the report is structured, and lead with the decision, not the count.

**Open with what blocks the launch.** One sentence per blocker, in plain language: *"The site
currently tells search engines not to index it — that's one setting, and until it changes the site
won't appear in search at all."* If there are none, say so directly: *"Nothing here blocks the
launch."*

**Group by dimension, worst first.** Within each dimension, severity order. Give the count and the
shape: *"Fourteen pages are missing a description — it's one template, so it's one fix."* A client
cares how much work it is, and the honest answer is usually "less than the number suggests".

**Then Ops & access readiness.** These are the client's jobs, not yours, and they are the ones that
ruin launch days. Read the `[human]` items out loud and get an answer for each one.

**Then Not covered, verbatim.** Introduce it honestly: *"Here's what this didn't check."*

Three habits that make the difference:

- **Name the fix, not the failure.** "Add a description to the blog template" beats "missing meta
  description on 14 pages".
- **Say what it costs.** A missing viewport tag is not a technical detail; it is "the site is
  unusable on phones". A second phone number is "half your calls go to a number nobody answers".
- **Never imply completeness.** This tool checks what HTTP and a browser can check. It does not
  check whether the site is the site that was agreed, and it says so twice in every report.

---

## What this report never claims

- That the site is accessible, fast, secure, or compliant. It reports specific, evidenced failures
  and names the categories it did not examine.
- That a clean section means a clean site. Read `Not covered` before believing any empty section.
- That anything was changed. Nothing here submits, clicks, or edits. Every finding is a
  recommendation for a human to act on.
