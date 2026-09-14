# Reading the gate

The gate answers one question — *is anything mechanically wrong with this launch?* — and it
answers it with an exit code. Everything else in the bundle exists to tell you what to do about
the answer.

    exit 0    the gate passed
    exit 1    the gate failed: at least one check has status "fail"
    exit 2    a usage error, an unreadable --dir, or an unexpected failure

---

## The four statuses

Every check lands in exactly one, and only one of them is the verdict.

| Status | Means | Blocks? |
|---|---|---|
| `pass` | the check ran and found nothing | no |
| `fail` | the check found something that blocks the launch | **yes** |
| `advisory` | the check found something worth knowing that does not block | no |
| `skip` | the check could not run, and says why | no — but it is **not** a pass |

**`gate: fail` if and only if some check has status `fail`.** Nothing else changes the verdict.

**A crashed check fails.** If a gate check throws, it lands as `fail` with the detail
`check crashed — <message>`. This is deliberate and it is the opposite of what `launch-audit`
does. The auditor reports, so a crash there costs one dimension of a report. The gate decides, so
a check that could not answer has not cleared the launch. If a check crashes, fix the check.

**A skip is not a pass.** Every skip carries a reason, and every reason appears in the report's
`Not covered` section by name. `hygiene.pushed: skipped — this directory is not a git repository`
means nobody checked whether the commit was pushed. It does not mean it was.

**A passing check can still have a bound, and it declares it.** A check that ran but could not
reach part of its subject adds its own line to `Not covered` — an `og:image` on another origin
whose bytes were never fetched, files a secret scan skipped for size, redirect destinations that
are templates rather than paths, the source directories a placeholder scan actually looked at.
These sit between the skips and the two fixed lines, and they are the reason a `pass` in this gate
means "this was checked and was fine" rather than "nothing was reported".

---

## The six groups, and why they run in that order

    hygiene → placeholders → build → output → framework → predecessor

The order is a dependency order, not a ranking.

- **hygiene** — the repository. Is what you are about to deploy in a commit, pushed, on the right
  Node, with no secrets and one lockfile?
- **placeholders** — the unfinished bits. Placeholder analytics ids, placeholder form endpoints,
  lorem ipsum, unset environment variables, dev hosts, source maps.
- **build** — the build ran, and it produced a directory with a homepage in it. **This runs before
  anything reads the output**, so a stale `dist` is never what the gate inspects.
- **output** — the files themselves: the 404 page, the references, the icons, the social card,
  robots, the sitemap, canonicals, titles, descriptions, headings, lang, viewport, charset.
- **framework** — what the generator was told to do against what it produced. Skips entirely on an
  unrecognised stack rather than guessing.
- **predecessor** — only with `--predecessor-url`. Will the domain move take its rankings with it?

---

## The bundle

    report.md        the verdict, every finding with evidence, Not covered, the human checklist
    findings.json    the same findings, machine-readable
    gate.json        the full results object — every check, its status, detail and evidence
    manifest.json    exactly which files this run wrote, itself excluded

Read `report.md` top to bottom. It opens with the verdict, so there is nothing to hunt for.

---

## Triage, in order

1. **Read the failing checks first, all of them, before fixing anything.** Thirty failures from one
   template is one fix. Fixing them one at a time teaches you nothing about which they are.
2. **Fix causes, not symptoms.** `build.succeeds` failing makes every `output.*` check meaningless
   — they ran against whatever was on disk from last time. Fix the build, rerun, read again.
3. **Never suppress.** There is no flag that turns a failure into a warning, and adding one would
   be the wrong fix. If a check is wrong about your site, that is a bug in the check: report it,
   or correct it in the source, and say plainly in your summary that you did.
4. **Rerun until the gate passes.** A partial pass is not a pass, and "only two left" is the state
   every failed launch was in an hour before it shipped.
5. **Then start the human checklist.** It is the half of the launch no script reaches.

---

## What the gate cannot see

Repeat this section verbatim when you report. It is the whole of `Not covered`, plus two things
that are true of every run:

- **Copy vs. source documents.** Nothing here compares the words on the pages against the
  signed-off copy. Somebody has to sit with both and read.
- **Pages vs. agreed scope.** Nothing here knows which pages were supposed to exist. A page that
  was never built is invisible to a checker.

A repository can pass every check in this skill and still be missing half of what was agreed.
