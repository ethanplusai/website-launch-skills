# website-launch-skill — Design Spec

**Date:** 2026-09-13
**Status:** Approved (sections 1–4 reviewed in conversation; 5–8 approved by delegation)
**Audience:** Public. Anyone launching a website with any coding agent that supports the Agent Skills standard.
**Repo:** `github.com/ethanplusai/website-launch-skill` (MIT)

## 1. What this is

Three Agent Skills that carry a website from "built" to "launched and verified", in the order the work actually depends on itself:

| Skill | Role | Posture | Exit code |
|---|---|---|---|
| `pre-launch` | the **gate** — inspects the repo and build output before deploy | blocks | 1 on any failing mechanical check |
| `launch-audit` | the **auditor** — crawls a staging or live URL and reports | reports | always 0 |
| `post-launch` | the **watch** — verifies cutover day, diffs production against the pre-launch baseline, schedules the 30-day watch | reports | always 0 |

All three are **verify-only**. Nothing in this repository edits a site, submits a form, flips a setting, writes to a provider API, or clicks a destructive control. Every finding is a recommendation with evidence for a human to act on.

It is **stack-agnostic** and **agent-agnostic**. The skills follow the Agent Skills specification (agentskills.io) so they load in Claude Code, Codex, Copilot, Cursor, Gemini CLI, Goose, OpenCode and any other product that reads `SKILL.md`. Nothing in the scripts or instructions assumes a particular agent.

### Why it exists when checklists already do

The public checklists (Front-End Checklist's 385 rules, the 2026 agency lists, the SEO launch lists) are prose. The one competitor skill is Claude-only, prose playbooks, no scripts, no tests, no repo-side gate, no cutover sequencing, no post-launch phase. Nobody ships a launch *process* with bundled, tested, offline verification and dependency ordering: Search Console baseline before DNS, noindex flip after cutover, redirect spot-check after DNS, forms before deploy.

### Honesty rules (non-negotiable, restated in every SKILL.md)

1. **Read-only, report-only.** See above.
2. **No silent caps.** Any bound on coverage (max pages, depth, sampled Lighthouse, unverifiable externals) is reported by name in `Not covered`.
3. **Evidence for every finding.** A URL, a status code, a header value, a screenshot path, a `file:line`. A finding without evidence fails validation.
4. **`Not covered` is never a pass.** The agent's summary to a human repeats the `Not covered` section verbatim.
5. **A skip is not a pass.** Every skipped check carries a reason.
6. **The gate never softens.** No flag turns a `fail` into advisory. If a check is wrong, fix the check.

## 2. Repository layout

```
website-launch-skill/
├── README.md                 # what it is, install for any agent, the three phases, honesty rules
├── AGENTS.md                 # orientation for agents that read it
├── LICENSE                   # MIT
├── package.json              # private; "test" script only; zero dependencies
├── .claude-plugin/
│   └── marketplace.json      # optional one-command install for Claude; nothing depends on it
├── skills/
│   ├── pre-launch/
│   │   ├── SKILL.md
│   │   ├── scripts/pre-launch.mjs
│   │   └── references/{human-checklist,predecessor-redirects,framework-hints,config}.md
│   ├── launch-audit/
│   │   ├── SKILL.md
│   │   ├── scripts/launch-audit.mjs
│   │   ├── scripts/lib/            # the shared engine (see §3)
│   │   └── references/             # one file per dimension
│   └── post-launch/
│       ├── SKILL.md
│       ├── scripts/post-launch.mjs
│       └── references/{cutover-day,thirty-day-watch,baseline-diff}.md
├── test/
│   ├── *.test.mjs                  # node:test; no network; no browser
│   └── fixtures/
│       ├── passing-site/           # a static build that passes the gate
│       ├── failing-site/           # one seeded with every failure class
│       ├── html/                   # page fixtures for the HTML layer and checks
│       ├── sitemaps/, robots/, headers/, jsonld/
│       └── recorded/               # a recorded crawl of a small real site (responses as JSON)
└── docs/
    ├── checks.md                   # canonical inventory: every check, phase, severity, tier
    ├── sources.md                  # attribution
    └── superpowers/{specs,plans}/
```

### Rules that hold across the repo

- **Node ≥ 20. Zero npm dependencies for the core.** Playwright is the only optional dependency, detected at runtime. When absent, every browser-tier check lands in `Not covered` with the one-line install hint.
- **Scripts are black boxes.** Every script supports `--help` and `--json`. SKILL.md tells the agent to run scripts, never to read their source.
- **SKILL.md ≤ 200 lines.** Detail lives in `references/`, one level deep.
- **No agent-specific paths or variables.** Paths are relative to the skill directory. No `${CLAUDE_PLUGIN_ROOT}`.
- **Nothing vendor-named.** A test walks the tree and fails on any agency, CRM product, hosting brand used as a default assumption, or personal filesystem path, outside `docs/sources.md` and lines tagged `vendor-negative-use`.
- **The shared engine has one home.** `skills/launch-audit/scripts/lib/`. `pre-launch` and `post-launch` import from `../../launch-audit/scripts/lib/` by relative path. README states the three skills ship as a set.
- **`docs/checks.md` is generated** from the check registry in code (`node scripts/gen-checks-doc.mjs`), and a test fails if it is stale, so the inventory can never drift from what runs.

## 3. The shared engine — `skills/launch-audit/scripts/lib/`

Ports-and-adapters. Pure logic is unit-tested against fixtures; all I/O sits behind two adapters (`net.mjs`, `browser.mjs`).

### 3.1 Modules

| Module | Responsibility |
|---|---|
| `args.mjs` | flag parsing, `--help` text, config-file merge, validation with loud errors |
| `net.mjs` | `fetch` with timeout, redirect chain capture (manual follow, hop by hop), bounded concurrency pool, response header retention, TLS certificate read via `node:tls`, one identifying user-agent |
| `robots.mjs` | robots.txt parse (groups, wildcards, `Sitemap:` lines), `isAllowed(ua, path)`, AI-crawler policy table |
| `sitemap.mjs` | discover (`/sitemap.xml`, `/sitemap_index.xml`, `/wp-sitemap.xml`, robots `Sitemap:`), expand index one level, fail-closed on unfetchable child, per-URL `lastmod` |
| `crawl.mjs` | sitemap ∪ same-origin BFS, caps with named drops, orphan and unlisted detection, canonical page list |
| `html.mjs` | tolerant tokenizer → `{head, headings, images, links, forms, jsonld, text, htmlAttrs, scripts, iframes}`; no external parser |
| `checks/*.mjs` | one file per dimension; each exports `register()` returning `[ {id, phase, dimension, severity, tier, title, run(ctx)} ]` |
| `registry.mjs` | collects all checks; the single source for `docs/checks.md` |
| `findings.mjs` | schema, constructor, validator (evidence required), severity ordering |
| `report.mjs` | `report.md` renderer (dimension → severity), `Not covered` assembly, `findings.json`, `crawl.json`, `baseline.json` |
| `baseline.mjs` | baseline shape, write, read, diff |
| `browser.mjs` | optional tier: Playwright detection, page render at 3 widths, screenshots, console/network capture, axe injection, Lighthouse invocation; every function returns `{available:false, reason}` when Playwright is absent |
| `dns.mjs` | `node:dns` lookups for SPF/DKIM/DMARC TXT, A/AAAA/CNAME for apex and www |
| `detect/framework.mjs` | repo-side framework and build-dir detection (used by pre-launch) |
| `detect/analytics.mjs` | tag signatures (GA4, GTM, Plausible, Fathom, PostHog, Umami, Matomo, Meta Pixel, Hotjar, Clarity) |
| `detect/placeholders.mjs` | placeholder / secret / dev-host patterns |
| `schema/required.mjs` | required properties per schema.org type (bundled table) |
| `headers/owasp.json` | vendored OWASP `headers_add` / `headers_remove` with fetch date |

### 3.2 Findings schema

```json
{
  "id": "indexability.site-noindex",
  "phase": "launch-audit",
  "dimension": "indexability",
  "severity": "blocker",
  "tier": "http",
  "page": "https://example.com/",
  "title": "Site-wide noindex on a production URL",
  "detail": "…",
  "evidence": [{ "type": "header", "value": "x-robots-tag: noindex" }],
  "fix": "…",
  "source": "http"
}
```

- `severity ∈ blocker | high | medium | low | info`. `blocker` is the only severity that changes the gate's exit code (pre-launch) or is bolded in cutover verification (post-launch).
- `tier ∈ http | browser | repo | human`.
- `evidence` types: `url`, `status`, `header`, `html`, `file`, `screenshot`, `dns`, `cert`, `metric`, `text`.
- Validation rejects a finding with empty `evidence`, unknown `severity`, or an `id` not in the registry.

### 3.3 Report bundle

`./website-launch/<slug>-<phase>-<YYYY-MM-DD>/` (overridable with `--out`), containing:

- `report.md` — grouped by dimension, severity-ranked within, each finding with evidence and fix; ends with **Not covered** and, for launch-audit and post-launch, the **Ops & access readiness** checklist marked auto-verified / human-only.
- `findings.json`, `crawl.json`, `baseline.json`
- `redirects.csv` when `--old-url` given
- `screenshots/<page-slug>/{desktop,tablet,mobile}.png` (browser tier)
- `lighthouse/<page-slug>.json` (browser tier)

`Not covered` always includes: URLs dropped by caps (by name), checks skipped because Playwright is absent, checks skipped for missing inputs (`--old-url`, `--psi-key`), externals that could not be verified (rate-limited, timed out) as distinct from broken, anything `--ignore-robots` masked, and the two things no crawl can see: copy vs. source documents, pages vs. agreed scope.

### 3.4 Baseline

Every run writes `baseline.json`: per page `{url, status, finalUrl, redirectChain, title, description, canonical, robotsMeta, h1, jsonldTypes, analyticsTags, headers(subset), imageCount, linkCount}` plus site-level `{host, https, hsts, cert.expires, robotsTxtHash, sitemapUrls[], securityHeaders}`. `post-launch` diffs production against a baseline from pre-launch or from a staging `launch-audit` run.

## 4. `pre-launch` — the gate

Runs from the repo root (or `--dir`). Inputs: `--production-url` (required), `--predecessor-url`, `--build-dir` (auto-detected: `dist/`, `out/`, `build/`, `_site/`, `public/` when it contains `index.html`; `.next` is reported advisory because it never contains root HTML), `--required-env`, `--dev-host` (repeatable), `--strict`, `--config .launch.json`, `--skip-build`, `--json`.

Order of execution: repo hygiene → placeholders → build → build output → framework hints → predecessor coverage. Display order is by group. Build runs before any dist-dependent check so a stale dist is never inspected.

### Group 1 — Repo hygiene
- clean working tree; HEAD pushed to its upstream; no nested `.git`
- Node satisfies `package.json.engines.node`
- `.env*` untracked; no committed secret-shaped strings (`sk-`, `ghp_`, `AKIA`, JWT, `-----BEGIN … PRIVATE KEY`)
- lockfile present and matches the package manager

### Group 2 — Placeholders and leaks (source and build; skips `node_modules`, `.git`, `.agents`, `.claude`, `.codex`, `.cursor`)
- placeholder analytics IDs, placeholder form IDs, `TODO`/`FIXME`/lorem ipsum/`Your text here`/`[INSERT`/`{{` in user-facing strings
- required env vars unset at build (build with them missing, detect empty interpolation)
- staging/localhost/preview hosts in build output (`localhost`, `127.0.0.1`, `*.vercel.app`, `*.netlify.app`, `*.pages.dev`, `staging.`, `dev.`, plus `--dev-host`)
- source maps referenced from built JS → `low`, `fail` only under `--strict`

### Group 3 — Framework hints (detector: Astro, Next, Nuxt, SvelteKit, Eleventy, Hugo, Vite, WordPress; unknown → group skipped with reason)
- site/base URL config equals `--production-url`
- sitemap integration present and the promised file exists in output
- trailing-slash policy consistent across config, generated links, redirect rules
- redirect file parsed for the detected host format (`vercel.json`, `netlify.toml`/`_redirects`, `next.config` redirects, Cloudflare `_redirects`, `.htaccess`); every destination resolves in the build

### Group 4 — Build output (stack-agnostic core)
- production build succeeds (non-zero → fail with stderr tail)
- `index.html` at root; 404 page exists, is not the homepage, is `noindex`
- every internal `href`/`src`/`srcset`/`poster`/CSS `url()` resolves to a file
- favicon set: `favicon.ico`, `favicon.svg` or PNG sizes, `apple-touch-icon.png` 180×180, `site.webmanifest` with icons; each referenced file exists
- OG image raster, 1200×630 ±5%, with a named warning for 2400×1260
- `robots.txt` references a sitemap on the production host; `sitemap.xml` present; every `<loc>` is production-host and exists in the build
- `llms.txt` well-formed if present; absent → `info`
- thank-you / confirmation / demo pages `noindex`
- canonical on every page, production host, self-referencing by default
- non-empty unique `<title>` and `<meta description>` per page
- one `<h1>`; `<html lang>`; viewport; charset

### Group 5 — Predecessor coverage (`--predecessor-url`)
- fetch live sitemap, expand index, **fail closed** on unfetchable child
- every old path exists at the same path in the build or has an explicit redirect
- wildcard/catch-all redirect over content paths → fail, rule quoted
- redirect chains > 1 hop, loops → fail
- leftover paths listed one per line

### The human checklist (emitted in this order; presented one at a time; confirmations recorded to `.launch-progress.json` so a session resumes)
1. forms wired to the real destination; a test submission received by a human
2. analytics property live; measurement ID set; key conversion event defined; production-only
3. hosting project connected; production env vars entered; preview deploy succeeded
4. payments (only if the repo uses a payment SDK): live keys, products, webhook registered
5. privacy / terms / cookie consent where required; contact details verified
6. Search Console verified; **12-month export taken before DNS moves** (predecessor sites only)
7. DNS plan: current records captured, TTL lowered ≥ 24h before, old host stays up through propagation
8. stakeholder sign-off on copy and imagery, in writing
9. rollback plan named

Rules stated verbatim in SKILL.md: never declare ready while any check fails; never reorder the human list.

## 5. `launch-audit` — the auditor

Runs against `--url` (staging or live). Flags: `--old-url`, `--dev-host` (repeatable), `--psi-key`, `--max-pages` (200), `--max-depth` (4), `--ignore-robots`, `--staging` (downgrades site-wide noindex from blocker to info), `--baseline`, `--browser auto|on|off`, `--out`, `--json`.

Tiers: **[H]** HTTP (always), **[B]** browser (Playwright present), **[👤]** agent judgment from collected evidence, guided by a `references/` file.

### Dimensions

1. **Crawl & inventory [H]** — sitemap ∪ BFS; per-page status/title/depth/source; orphans (in sitemap, unreachable); unlisted (reachable, not in sitemap); depth > 3 for key templates; capped URLs named.
2. **Indexability [H]** — site-wide noindex (meta, `X-Robots-Tag`, `Disallow: /`) blocker unless `--staging`; per-page noindex on sitemap URLs; unintended `nosnippet`/`noarchive`; robots.txt fetchable/valid/same-host `Sitemap:`/doesn't block assets; AI-crawler policy table (GPTBot, ClaudeBot, Claude-User, Claude-SearchBot, OAI-SearchBot, ChatGPT-User, PerplexityBot, Perplexity-User, Google-Extended, Applebot-Extended, CCBot, Bytespider) reported as `info` with training-vs-search explained; sitemap valid, ≤ 50k/50MB, every `<loc>` 200, no noindexed URLs, sane `lastmod`, same host; canonical present/absolute/self or intentional/production host/not a redirect or 404/one per page/`<link>` vs header agree; hreflang reciprocal/valid/`x-default`; parameter variants canonicalized; `llms.txt` present/well-formed/links resolve (info).
3. **Host & transport [H]** — http→https 301; HSTS (max-age ≥ 1y noted); certificate valid/expiry ≥ 30d/covers www+apex/chain complete; www↔apex single canonical host with 301; trailing-slash single policy; mixed content; redirect chains/loops; meta-refresh/JS redirects; OWASP security headers present (CSP, X-Content-Type-Options, X-Frame-Options or frame-ancestors, Referrer-Policy, Permissions-Policy; COOP/CORP info) and OWASP remove-list headers absent; compression and cache headers on static assets; HTTP/2 or 3 (info); custom 404 returns real 404 with custom body and navigation (soft-404 finding); dev/staging host leaks in HTML, assets, canonical, sitemap, robots.
4. **Head & metadata [H]** — title present/unique/10–60/not framework default; description present/unique/50–160/not boilerplate; one h1; no skipped heading levels; empty headings; `lang`, charset, viewport without `user-scalable=no`; favicon links resolve; `theme-color`; OG title/description/image (200, raster, ≥ 1200×630, width/height tags)/url matches canonical/type/site_name; Twitter card or clean OG fallback; JSON-LD parses, `@context`/`@type`, required properties per bundled table (Organization, LocalBusiness, WebSite, Article, Product, FAQPage, BreadcrumbList, Service, Person, Event), `url`/`logo`/`image` resolve, no schema on noindexed pages, types-per-template summary; feeds and manifest (info); duplicate ids/meta; meta outside head.
5. **Links [H]** — internal 4xx/5xx with referrers; externals with low concurrency and a distinct "could not verify" state; `noopener` on `_blank`; `mailto:`/`tel:` valid; links to dev host / http / redirecting internal URLs; empty anchors, `href="#"`, `javascript:`; same text → different targets (info); generic anchor text count (info); skip link present.
6. **Images & media [H]** — alt present (decorative `alt=""` allowed); width/height or aspect-ratio; lazy below fold and not on LCP candidate; modern format or `<picture>`; > 500KB flagged; broken images; exact-duplicate images by content hash across pages; OG/favicon dimensions from bytes; video preload/captions/autoplay-with-sound.
7. **Forms [H + 👤]** — inventory (action, method, fields, labels, required, honeypot/captcha); `action="#"`/empty/localhost/staging/example.com/placeholder IDs; third-party embeds resolve 200 [B: no console error]; agent classifies first-party / third-party / dead per `references/forms.md`; never submits; "test submission required" human item.
8. **Accessibility [H baseline, B full]** — [H] lang, alt coverage, labels, heading order, link text, `tabindex > 0`, `autofocus`, landmarks, iframe titles, duplicate ids; [B] axe-core WCAG 2.2 AA by impact, contrast, focus visible, keyboard reachability of nav/menu/modals, reduced-motion (info), touch targets.
9. **Performance [H hints, B measured]** — [H] page weight, request count, render-blocking scripts, preload for hero, font-display, third-party script inventory; [B] Lighthouse per key template (scores + lab LCP/INP-proxy/CLS/TBT; thresholds 90 desktop / 70 mobile); PSI field data with `--psi-key` and the "new domains have no field data" note.
10. **Analytics & tracking [H + B]** — [H] tag detection per page, missing on some templates, duplicates, inconsistent IDs; [B] collector request observed on load; consent banner where a cookie-setting tag exists (info); cookies before consent (info).
11. **Content sanity [H + 👤]** — placeholder text; copyright year; past-dated promos; phone/address/email variants site-wide; broken entities; [👤] boilerplate titles/descriptions; [👤/B] screenshot review for layout breakage, overflow, missing images, clipped mobile text, nav not collapsing.
12. **Cutover redirects [H, `--old-url`]** — crawl old site; per old path: exact 200 / redirect lands 200 / would 404 with best-match suggestion and confidence; `redirects.csv`; hops/loops; wildcard smell.
13. **Ops & access readiness [👤 with H assists]** — hosting/domain/DNS control; analytics + Search Console access; sitemap submitted; form notifications routed; email auth (SPF/DKIM/DMARC via DNS TXT [H]); chat widget; privacy/terms/cookie pages discovered by link [H]; uptime monitoring; backups; credential rotation after launch. Each marked auto-verified / human-only.

## 6. `post-launch` — the watch

Two modes, one script.

### 6.1 `--mode cutover` (run the moment DNS has moved)

Inputs: `--url` (production), `--baseline <pre-launch or staging baseline.json>`, `--old-url`, `--redirects redirects.csv` (from the audit), `--expect-analytics <id>`, `--staging-url` (to confirm it is now noindexed or gone).

Checks, in the order they matter on the day:
1. **DNS** — apex and www resolve to the expected targets (A/AAAA/CNAME from `--expect-dns` or captured at pre-launch); propagation sampled across public resolvers (Google, Cloudflare, Quad9, OpenDNS); TTL reported.
2. **Transport** — HTTPS serves the certificate for the production host; http → https; www ↔ apex canonical.
3. **Noindex gone** — no meta robots noindex, no `X-Robots-Tag: noindex`, no `Disallow: /`, on the production host (**blocker**, bolded first).
4. **Robots and sitemap on the live host** — `robots.txt` and the sitemap it names fetch 200 and reference the production host, not staging.
5. **Redirects** — every row of `redirects.csv` re-requested: `301/308` to the exact expected target, one hop; drift listed.
6. **Baseline diff** — every page in the baseline still 200 on production; title/description/canonical/h1/schema types unchanged unless intended; new redirects; pages missing; analytics tags present where they were present.
7. **Analytics live** — tag present in HTML; [B] collector request observed.
8. **Forms live** — every inventoried form endpoint still resolves; third-party embeds 200.
9. **Staging sealed** — `--staging-url` returns noindex, 401/403/410, or a redirect to production (a live indexable staging copy is a duplicate-content finding).
10. **Old host** — if `--old-url` still resolves, it must redirect to production; a live old site serving content is a finding.
11. **Security headers** — unchanged from staging or better.
12. **Human items for the day** — submit sitemap in Search Console and Bing Webmaster; request indexing for the top pages; confirm Search Console shows the new property; verify analytics real-time; keep the old host up through propagation; announce only after this report is clean.

### 6.2 `--mode watch` (day 1 → day 30)

Emits a dated plan and re-runs the cutover checks plus a light audit on demand. The plan, from `references/thirty-day-watch.md`:

- **Days 1–3, daily:** cutover checks re-run; Search Console coverage errors; 404 log review (server logs or Search Console); Core Web Vitals lab re-measure; uptime.
- **Days 3–7:** sitemap processed in Search Console (submitted vs. indexed); analytics conversion events firing; redirect spot-check on the top 20 old URLs; broken-link re-crawl.
- **Week 2:** internal-link crawl as a bot would (orphans, depth); structured data validated on production URLs; titles/descriptions/OG re-check; indexation count (`site:` query is unreliable — use Search Console Pages report).
- **Weeks 2–4, weekly:** organic traffic vs. the pre-launch export; top-20 keyword positions if tracked; 404 log; Core Web Vitals field data once CrUX has 28 days.
- **Day 30:** retrospective — what regressed, what the redirect map missed, what to add to the pre-launch gate for next time. Old host may be decommissioned only after Search Console shows no crawl of old URLs and redirects have been in place ≥ 30 days.

`--mode watch --day N` prints exactly what is due that day and re-runs the automated portion. State is kept in `website-launch/<slug>-post-launch/watch.json`.

## 7. Documentation and references

- `docs/checks.md` — generated from the registry. Columns: id, phase, dimension, severity, tier, title, what it catches, source. A test compares the generated output to the committed file.
- `docs/sources.md` — attribution: Front-End Checklist (thedaviddias), MarketingPipeline and greghub launch checklists, OWASP Secure Headers Project (vendored JSON, fetch date), Google Search Central, the llms.txt proposal, the Agent Skills specification, and the 2026 launch/SEO/post-launch lists that contributed items. Each with what was taken.
- Each `references/*.md` in a skill answers: what the finding means, why it matters at launch specifically, how to fix it on common stacks, and what it does not tell you.
- README documents installation for: Claude Code (`/plugin marketplace add`), Codex / Copilot / Cursor / Gemini CLI / others (clone and point the agent at `skills/`, or copy the three dirs), and manual runs of the scripts without any agent.

## 8. Testing

- **Framework:** `node --test`, run by `npm test` with the glob form that works on Node 22 (`node --test "test/**/*.test.mjs"`).
- **No network, no browser in tests.** `net.mjs` and `browser.mjs` are injected; tests pass fakes. A recorded fixture (`test/fixtures/recorded/`) holds a small real crawl (URLs, statuses, headers, bodies) so the crawl/link/redirect paths are exercised realistically.
- **Every check has at least one positive and one negative fixture.** A check that only has a passing fixture is caught by a registry test that requires both.
- **Detector presence proofs.** Every pattern-based detector (placeholders, dev hosts, secrets, analytics tags, vendor names) is tested to fire on a known-present string before its absence is asserted anywhere.
- **Gate semantics.** Tests assert exit 1 on any `fail`, exit 0 on all `pass|skip`, and that no flag can convert a `fail`.
- **Auditor semantics.** Tests assert exit 0 with fifty blockers.
- **Report contract.** `Not covered` present in every report; findings validate; `docs/checks.md` matches the registry; SKILL.md frontmatter validates against the spec (name = dirname, ≤ 64 chars, description ≤ 1024); SKILL.md ≤ 200 lines; no vendor names.
- **Real-site smoke** is a documented manual step in `docs/`, not a test: run all three phases against a small public site and read every finding. It is recorded as done in the session summary before the first release tag.

## 9. Out of scope (v1)

Fixing or generating anything; submitting forms; authenticated CMS checks; perceptual (near-duplicate) image matching; Search Console / analytics API integrations; scheduled monitoring or alerting; multilingual content review beyond hreflang validity; copy-vs-source and pages-vs-scope comparison (no source of truth reachable).

## 10. Open decisions settled here

- Names: `pre-launch`, `launch-audit`, `post-launch`. Directory names match `name:`.
- Output root: `./website-launch/` under the working directory.
- Config file: `.launch.json` at the repo root, documented in `pre-launch/references/config.md`.
- License: MIT.
