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

## The six runs

Run each from the skill's own directory. Keep every bundle; you will be comparing them.

**1. `launch-audit` with the browser tier off.** The floor: everything the HTTP tier alone can see.

    node scripts/launch-audit.mjs --url <site url> --browser off --out ../../smoke/audit-http

**2. `launch-audit` with the browser tier installed.** Install the optional tier first, **at the
root of this cloned `website-launch-skill` repository** — not in the site being audited; the
scripts resolve these modules from their own path:

    npm i --no-save playwright axe-core lighthouse && npx playwright install chromium

`--no-save` matters. It leaves `package.json` alone, so `test/invariants.test.mjs` — which asserts
this repository declares zero dependencies — still passes, and the checklist item below that says
`npm test` green is still reachable after the smoke run. The packages land in the gitignored
`node_modules/`. Then, from the skill directory again:

    node scripts/launch-audit.mjs --url <site url> --browser on --out ../../smoke/audit-browser

Diff the two `Not covered` sections. Every browser-tier line in the first run must be gone from the
second, and the second must not have quietly lost a line the first one had.

**3. `pre-launch` against the passing fixture.** The control. Every check about the fixture itself
must pass, and nothing in the report should surprise you:

    node scripts/pre-launch.mjs --dir ../../test/fixtures/passing-site --production-url https://example.com

Expect exit 1 rather than 0, and read why before you assume it is a defect. The fixture lives
inside this repository, so git answers about *this* checkout: on a branch with no upstream, or with
anything uncommitted, `hygiene.pushed` and `hygiene.clean-tree` fail, and they are right to. Both
findings name the repository root they came from. Every other check must pass.

**4. `pre-launch` against one real repository.** Any repository that builds a website — ideally the
one behind the site in run 1. Expect failures; the point is whether they are *true* failures:

    node scripts/pre-launch.mjs --dir <path to a real repo> --production-url <site url>

**5. `post-launch --mode cutover` using the audit's baseline.** The site is already live, so treat
this as "did anything drift since the audit an hour ago". Feed it the `baseline.json` from run 1,
the `audit-http` bundle — the HTTP tier is what a cutover run compares against:

    node scripts/post-launch.mjs --mode cutover --url <site url> \
      --baseline ../../smoke/audit-http/baseline.json --out ../../smoke/cutover

Its findings should be near-empty. Anything it reports as changed, when nothing changed, is a false
positive in the baseline diff, and those are the ones that will be loudest on a real cutover day.

**6. `post-launch --mode watch --day 1`.** The cutover run checks 21 conditions; a watch day also
re-runs the audit's link, head, indexability and inventory dimensions, so it is the run that shows
what a cutover report deliberately does not cover:

    node scripts/post-launch.mjs --mode watch --url <site url> --day 1 --out ../../smoke/watch

Expect it to surface findings the cutover run did not. That is the design, and the cutover report
says so in `Not covered` — check that it does.

## Score every line

Read **every finding** and **every `Not covered` line** from all six runs. Not the blockers, not a
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

- [ ] All six runs completed and their bundles kept
- [ ] Every finding in every run has a verdict recorded
- [ ] Every `Not covered` line has a verdict recorded
- [ ] Zero false positives outstanding — each one has a regression fixture and a fix
- [ ] Every false negative is either a new check or a new `Not covered` line
- [ ] `npm test` green after the fixes — including `test/invariants.test.mjs`, which the browser
      tier's `--no-save` install is what keeps passing
- [ ] `npm run gen:checks` produces no diff
- [ ] The run is recorded in the session summary, with the target site and the verdict counts

---

## Smoke record — 14 September 2026

The run this document describes, done once before `v0.1.0`.

**Targets.** `https://ethanplus.ai/` — a live fourteen-page Next.js site on Vercel with a sitemap,
a Cloudflare www host in front of the apex, and no analytics; audited by its owner. And one real
static repository with a deliberately dirty working tree, gated with `--build-dir website
--skip-build`. Both read-only throughout: nothing submitted a form or clicked a control.

**The runs**, from a scratch directory outside the repository, written `<scratch>` here:

    node <repo>/skills/launch-audit/scripts/launch-audit.mjs --url https://ethanplus.ai/ --browser off --out <scratch>/audit-http
    node <repo>/skills/launch-audit/scripts/launch-audit.mjs --url https://ethanplus.ai/ --browser on  --out <scratch>/audit-browser
    node <repo>/skills/pre-launch/scripts/pre-launch.mjs --dir <repo>/test/fixtures/passing-site --production-url https://passing.test
    node <repo>/skills/pre-launch/scripts/pre-launch.mjs --dir <a real repo> --build-dir website --skip-build --production-url <its url>
    node <repo>/skills/post-launch/scripts/post-launch.mjs --mode cutover --url https://ethanplus.ai/ --baseline <scratch>/audit-http/baseline.json --out <scratch>/cutover
    node <repo>/skills/post-launch/scripts/post-launch.mjs --mode watch   --url https://ethanplus.ai/ --day 1 --out <scratch>/watch

The browser tier was installed first, in this checkout, exactly as the section above says. After
it, `git status` showed no change to `package.json` or `package-lock.json`, and `npm test` stayed
green — which is the invariant that install is allowed to keep.

**Verdicts.** 69 check ids produced a finding, a failure, an advisory or a skip across the six
bundles, and every one of them, plus all 57 `Not covered` lines, was read and scored.

| | ids | instances |
|---|---|---|
| True positive | 63 | 384 |
| **False positive** | **5** | **22** |
| Unclear | 1 | 9 |
| `Not covered` lines, all true and none missing | — | 57 |

The one **unclear** is `forms.dead-action`, nine times: nine React forms with no `action`, which
over HTTP is exactly what a dead form looks like and exactly what a script-handled one looks like.
The finding's own text says nothing here can prove which — that is honest, and it is still nine
high findings on every site built this decade. Settling it needs the browser tier, which is a
design change rather than a bug; it is written down for v0.1.1.

**The five false positives, each with a regression test written before the fix:**

| id | what it claimed | why it was wrong | fix |
|---|---|---|---|
| `perf.render-blocking-script` | the head waits for a script, on all 14 pages | the script was `nomodule` — no browser that understands modules ever fetches it | `2bb7ed3` |
| `output.internal-refs` | two references resolve to no file — a blocking gate failure | both were inside `<script>`: an assignment to `location.href`, and an `href` in a template literal | `d7c5d7a` |
| `host.cert-missing-san` | a visitor reaching www gets a name-mismatch warning | www is served by a CDN with its own certificate, and answers cleanly | `1f548cc` |
| `browser.nav-not-collapsed` | five pages have a visible burger over a visible menu | there was no burger inside the `<nav>` at all, and "no toggle" read as "does not collapse" | `3ea0f81` |
| `perf.font-display-missing` | text waits for a web font | the face was `src: local(Arial)` — a metric-matched fallback that fetches nothing | `a6d74ca` |

**Four more things the bundles were wrong or unclear about, fixed the same way:**

| what | fix |
|---|---|
| the manifest did not name the browser tier's screenshots, and a rerun left stale ones in the bundle | `2437813` |
| three documentation claims that do not hold: `lighthouse/` is not the full result, `Not covered` is not the last section of a gate report, and one gate line read "source scan limited to (…)" | `b6196a8` |
| gating a directory inside a larger repository reported that repository's uncommitted paths without saying so | `cd35f83` |
| "1 page declare a canonical" | `513ac29` |

Carried inside `2bb7ed3`: `browser.lighthouse()`'s import is now injectable. The test asserting its
not-installed path was passing only because the machine had no lighthouse, so installing the
browser tier — which this document tells you to do — turned it red. A test that proves something
about the machine is a false green.

**What the site itself was found guilty of**, and left alone, because a true positive about the
target is not this repository's to fix: no analytics tag anywhere; a sitemap page carrying
`noindex`; eight pages with no canonical; five security headers absent; a duplicate title and
description across three pages; an orphan page; a 700 KB hero; and six pages of axe colour-contrast
violations.

**Observations worth keeping.**

- Lighthouse ran for real for the first time, through the free-port path, seven times (six pages
  mobile, the homepage also desktop) with no failure. Scores landed between 96 and 100.
- The browser tier rendered 6 of 14 pages and said so by name in `Not covered`.
- The whole HTTP audit took under nine seconds and the cutover eleven, over a site whose http, www
  and trailing-slash variants all redirect. Nothing hung on an undrained redirect body.
- `resolveAcross` reached all four public resolvers on this network; they agreed, and the run did
  not wait on a timeout. A network that blocks port 53 would still be untested.
- `host.leaky-header-present` fired on `Server: Vercel`, which is on the vendored OWASP removal
  list, so the finding is right — but the detail says the header "buys an attacker a version
  number", and this one carries no version. Noise rather than a falsehood; noted for v0.1.1.
- `head.title-framework-default` and `analytics.missing-on-pages` never fired, correctly: the site
  has real titles and no analytics at all, so neither shape was present to catch. They remain
  unexercised against a real site.
- `cutover` mode reports only its own 21 checks, so day 1 of the watch surfaced two high findings
  the cutover did not. That is what the documentation says happens, and it still means the report
  read before an announcement is narrower than the one read the next morning. Noted for v0.1.1.

**Post-smoke fix wave — 14 September 2026.** `01af93e` (the vendor scan skipped the one tracked
file that carried vendor names), `eabdffe` (a site that never answered reported `blocker 0`),
`eae7214` (three always-emit checks stated facts nobody observed), `d985c29` (800 dropped urls
printed 800 lines; a cutover report never said it covers 21 of 176 checks; a malformed
`notCovered` was coerced to `[]`), `37fe15e` (`net.cert()` had no timeout; `maxBytes` capped what
was kept rather than what was read; undrained redirect bodies; an uncancelled resolver),
`9d5db2a` (four head assertions that could not fail; a `<script>` tag that ended at a `>` inside a
quoted attribute), `a9bda93` (docs and manifest polish), `b66a448` (the new unreachable-target
blocker fired on a healthy site whose url carried a `#fragment`, and blurred three different
states into one sentence). **The smoke runs above predate these fixes** — the verdict table and the counts describe the bundles produced before this wave, not the
code at the tag.
