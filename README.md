# website-launch-skill

Three Agent Skills that carry a website from "built" to "launched and verified". **`pre-launch`**
is the gate: it inspects the repository and the production build before you deploy, and it exits 1
if anything mechanical is wrong. **`launch-audit`** is the auditor: it crawls a staging or live url
and reports what would go wrong at launch — indexability, redirects, links, images, forms,
accessibility, performance, analytics, content — and always exits 0. **`post-launch`** is the
watch: it runs the moment DNS has moved, verifies the cutover against the baseline the earlier
phases wrote, and then runs a daily check for thirty days.

234 checks in all — 38 in the gate, 175 in the audit, 21 on cutover day — every one listed with its
severity and what it catches in [docs/checks.md](docs/checks.md), which is generated from the code
that runs, so the inventory cannot drift from reality.

The skills are stack-agnostic and agent-agnostic. They follow the
[Agent Skills specification](https://agentskills.io/), so they load in any tool that reads
`SKILL.md`, and they run as plain Node scripts with no agent at all.

## The honesty rules

All three are **verify-only**. Nothing in this repository edits a site, submits a form, flips a
setting, writes to a provider API, or clicks a destructive control. Every finding is a
recommendation with evidence for a human to act on.

1. **Read-only, report-only.** See above.
2. **No silent caps.** Any bound on coverage (max pages, depth, sampled Lighthouse, unverifiable
   externals) is reported by name in `Not covered`.
3. **Evidence for every finding.** A URL, a status code, a header value, a screenshot path, a
   `file:line`. A finding without evidence fails validation.
4. **`Not covered` is never a pass.** The agent's summary to a human repeats the `Not covered`
   section verbatim.
5. **A skip is not a pass.** Every skipped check carries a reason.
6. **The gate never softens.** No flag turns a `fail` into advisory. If a check is wrong, fix the
   check.

## Install

The three skills share one engine — `pre-launch` and `post-launch` import from
`skills/launch-audit/scripts/lib/` by relative path — so they install as a set. Copying one on its
own will not work.

### Claude Code

    /plugin marketplace add ethanplusai/website-launch-skill
    /plugin install website-launch@website-launch-skill

### Codex, GitHub Copilot, Cursor, Gemini CLI, Goose, OpenCode, or any Agent-Skills-compatible tool

Clone the repository and point the agent at `skills/`:

    git clone https://github.com/ethanplusai/website-launch-skill
    cd website-launch-skill

Then either add `website-launch-skill/skills` to wherever your tool looks for skills, or copy the
three directories — `skills/pre-launch`, `skills/launch-audit`, `skills/post-launch` — into that
location **together**, preserving their relative layout. Nothing in the skills refers to an
agent-specific path or variable, so there is nothing else to configure.

### Without any agent

The scripts are the whole product; the `SKILL.md` files only tell an agent how to use them. One
launch, in order, run from the cloned repository:

    # 1. before the deploy — gate the repository
    node skills/pre-launch/scripts/pre-launch.mjs --dir ../my-site --production-url https://example.com

    # 2. against staging — audit it, and build the redirect map while the old site is still up
    node skills/launch-audit/scripts/launch-audit.mjs \
      --url https://staging.example.com --old-url https://old.example.com

    # 3. the moment DNS moves — verify the cutover against what step 2 recorded
    node skills/post-launch/scripts/post-launch.mjs --mode cutover --url https://example.com \
      --baseline website-launch/staging-example-com-launch-audit-2026-09-14/baseline.json \
      --redirects website-launch/staging-example-com-launch-audit-2026-09-14/redirects.csv

Step 3 reads the bundle step 2 wrote. The folder name is the audited hostname plus the phase and
the date — audit `https://staging.example.com` on 14 September 2026 and you get
`website-launch/staging-example-com-launch-audit-2026-09-14/`; the script prints the path when it
finishes, and `--out` overrides it. Paths in flags resolve against the working directory. Every
script supports `--help` and `--json`.

## Requirements

**Node 20 or newer. Zero dependencies** for everything above.

An optional **browser tier** adds screenshots, axe accessibility scanning, Lighthouse performance
scoring, and proof that analytics actually fires on a rendered page — 12 of the 175 audit checks
and one of the 21 post-launch ones, plus the rendered-page evidence behind several others. Install
it **inside the cloned `website-launch-skill` checkout**, not inside the site being audited: the
scripts resolve these modules from their own path, so an install anywhere else is invisible to them.

    cd website-launch-skill
    npm i --no-save playwright axe-core lighthouse && npx playwright install chromium

`--no-save` keeps `package.json` untouched, which is the point — this repository declares zero
dependencies and a test enforces that. The packages land in `node_modules/`, which is gitignored.

Without the tier, nothing breaks: the browser-tier checks land in `Not covered` by name, with the
install line above. The audit's default is `--browser auto` — run it if it is there, say so if it
is not. Use `--browser on` to make its absence an error and `--browser off` to skip it deliberately.

## What each phase produces

Each run writes a bundle under `./website-launch/`. `--out` puts it somewhere else.

| Phase | Bundle | Exit codes |
|---|---|---|
| `pre-launch` | `report.md`, `findings.json`, `gate.json`, `manifest.json` — plus `.launch-progress.json` in the gated repo once you confirm a human item | **0** passed · **1** at least one check failed · **2** usage or IO error |
| `launch-audit` | `report.md`, `findings.json`, `crawl.json`, `baseline.json`, `manifest.json`, `redirects.csv` (with `--old-url`), `screenshots/` and `lighthouse/` (browser tier) | **0** always · **2** usage error, or `--browser on` with no browser |
| `post-launch` | `report.md`, `findings.json`, `crawl.json`, `baseline.json`, `manifest.json`, `baseline-diff.json` (with `--baseline`), and `plan.json` + `watch.json` in watch mode | **0** always, however bad the cutover is · **2** usage or IO error |

Every `report.md` carries a **Not covered** section: the caps that fired, the checks that were
skipped and why, the inputs nobody supplied, and the two things no checker can ever reach — whether
the copy on the pages matches the signed-off copy, and whether the pages that exist are the pages
that were agreed. Those last two are always its final two lines. It is the last section of an
audit and a post-launch report; in the gate it is followed by the human checklist, which is the one
thing that outranks it.

## How a launch runs

1. **Before the deploy**, run `pre-launch` against the repository. It builds the project, reads the
   output, and blocks on uncommitted work, committed secrets, leaked staging hostnames, placeholder
   copy, a missing 404 page, broken internal references, a robots or sitemap that disagrees with
   the production url, and framework config pointing at the wrong domain. Fix, re-run, repeat until
   it exits 0. Then walk its human items one at a time — up to nine, two of which are conditional
   on the site replacing an existing one and on it taking payments. Take the Search Console export
   **before DNS moves**, because after the cutover it cannot be taken at all.
2. **Against staging**, run `launch-audit`. If the site replaces an existing one, pass `--old-url`
   while both hosts are still reachable: that is the only moment the redirect map can be built
   automatically, and it writes `redirects.csv`. Keep the bundle — its `baseline.json` is what
   tomorrow gets compared against.
3. **On cutover day**, the moment DNS has moved, run `post-launch --mode cutover` with that
   `baseline.json` and `redirects.csv`. It checks propagation across four public resolvers, the
   certificate, the http and www redirects, that the staging noindex is gone, robots and sitemap on
   the live host, every row of the redirect map, the form endpoints, analytics, the old host, and
   the security headers. Fix, re-run, and **announce only once it comes back clean** — an
   announcement is the one step of a launch that cannot be taken back.
4. **For thirty days**, run `post-launch --mode watch --day <n>` once a day. It prints what is
   overdue, what is due today and what is coming, re-runs the automated part, and records the run.
   Day 30 is a retrospective and the decision about decommissioning the old host — which may not
   happen until the redirects have stood for thirty days.

## What it never does

All three are read-only with respect to your site. Nothing here edits a site, submits a form, clicks
a control, flips a setting in a dashboard, writes to a provider API, or touches DNS. It never
announces anything, and it never tells you a launch is fine — it hands you evidence.

One exception, and it is deliberate: **`pre-launch` runs your project's own build script** (`<your
package manager> run build`), unless you pass `--skip-build`, so that the output it inspects is
never stale. Whatever your build writes — `dist/`, a cache, `node_modules` if your build installs —
gets written, because it is your build. The gate itself adds nothing to that.

Of its own, it writes exactly three kinds of file, all of them your own record: the report bundle,
`.launch-progress.json` in the repository being gated, and `watch.json` inside the watch bundle.

It also does not fix what it finds, check anything behind a login, compare your copy against a
source document, know which pages were supposed to exist, integrate with Search Console or an
analytics API, or run as a monitor. Those are out of scope on purpose; the report says so where it
matters.

## Contributing a check

A check is not finished until it is proven in both directions.

1. **Register it.** Add a `defineCheck({ id, phase, dimension, severity, tier, title, catches, run })`
   to the right module and export it from that module's `checks` array. The id is
   `dimension.slug`, and its prefix must equal the dimension.
2. **Two fixtures, minimum.** One where the check fires, one where it does not.
   `test/fixture-coverage.test.mjs` fails if a check id appears fewer than twice across
   `test/*.test.mjs`, which is what a passing and a failing assertion look like.
3. **A reference entry.** Add the finding to the dimension's file under the skill's `references/`:
   what it means, why it matters at launch specifically, how to fix it on common stacks (Astro,
   Next, Hugo, WordPress, Vercel, Netlify, Cloudflare Pages — whichever apply), and what it does
   *not* tell you.
4. **`npm test`** — green, including the invariants test, which fails on any vendor name, any
   agency or product used as a default assumption, and any personal filesystem path.
5. **`npm run gen:checks`** — regenerate [docs/checks.md](docs/checks.md) and commit it.
   `node scripts/gen-checks-doc.mjs --check` exits 1 while it is stale.

Before a release, work through [docs/smoke.md](docs/smoke.md): the manual run against a real site,
where every finding gets a true-or-false-positive verdict and every false positive becomes a
regression fixture.

## Testing hooks

Used by this repository's own tests so the suite makes no network request, opens no browser and
reads no clock. A normal run sets none of them.

- `WEBSITE_LAUNCH_RECORDED_FIXTURE=<path>` — answer every HTTP request from a recorded-responses
  JSON file instead of the network.
- `WEBSITE_LAUNCH_RESOLVERS_FIXTURE=<path>` — answer the public-resolver DNS sample from a JSON
  file instead of querying real resolvers.
- `WEBSITE_LAUNCH_BROWSER_LOADER=fail` — make the browser tier's Playwright loader throw, as a
  machine without it would.
- `WEBSITE_LAUNCH_DEBUG=1` — print the stack trace of an unexpected failure, not only its message.
- `NODE_VERSION_OVERRIDE=v20.11.0` — check `engines.node` against this version instead of the
  running Node (`pre-launch` only).

Run the suite with `npm test`.

## Sources

The item ideas come from the public launch, front-end and SEO checklists, from the OWASP Secure
Headers Project, and from Google's own search documentation. No code was copied from any of them.
Full attribution, with what was taken from each: [docs/sources.md](docs/sources.md).

## License

MIT. See [LICENSE](LICENSE).
