// The human checklist: nine things no script can verify, in the order they have to happen.
//
// The order is a dependency order, not a preference, and two of the dependencies are one-way
// doors:
//
// - The **Search Console baseline** has to be exported *before* DNS moves. After the cutover the
//   old property stops collecting, and the twelve months of query data that would have told you
//   whether the migration worked are gone.
// - The **forms** have to be wired *before* the deploy that makes them public, because every
//   submission that arrives while they point nowhere is a customer nobody can call back.
//
// Everything else is ordered by what unblocks what: hosting before payments (the keys live in the
// hosting project), legal before sign-off (a stakeholder signs off on the whole page), DNS before
// the rollback plan (a rollback plan that does not name the DNS records is not a plan).
//
// Progress is kept in `.launch-progress.json` in the repository being launched, so a session that
// ends halfway through resumes where it stopped rather than starting the interrogation again.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const PROGRESS_FILE = '.launch-progress.json'

// A dependency name means "only ask this when the repository or the run implies it": asking a
// brochure site about payment webhooks trains people to skim the list.
export const HUMAN_ITEMS = [
  {
    id: 'forms',
    requires: null,
    title: 'Every form reaches a person',
    instructions: [
      'For each form on the site: submit it yourself against the production endpoint, and then have',
      'the person who will actually answer it confirm out loud that the message arrived — in the inbox',
      'they read, not a spam folder, and not a shared address nobody opens. Check the success message',
      'the visitor sees, check any autoresponder, and check the record landed wherever it is meant to',
      '(CRM, spreadsheet, ticket queue). "The endpoint returns 200" is not this item.',
    ].join(' '),
  },
  {
    id: 'analytics',
    requires: null,
    title: 'Analytics is live and recording the right property',
    instructions: [
      'Confirm the measurement id in the build belongs to the production property, not a test one.',
      'Load the live site and watch the real-time report register the visit. Define at least one',
      'conversion event that matters (a form submission, a purchase, a call click) and fire it once to',
      'see it arrive. Confirm the tag does not run on staging or on localhost, so the numbers you will',
      'be judged on are only real visitors.',
    ].join(' '),
  },
  {
    id: 'hosting',
    requires: null,
    title: 'The hosting project is connected and configured',
    instructions: [
      'Confirm the hosting project is connected to the right repository and branch, that every',
      'production environment variable is entered there (not only in a local .env), and that a preview',
      'deploy of the exact commit you are launching built and rendered correctly. Note who has access',
      'to the hosting account, and that it is more than one person.',
    ].join(' '),
  },
  {
    id: 'payments',
    requires: 'payments-sdk',
    title: 'Payments are in live mode end to end',
    instructions: [
      'Switch from test keys to live keys and confirm the live keys are the ones in the production',
      'environment. Confirm the products, prices and currencies are the ones that were agreed. Register',
      'the webhook against the production url and confirm the provider shows a successful delivery.',
      'Then make one real payment, confirm it appears in the provider dashboard and in your own records,',
      'and refund it.',
    ].join(' '),
  },
  {
    id: 'legal',
    requires: null,
    title: 'Legal pages and contact details are correct',
    instructions: [
      'Confirm the privacy policy, terms, and any cookie or consent banner required where the audience',
      'lives are present, linked from every page, and describe what the site actually does — including',
      'the analytics and the form processor. Check the company name, registration details, postal',
      'address, phone number and email against the real ones, and check every tel: link dials the number',
      'printed beside it.',
    ].join(' '),
  },
  {
    id: 'gsc-baseline',
    requires: 'predecessor',
    title: 'The Search Console baseline is exported, before DNS moves',
    instructions: [
      'Verify the old site in Search Console if it is not already, then export twelve months of',
      'performance data (queries, pages, clicks, impressions, average position) and the Pages coverage',
      'report, and save them somewhere the whole team can reach. This is a one-way door: once DNS moves,',
      'the old property stops collecting, and this is the only baseline that can tell you whether the',
      'migration worked. Do it now, not on cutover day.',
    ].join(' '),
  },
  {
    id: 'dns',
    requires: null,
    title: 'The DNS cutover plan is written down',
    instructions: [
      'Capture every current record for the apex and www (type, value, TTL) and save the export. Lower',
      'the TTL to five minutes at least 24 hours before the cutover, so a mistake can be undone in',
      'minutes rather than a day. Write down who holds the registrar login, the exact records that will',
      'change, and the time window. Confirm the old host stays up and serving through propagation.',
    ].join(' '),
  },
  {
    id: 'signoff',
    requires: null,
    title: 'Stakeholder sign-off on copy and imagery, in writing',
    instructions: [
      'Get the person who owns the content to say, in writing, that the copy and the images on the live',
      'pages are the approved ones. No crawler can compare a page against a signed-off document, and no',
      'checker knows which pages were supposed to exist — so also confirm the page list against what was',
      'agreed, and name anything that was dropped.',
    ].join(' '),
  },
  {
    id: 'rollback',
    requires: null,
    title: 'The rollback plan is named',
    instructions: [
      'Write down, in one paragraph, exactly how this launch is undone: which DNS records revert to what',
      'values, which deploy is rolled back to which commit, who is allowed to make that call, and how',
      'long it takes to take effect. Confirm the old site can still serve during that window. A rollback',
      'plan that only exists in somebody\'s head is not one.',
    ].join(' '),
  },
]

export const HUMAN_ITEM_IDS = HUMAN_ITEMS.map((item) => item.id)

const PAYMENT_SDK = /stripe|paddle|lemonsqueezy|@paypal|braintree|square/i

const hasPaymentSdk = (pkg) => Object.keys({ ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) })
  .some((name) => PAYMENT_SDK.test(name))

// The items this run should ask about, in the canonical order, each flagged with whether it has
// already been confirmed. Order is never derived from the progress file: confirming item five
// does not promote item six.
export function humanItemsFor({ pkg = {}, config = {}, confirmed = [] } = {}) {
  const done = new Set(confirmed)
  return HUMAN_ITEMS
    .filter((item) => {
      if (item.requires === 'payments-sdk') return hasPaymentSdk(pkg)
      if (item.requires === 'predecessor') return Boolean(config.predecessorUrl)
      return true
    })
    .map((item) => ({
      id: item.id,
      title: item.title,
      instructions: item.instructions,
      requires: item.requires,
      confirmed: done.has(item.id),
    }))
}

// ---------------------------------------------------------------------------------- the progress

const EMPTY = () => ({ confirmed: [], updatedAt: null })

// A progress file that cannot be read is an empty one. It records what a person has confirmed, and
// the worst a bad read can cause is being asked again — whereas throwing here would stop the gate
// over a file that is not part of its verdict.
export function readProgress(dir) {
  const path = join(dir, PROGRESS_FILE)
  if (!existsSync(path)) return EMPTY()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const confirmed = Array.isArray(parsed?.confirmed) ? parsed.confirmed.filter((id) => typeof id === 'string') : []
    return { confirmed, updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null }
  } catch {
    return EMPTY()
  }
}

export function writeProgress(dir, progress, now = new Date()) {
  const payload = { confirmed: progress.confirmed, updatedAt: now.toISOString() }
  writeFileSync(join(dir, PROGRESS_FILE), `${JSON.stringify(payload, null, 2)}\n`)
  return payload
}

// Appends one confirmation. An id nobody offered is refused rather than written: a typo that
// silently records nothing would read as progress on the next run.
export function confirmItem(dir, id, allowed = HUMAN_ITEM_IDS, now = new Date()) {
  if (!allowed.includes(id)) {
    throw new Error(`"${id}" is not a checklist item. The items are: ${allowed.join(', ')}`)
  }
  const progress = readProgress(dir)
  if (!progress.confirmed.includes(id)) progress.confirmed.push(id)
  return writeProgress(dir, progress, now)
}

export function resetProgress(dir, now = new Date()) {
  return writeProgress(dir, { confirmed: [] }, now)
}
