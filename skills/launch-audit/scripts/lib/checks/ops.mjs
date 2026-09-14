// Ops and access readiness: the launch jobs that are not about the markup at all.
//
// Most of what stops a launch going wrong is not in the HTML. Somebody has to own the hosting
// account, somebody has to be able to change DNS, the form has to reach an inbox a person reads,
// and the credentials handed round during the build have to be rotated before the site is public.
// An audit that only reads pages cannot see any of that, and a report that only lists page
// problems quietly implies the rest is fine.
//
// So this dimension ships `OPS_CHECKLIST` — the thirteen items — in every report, each marked with
// the check that verifies it or with `[human]` when nothing can. Six of them are auto-verified:
// the orchestrator (Task 14) marks an item verified when the check it names produced no findings.
// The other seven are somebody's job, and saying so plainly is the whole point.
//
// Two of the thirteen are checkable here and are checked here:
//
// - Email authentication. A site that sends mail — a contact form, an order confirmation, a
//   password reset — from a domain with no SPF, DKIM or DMARC has those messages filed as spam,
//   and the sender never finds out. The records are resolved once in _ctx.mjs; this reads them.
// - The legal pages. Whether a site *needs* a privacy policy is a question about what it collects
//   and where its visitors live, which no crawler can answer; whether it *links to one at all* is
//   a fact about the markup, and a site with no such link anywhere is almost always a site that
//   forgot rather than one that decided.
//
// Both are pure over the context: nothing here fetches or resolves.

import { defineCheck } from '../registry.mjs'

const PHASE = 'launch-audit'
const DIMENSION = 'ops'
const TIER = 'http'

// The launch list. `auto` names the check that verifies the item — the orchestrator marks an item
// verified when that check produced no findings — and null means no request can answer it.
export const OPS_CHECKLIST = [
  { label: 'Hosting account provisioned; access confirmed', auto: null },
  { label: 'Domain registrar access tested; DNS control confirmed', auto: null },
  { label: 'Analytics property live; conversion event defined', auto: 'analytics' },
  { label: 'Search Console (and Bing Webmaster) verified; sitemap submitted', auto: null },
  { label: 'Form notifications route to a monitored inbox; test submission received', auto: 'forms' },
  { label: 'Email authentication: SPF, DKIM, DMARC present', auto: 'ops.email-auth' },
  { label: 'Privacy policy, terms, and cookie policy published where required', auto: 'ops.legal-pages' },
  { label: 'Chat / booking widgets installed and tested (if used)', auto: null },
  { label: 'Uptime monitoring in place', auto: null },
  { label: 'Backups configured and a restore tested', auto: null },
  { label: 'Staging credentials and any secrets shared during the build rotated', auto: null },
  { label: 'Custom 404 returns a real 404', auto: 'host.soft-404' },
  { label: 'Search engines allowed on production', auto: 'indexability.site-noindex' },
]

// What a link to a policy page looks like, in its text or in its href. Deliberately loose: the
// question is whether anything at all points at one, not whether the wording is right.
const LEGAL = /privacy|terms|cookie/i
const LEGAL_SEARCHED = ['privacy', 'terms', 'cookie']

const text = (value) => ({ type: 'text', value })
const dns = (value) => ({ type: 'dns', value })
const url = (value) => ({ type: 'url', value })
const metric = (value) => ({ type: 'metric', value })

const define = (def) => defineCheck({ phase: PHASE, dimension: DIMENSION, tier: TIER, ...def })
const emit = (check, overrides) => check.mk({ title: check.title, ...overrides })

const htmlPages = (ctx) => ctx.crawl.pages.filter((p) => p.page !== null && p.status >= 200 && p.status < 300)

export const emailAuth = define({
  id: 'ops.email-auth',
  severity: 'medium',
  title: 'Mail from this domain is not authenticated',
  catches: 'A missing SPF, DKIM or DMARC record — the three things that decide whether a form notification reaches an inbox or a spam folder.',
  run(ctx) {
    const domain = ctx.target.apex
    const records = ctx.dnsRecords ?? {}
    const out = []

    if (records.spf?.present !== true) {
      out.push(emit(emailAuth, {
        detail: `${domain} publishes no SPF record. SPF is the list of servers allowed to send mail as this domain; without one, every receiving server has to guess, and the safe guess is the spam folder. The form notification nobody ever receives usually starts here.`,
        evidence: [dns(`TXT ${domain} — no v=spf1 record`), text('SPF: absent')],
        fix: 'Publish a TXT record on the domain starting "v=spf1", listing whatever sends your mail, ending in -all.',
      }))
    }

    if (records.dmarc?.present !== true) {
      out.push(emit(emailAuth, {
        detail: `${domain} publishes no DMARC record. DMARC is what ties SPF and DKIM together and tells receiving servers what to do when a message fails both — and it is the only one of the three that reports back, so without it nobody finds out that anything is being rejected.`,
        evidence: [dns(`TXT _dmarc.${domain} — no v=DMARC1 record`), text('DMARC: absent')],
        fix: 'Publish a TXT record at _dmarc.<domain> starting "v=DMARC1; p=none; rua=mailto:…", read the reports, then tighten p= to quarantine or reject.',
      }))
    }

    const dkim = records.dkim?.found ?? []
    if (dkim.length === 0) {
      out.push(emit(emailAuth, {
        detail: `No DKIM key was found for ${domain} under any of the selectors this audit knows about. DKIM signs each message so a receiving server can prove it was not altered or forged. This is the least certain of the three findings — a key published under a selector not on the list would be missed — so check with whoever runs your mail before acting on it.`,
        evidence: [dns(`TXT <selector>._domainkey.${domain} — no key found under the selectors checked`), text('DKIM: none found under the common selectors')],
        fix: 'Ask your mail provider for the DKIM record to publish, add it, and send yourself a test message to confirm it signs.',
      }))
    }

    return out
  },
})

export const legalPages = define({
  id: 'ops.legal-pages',
  severity: 'medium',
  title: 'Nothing on this site links to a privacy policy, terms or a cookie policy',
  catches: 'No link anywhere on the crawled site whose text or href mentions privacy, terms or cookies.',
  run(ctx) {
    const pages = htmlPages(ctx)
    if (pages.length === 0) return []
    let links = 0
    for (const entry of pages) {
      for (const link of entry.page.links) {
        links++
        const label = link.text !== '' ? link.text : (link.ariaLabel ?? '')
        if (LEGAL.test(label) || (link.href !== null && LEGAL.test(link.href))) return []
      }
    }
    return [emit(legalPages, {
      page: pages[0].url,
      detail: `None of the ${links} links across ${pages.length} crawled ${pages.length === 1 ? 'page' : 'pages'} mentions privacy, terms or cookies, in its text or in its address. Whether this site is required to publish those is a question about what it collects and where its visitors are — no crawler can answer it. Whether it links to any of them is a fact, and the answer here is no, which is much more often an oversight than a decision.`,
      evidence: [
        text(`searched the text and href of every link for: ${LEGAL_SEARCHED.join(', ')}`),
        metric(`${links} links across ${pages.length} crawled page${pages.length === 1 ? '' : 's'}, none matching`),
        url(pages[0].url),
      ],
      fix: 'Publish the policies the site actually needs and link them from the footer, where people look for them.',
    })]
  },
})

export const checklist = define({
  id: 'ops.checklist',
  severity: 'info',
  // Nothing produced this over HTTP: it is the list of jobs a person has to walk, which is what
  // the human tier means.
  tier: 'human',
  title: 'Launch readiness: the jobs that are not in the markup',
  catches: 'The thirteen ops and access items every launch needs, each marked with the check that verifies it or as somebody\'s job.',
  run() {
    return [emit(checklist, {
      detail: `${OPS_CHECKLIST.length} readiness items, of which ${OPS_CHECKLIST.filter((item) => item.auto !== null).length} are verified by checks in this report and ${OPS_CHECKLIST.filter((item) => item.auto === null).length} are not verifiable over HTTP by anything. The unverifiable ones are not less important — losing the registrar login or leaving a staging password live is a worse day than any finding above — they are simply somebody's job rather than a tool's.`,
      evidence: OPS_CHECKLIST.map((item) => text(`- ${item.auto === null ? '[human]' : `[auto: ${item.auto}]`} ${item.label}`)),
      fix: 'Walk the list with whoever owns the site. Tick the human items yourself; the auto ones are answered by the findings above.',
    })]
  },
})

export const checks = [
  emailAuth,
  legalPages,
  checklist,
]
