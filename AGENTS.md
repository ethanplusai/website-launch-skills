# AGENTS.md

This repository holds three skills, and which one to use is decided by where the site is, not by
what you are asked. If the site is not deployed yet and you have the repository, use `pre-launch`:
it inspects the repo and the build output, blocks on anything mechanical that is wrong, and exits 1
so the launch cannot proceed past it. If there is a url — staging or live — use `launch-audit`: it
crawls the site and reports, and it always exits 0. If DNS has just moved, or the site went live
within the last thirty days, use `post-launch`: it verifies the cutover against the baseline the
earlier phases wrote, then runs the daily watch. Run them in that order; each one depends on
artifacts the previous one produced. The three ship as a set and share one engine, so install or
copy all three together.

The golden rule is that all three are read-only and report-only. Nothing here edits a site,
submits a form, flips a setting, writes to a provider API, or clicks a destructive control. Every
finding is a recommendation with evidence — a url, a status code, a header value, a `file:line` —
for a human to act on. The gate never softens either: there is no flag that turns a `fail` into a
warning, and if a check is wrong about a site, the fix is to correct the check and say so, not to
route around it.

Every report always contains a section called **Not covered** (in the gate, the human checklist
follows it; everywhere else it is the last section), and it is never a pass. It names every
bound on coverage — page and depth caps, sampled pages, unverifiable external links, tools that
were not installed, inputs nobody supplied — and every check that was skipped, with its reason. A
skip is not a pass either. When you summarise a run to a person, repeat that section verbatim:
unedited, uncompressed, and not filed under minor. A clean report over a narrow scope is a narrow
report, and the reader can only tell which one they are holding if you say so.
