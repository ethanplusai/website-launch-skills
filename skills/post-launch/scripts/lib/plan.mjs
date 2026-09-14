// The thirty-day watch, as a table.
//
// SCHEDULE is spec §6.2 with every window flattened into explicit day numbers, because "days 3–7"
// is a deadline and a plan needs a date. The flattening rule is stated once here so it is the same
// everywhere: a **daily** window repeats on each of its days (days 1–3, three times); a **window**
// with a range is one task, due on the last day of the range, which is the day it stops being
// early and starts being late; a **weekly** cadence repeats on the last day of each of its weeks.
//
// `automated` says whether this repository can do the task at all. It is deliberately conservative:
// reading the Search Console Pages report, confirming a conversion event fired, and deciding
// whether the old host may be switched off are human work, and marking them automated would let a
// script's silence stand in for somebody actually looking. That is also why a recorded run only
// ever covers the automated rows below it — see `watchPlan`.
//
// `command` is written relative to the skill's own directory, which is where the SKILL.md tells an
// agent to run these from. `<url>` and `<n>` are placeholders a person substitutes.

export const WATCH_DAYS = 30

// How far ahead the plan looks. A month-long list printed every day is a list nobody reads.
export const UPCOMING_WINDOW = 7

const WATCH_COMMAND = 'node scripts/post-launch.mjs --mode watch --url <url> --day <n>'
const AUDIT_COMMAND = 'node ../launch-audit/scripts/launch-audit.mjs --url <url>'
const AUDIT_BROWSER_COMMAND = 'node ../launch-audit/scripts/launch-audit.mjs --url <url> --browser on'
const SPOT_CHECK_COMMAND = 'node scripts/post-launch.mjs --mode cutover --url <url> --redirects redirects.csv'

const daily = (task, automated, command) => ({ window: 'days 1-3, daily', days: [1, 2, 3], task, automated, command })
const byDay7 = (task, automated, command) => ({ window: 'days 3-7', days: [7], task, automated, command })
const week2 = (task, automated, command) => ({ window: 'week 2', days: [14], task, automated, command })
const weekly = (task, automated, command) => ({ window: 'weeks 2-4, weekly', days: [14, 21, 28], task, automated, command })
const day30 = (task, automated, command) => ({ window: 'day 30', days: [30], task, automated, command })

export const SCHEDULE = [
  daily('Re-run the cutover checks', true, WATCH_COMMAND),
  daily('Search Console: read the Pages report for new coverage errors', false, null),
  daily('Review the 404 log — server logs, or Search Console Pages, "Not found"', false, null),
  daily('Re-measure Core Web Vitals in the lab', true, AUDIT_BROWSER_COMMAND),
  daily('Confirm the site has stayed up since the cutover', false, null),

  byDay7('Search Console: the sitemap is processed — compare submitted against indexed', false, null),
  byDay7('Confirm the analytics conversion events are firing, not just pageviews', false, null),
  byDay7('Redirect spot-check on the top twenty old urls', true, SPOT_CHECK_COMMAND),
  byDay7('Broken-link re-crawl of the live site', true, AUDIT_COMMAND),

  week2('Internal-link crawl as a bot would do it: orphans and depth', true, AUDIT_COMMAND),
  week2('Validate the structured data on production urls', true, AUDIT_COMMAND),
  week2('Re-check titles, descriptions and OG tags against the baseline', true, AUDIT_COMMAND),
  week2('Indexation count from the Search Console Pages report — a site: query is unreliable', false, null),

  weekly('Organic traffic against the pre-launch export', false, null),
  weekly('Top-twenty keyword positions, if they are tracked', false, null),
  weekly('Review the 404 log', false, null),
  weekly('Core Web Vitals field data, once CrUX has twenty-eight days of it', false, null),

  day30('Retrospective: what regressed, what the redirect map missed, what to add to the pre-launch gate next time', false, null),
  day30('Old-host decommission decision — only once Search Console shows no crawl of old urls and the redirects have been in place for thirty days', false, null),
]

const DUE_RANK = { overdue: 0, today: 1, upcoming: 2 }

const commandFor = (row, day) => (row.command === null ? null : row.command.replace('<n>', String(day)))

// What is due on `day`, given what has actually been run.
//
// A task is `overdue` when its day has passed and nothing covered it. Only an **automated** task
// can be covered by a recorded run, and a run covers every automated day at or below its own —
// re-running the checks on day 8 answers the day-3 question. A human task is never covered by a
// script: nothing in `state.runs` is evidence that somebody opened Search Console, so those stay
// overdue until a person clears them, which is the honest answer.
//
// `upcoming` looks seven days ahead and no further.
export function watchPlan(today = 1, state = { runs: [] }) {
  const day = Number(today)
  const ranAt = (state?.runs ?? []).map((run) => Number(run.day)).filter((n) => Number.isFinite(n))
  const out = []

  SCHEDULE.forEach((row, order) => {
    for (const scheduled of row.days) {
      let due
      if (scheduled === day) {
        due = 'today'
      } else if (scheduled < day) {
        if (row.automated && ranAt.some((run) => run >= scheduled)) continue
        due = 'overdue'
      } else {
        if (scheduled > day + UPCOMING_WINDOW) continue
        due = 'upcoming'
      }
      out.push({ due, day: scheduled, task: row.task, automated: row.automated, command: commandFor(row, scheduled), order })
    }
  })

  return out
    .sort((a, b) => DUE_RANK[a.due] - DUE_RANK[b.due] || a.day - b.day || a.order - b.order)
    .map(({ order, ...entry }) => entry)
}
