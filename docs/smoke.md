# The real-site smoke run

A manual procedure, not a test. The suite proves the checks behave the way their fixtures say they
do; it cannot prove a fixture resembles a real site. This does. **Run it once against a real site
and read every line of output before the first release tag.**

The output of this procedure is a verdict per finding — true positive or false positive — and a
regression fixture for every false one. A false positive in a launch tool is worse than a missing
check: it teaches people to skim the report, and then the real blocker gets skimmed too.

## Pick a target

A small public static site that **you own or have permission to audit**. Ten to forty pages is the
useful size: big enough to exercise the crawl, the sitemap and the link checks, small enough to
read every finding. It must be publicly reachable, and you must be allowed to fetch it repeatedly.

Do not use somebody else's site. The audit is read-only, but it is still a crawl of a host you do
not control.

Note before you start, so you can score the report against reality:

- how many pages the site has, and whether it has a sitemap
- whether it is behind a CDN, and which one
- whether it replaced an earlier site, and at what url

## The five runs

Run each from the skill's own directory. Keep every bundle; you will be comparing them.

**1. `launch-audit` with the browser tier off.** The floor: everything the HTTP tier alone can see.

    node scripts/launch-audit.mjs --url <site url> --browser off --out ../../smoke/audit-nobrowser

**2. `launch-audit` with the browser tier installed.** Install the optional tier first
(`npm i -D playwright axe-core lighthouse && npx playwright install chromium`), then:

    node scripts/launch-audit.mjs --url <site url> --browser on --out ../../smoke/audit-browser

Diff the two `Not covered` sections. Every browser-tier line in the first run must be gone from the
second, and the second must not have quietly lost a line the first one had.

**3. `pre-launch` against the passing fixture.** The control. It must pass, exit 0, and report
nothing surprising:

    node scripts/pre-launch.mjs --dir ../../test/fixtures/passing-site --production-url https://example.com

**4. `pre-launch` against one real repository.** Any repository that builds a website — ideally the
one behind the site in run 1. Expect failures; the point is whether they are *true* failures:

    node scripts/pre-launch.mjs --dir <path to a real repo> --production-url <site url>

**5. `post-launch --mode cutover` using the audit's baseline.** The site is already live, so treat
this as "did anything drift since the audit an hour ago". Feed it the `baseline.json` from run 2:

    node scripts/post-launch.mjs --mode cutover --url <site url> \
      --baseline ../../smoke/audit-browser/baseline.json

Its findings should be near-empty. Anything it reports as changed, when nothing changed, is a false
positive in the baseline diff, and those are the ones that will be loudest on a real cutover day.

## Score every line

Read **every finding** and **every `Not covered` line** from all five runs. Not the blockers, not a
sample — every one. Record the verdicts in a table like this:

| run | check id | severity | what it said | verdict | note |
|---|---|---|---|---|---|
| 2 | `head.description-length` | low | 42 chars on /about | true positive | it is short |
| 2 | `links.broken-internal` | high | /pricing → 404 | **false positive** | url has a trailing slash on the live site |
| 1 | *(not covered)* | — | "axe: no browser" | true | expected with `--browser off` |

Three kinds of verdict, and each has a different consequence:

- **True positive** — the finding is right. Nothing to do; it is evidence the check works on a real
  site rather than only on its fixture.
- **False positive** — the finding is wrong about this site. **This blocks the release.** Write a
  regression fixture that reproduces the real page's shape, watch it fail, fix the check, watch it
  pass. Then re-run.
- **False negative** — something is wrong with the site and no check said so. Note it. If it is in
  scope for a dimension that exists, it is a missing check; if it is not, it belongs in `Not
  covered` and is not there, which is its own bug.

A `Not covered` line gets a verdict too: is it *true* (the thing really was not checked) and is it
*complete* (nothing else was skipped silently)? A cap that fired without a line is the worst failure
this tool has, because it is the one that makes a clean report a lie.

## Before you tag a release

- [ ] All five runs completed and their bundles kept
- [ ] Every finding in every run has a verdict recorded
- [ ] Every `Not covered` line has a verdict recorded
- [ ] Zero false positives outstanding — each one has a regression fixture and a fix
- [ ] Every false negative is either a new check or a new `Not covered` line
- [ ] `npm test` green after the fixes
- [ ] `npm run gen:checks` produces no diff
- [ ] The run is recorded in the session summary, with the target site and the verdict counts
