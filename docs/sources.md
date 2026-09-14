# Sources

Everything in this repository was written for it. **No code was copied from any of the sources
below.** What was taken is item ideas — the knowledge of *what is worth checking at a launch* —
which is the part these lists earned and the part a checker cannot invent from first principles.
Each entry says what came from it.

Where a source is a list of prose rules, the work here was deciding which of its items a script can
actually verify, turning each one into a check with evidence and a fix, and writing a passing and a
failing fixture for it. Items that no script can verify became the human checklists instead, which
is why `pre-launch` ends with nine questions and `post-launch` with six.

## Checklists

**[Front-End Checklist](https://github.com/thedaviddias/Front-End-Checklist)** — David Dias
(`thedaviddias/Front-End-Checklist`), MIT.
Item ideas across the head (title, description, canonical, charset, viewport, favicons, social
cards, theme colour), HTML structure and semantics, images (dimensions, formats, lazy loading,
alt text), accessibility and performance. It is the most complete public statement of what belongs
on a page; the head, images and content dimensions of `launch-audit` follow its shape most closely.

**[Website-Launch-Checklist](https://github.com/MarketingPipeline/Website-Launch-Checklist)** —
`MarketingPipeline`, and
**[website-launch-checklist](https://github.com/greghub/website-launch-checklist)** — Greg Hubacek
(`greghub`).
Launch-day and finishing-touch items: the 404 page, the favicon set, the robots and sitemap pair,
analytics actually installed, form endpoints reachable, print styles, the things that are obvious
in hindsight and forgotten in practice. These two shaped the `output` group of the `pre-launch`
gate and the ops checklist.

## Standards and documentation

**[OWASP Secure Headers Project](https://owasp.org/www-project-secure-headers/)** — OWASP.
The recommended-header and remove-header lists are **vendored** into this repository as
`skills/launch-audit/scripts/lib/headers/owasp.json`, built from the project's own
`ci/headers_add.json` and `ci/headers_remove.json`
([source repository](https://github.com/OWASP/www-project-secure-headers)), fetched **2026-09-13**.
That file holds the header names and recommended values only; the checks that read it, the
severities and the advice are this repository's. The fetch date is recorded in the JSON so a stale
copy is visible rather than assumed current.

**[Google Search Central documentation](https://developers.google.com/search/docs)** — Google.
The rules behind the indexability dimension: how `robots.txt` and `noindex` interact and why a
disallowed page cannot be de-indexed, canonical link semantics and self-referencing canonicals,
sitemap format and size limits, hreflang reciprocity, and the required and recommended properties
of the structured-data types the audit validates.

**[The llms.txt proposal](https://llmstxt.org/)** — Jeremy Howard and contributors.
The file format and location behind `indexability.llms-txt`: what `/llms.txt` is for, where it
lives, and what a well-formed one contains. The check reports its presence or absence as
information — the proposal is a proposal, not a requirement.

**[The Agent Skills specification](https://agentskills.io/)** — the open packaging format.
How the three skills are packaged: the `SKILL.md` frontmatter fields and their limits, the
directory name matching the `name:`, progressive disclosure through `references/`, and the rule
that a skill must not assume any particular agent. `test/skills-contract.test.mjs` enforces the
parts of it that can be tested.

## The 2026 launch and SEO lists

These four contributed items to the dimensions the older checklists predate — Core Web Vitals
thresholds, the redirect-map discipline of a domain migration, and the shape of the thirty days
after a launch.

**[Website Launch Checklist 2026: 150+ Items to Cover](https://www.digitalapplied.com/blog/website-launch-checklist-150-items-2026)**
— Digital Applied. The framing of a launch as a thirty-day window rather than a deploy click, and
items across the performance, accessibility, security and analytics tracks.

**[Website Launch SEO Checklist 2026: 43 Points](https://scalegrowth.digital/resources/seo/website-launch-seo-checklist/)**
— Scale Growth Digital. The four failure modes it names — an incomplete redirect map, a staging
noindex left in place, url changes without matching canonicals and sitemap, and no traffic baseline
to measure against — are the four things `pre-launch` and `post-launch` are ordered around.

**[Website Post Launch Checklist: What to do in the first 30 days](https://wildcurrant.co.uk/website-post-launch-checklist/)**
— Wild Currant. The first-thirty-days sequence: indexing before rankings, forms before traffic,
tracking before conclusions. It shaped the day ordering of the `post-launch` watch.

**[From Deployment to Discovery: A 30-Day SEO Checklist After Launching a Website](https://ourcodeworld.com/articles/read/4407/from-deployment-to-discovery-a-30-day-seo-checklist-after-launching-a-website)**
— Our Code World. Post-launch verification items: checking rendered output rather than source on
JavaScript-heavy sites, and validating structured data on production urls so development
placeholders are caught after the deploy rather than before it.

## License

This repository is MIT licensed. The sources above keep their own licenses; nothing from them is
redistributed here except the OWASP header lists noted above, which the OWASP project publishes for
this use.
