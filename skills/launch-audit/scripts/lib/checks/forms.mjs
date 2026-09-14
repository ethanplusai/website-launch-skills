// Forms: the one part of a launch where a silent failure costs a real enquiry.
//
// Pure over the audit context. _ctx.mjs has already fetched every embed that could be a form —
// an iframe or off-origin script written inside a `<form>`, or anything from a host that exists to
// host forms — into `probes.embeds`, so nothing here fetches.
//
// Everything except the embed check is per form rather than per page, because a page routinely
// carries several forms and they fail independently: a newsletter box wired to a placeholder and a
// contact form wired correctly are two different facts about one page. Each finding names the form
// by its position on the page and by the action it posts to, which is what you search the template
// for.
//
// This dimension owns the audit's only human-tier check. `forms.test-submission-required` is
// raised once per form and never passes or fails on its own: nothing reachable over HTTP proves
// that a submitted form arrives in a mailbox somebody reads, and pretending otherwise is the exact
// failure this whole tool exists to prevent.
//
// `forms.dev-endpoint` is the one check whose severity moves: posting enquiries to localhost from
// production is a blocker; doing it from a staging target is a high, since the markup still has to
// be fixed before it ships.

import { defineCheck } from '../registry.mjs'
import { DEV_HOSTS, PLACEHOLDER_IDS, scanText } from '../detect/placeholders.mjs'

const PHASE = 'launch-audit'
const DIMENSION = 'forms'
const TIER = 'http'
const EVIDENCE_LIMIT = 10

const url = (value) => ({ type: 'url', value })
const status = (value) => ({ type: 'status', value })
const html = (value) => ({ type: 'html', value })
const text = (value) => ({ type: 'text', value })
const metric = (value) => ({ type: 'metric', value })

const define = (def) => defineCheck({ phase: PHASE, dimension: DIMENSION, tier: TIER, ...def })
const emit = (check, overrides) => check.mk({ title: check.title, ...overrides })

const htmlPages = (ctx) => ctx.crawl.pages.filter((p) => p.page !== null && p.status >= 200 && p.status < 300)
const plural = (n, one, many) => (n === 1 ? one : many)

// Every form on the site, with the page it sits on and where on that page it is. `where` is what a
// finding prints, since html.mjs does not carry a form's id and "the second form" plus its action
// is enough to find it in a template.
function forms(ctx) {
  const out = []
  for (const entry of htmlPages(ctx)) {
    entry.page.forms.forEach((form, index) => {
      out.push({
        form,
        entry,
        index,
        where: entry.page.forms.length === 1
          ? 'the form on this page'
          : `form ${index + 1} of ${entry.page.forms.length} on this page`,
        action: form.action,
      })
    })
  }
  return out
}

const describeAction = (action) => (action === null ? 'no action attribute' : (action === '' ? 'an empty action' : action))

// The hosts that are this site. A production site can perfectly well live on a preview domain —
// `acme.vercel.app` is a real address a real business hands out — and a staging run is pointed at
// a staging host on purpose. Reporting every internal link, or the site's own form action, as a
// reference to a development host would make both of those audits unusable, so the audited host
// (with its apex and www counterparts, and the host of the url the audit was given) is exempt. A
// *different* host matching the same pattern is still reported.
function ownHosts(ctx) {
  const hosts = new Set()
  const add = (host) => { if (typeof host === 'string' && host !== '') hosts.add(host.toLowerCase()) }
  add(ctx.target.host)
  add(ctx.target.apex)
  if (ctx.target.hasWwwCounterpart) add(ctx.target.www)
  try {
    add(new URL(ctx.target.url).hostname)
  } catch {
    // target.url is the url the audit parsed to build the context; if it will not parse here there
    // is nothing to add and nothing to exempt.
  }
  return hosts
}

function hostOf(href) {
  try {
    return new URL(href).hostname.toLowerCase()
  } catch {
    return null
  }
}

// A form that posts nowhere. A missing action, an empty one and an action of "#" all reload the
// current url with the answers thrown away; a javascript: action does nothing at all without
// script. html.mjs keeps an empty action empty and resolves everything else against the page, so
// `action="#"` arrives as the page url with a trailing hash.
//
// Posting to the page's own url is *not* dead: that is how a server-rendered form has always
// worked, and `action="/contact"` on /contact is a working form, so an action that resolves to the
// page itself is passed over before the hash test can see it.
function deadReason(action, pageUrl) {
  if (action === null) return 'no action attribute'
  if (action.trim() === '') return 'action=""'
  if (action === pageUrl) return null
  if (action.endsWith('#')) return 'action="#"'
  if (/^javascript:/i.test(action)) return `action="${action}"`
  return null
}

// Every place a placeholder id can hide in a form: the endpoint it posts to, and the hidden fields
// an embed generator writes to carry its own form id.
function placeholderHits(form) {
  const hits = []
  if (form.action !== null) {
    for (const hit of scanText(form.action, PLACEHOLDER_IDS)) hits.push({ where: 'action', value: form.action, match: hit.match })
  }
  for (const input of form.inputs) {
    for (const field of ['name', 'value']) {
      const value = input[field]
      if (typeof value !== 'string' || value === '') continue
      for (const hit of scanText(value, PLACEHOLDER_IDS)) {
        hits.push({ where: `input ${field}`, value, match: hit.match })
      }
    }
  }
  return hits
}

// The embed urls a page declares that _ctx.mjs decided could be a form, paired with what it got
// back. Recomputing the "is this a form embed" question here would duplicate the context's rule;
// asking the probe map instead means the two can never disagree.
function embedsOn(ctx, entry) {
  const out = []
  const seen = new Set()
  const consider = (src, kind, title) => {
    if (typeof src !== 'string' || src === '' || seen.has(src)) return
    const response = ctx.probes.embeds.get(src)
    if (response === undefined) return
    seen.add(src)
    out.push({ src, kind, title, response })
  }
  for (const frame of entry.page.iframes) consider(frame.src, 'iframe', frame.title)
  for (const script of entry.page.scripts) consider(script.src, 'script', null)
  return out
}

export const inventory = define({
  id: 'forms.inventory',
  severity: 'info',
  title: 'A form on the site',
  catches: 'Nothing — this is the list of every form the audit found, so none of them is forgotten.',
  run(ctx) {
    return forms(ctx).map(({ form, entry, where }) => {
      const named = form.inputs.filter((input) => input.needsLabel)
      const required = form.inputs.filter((input) => input.required)
      return emit(inventory, {
        page: entry.url,
        detail: `${where} posts ${form.method.toUpperCase()} to ${describeAction(form.action)}, with ${named.length} ${plural(named.length, 'field', 'fields')} a visitor fills in${required.length > 0 ? ` (${required.length} required)` : ''}.`,
        evidence: [
          url(entry.url),
          html(`<form action="${describeAction(form.action)}" method="${form.method}">`),
          metric(`${form.inputs.length} controls, ${named.length} visitor-facing`),
          text(`spam protection: ${form.hasHoneypot ? 'honeypot' : ''}${form.hasHoneypot && form.hasCaptcha ? ' + ' : ''}${form.hasCaptcha ? 'captcha' : ''}${!form.hasHoneypot && !form.hasCaptcha ? 'none' : ''}`),
        ],
        fix: 'Nothing to fix. Check that this form is one you meant to ship.',
      })
    })
  },
})

export const deadAction = define({
  id: 'forms.dead-action',
  severity: 'high',
  title: 'A form posts nowhere',
  catches: 'A form with no action, an action of "#", or a javascript: action — every submission is lost.',
  run(ctx) {
    const out = []
    for (const { form, entry, where } of forms(ctx)) {
      const reason = deadReason(form.action, entry.finalUrl ?? entry.url)
      if (reason === null) continue
      out.push(emit(deadAction, {
        page: entry.url,
        detail: `${where} has ${reason}. Unless script intercepts the submit — and nothing here can prove it does — every enquiry typed into this form is discarded the moment somebody presses the button.`,
        evidence: [url(entry.url), html(`<form ${reason === 'no action attribute' ? '(no action)' : reason} method="${form.method}">`), text(reason)],
        fix: 'Point the form at the endpoint that receives it, and submit it once yourself to confirm the message arrives.',
      }))
    }
    return out
  },
})

export const devEndpoint = define({
  id: 'forms.dev-endpoint',
  severity: 'blocker',
  title: 'A form posts to a development host',
  catches: 'A form action still pointing at localhost, a preview deployment or the staging host.',
  run(ctx) {
    const staging = ctx.target.staging
    const extraHosts = ctx.target.devHosts
    const own = ownHosts(ctx)
    const out = []
    for (const { form, entry, where } of forms(ctx)) {
      if (form.action === null || form.action === '') continue
      const host = hostOf(form.action)
      if (host === null || own.has(host)) continue
      const hits = scanText(host, DEV_HOSTS, { extraHosts })
      if (hits.length === 0) continue
      out.push(emit(devEndpoint, {
        severity: staging ? 'high' : 'blocker',
        page: entry.url,
        title: staging ? 'A staging form posts to a development host' : 'A form posts to a development host',
        detail: staging
          ? `${where} posts to ${form.action}, a development host. Fix it before this markup reaches production, where every enquiry typed into it is lost.`
          : `${where} posts to ${form.action}. That host is reachable only from a developer's machine, so every enquiry a visitor types into this form fails to send.`,
        evidence: [url(entry.url), url(form.action), text(`matched ${hits[0].match}`)],
        fix: 'Point the action at the production endpoint, and submit the form once to confirm it arrives.',
      }))
    }
    return out
  },
})

export const placeholderId = define({
  id: 'forms.placeholder-id',
  severity: 'high',
  title: 'A form still carries a placeholder id',
  catches: 'A form endpoint or hidden field left as "your-form-id", "xxxx" or an example property id.',
  run(ctx) {
    const out = []
    for (const { form, entry, where } of forms(ctx)) {
      const hits = placeholderHits(form)
      if (hits.length === 0) continue
      out.push(emit(placeholderId, {
        page: entry.url,
        detail: `${where} carries a placeholder where an id should be (${hits[0].match}). It was copied from documentation and never filled in, so the form posts to nothing that exists.`,
        evidence: [url(entry.url), ...hits.slice(0, EVIDENCE_LIMIT).map((hit) => text(`${hit.where}: ${hit.value}`))],
        fix: 'Replace it with the real id from the form provider, and submit the form once to confirm it arrives.',
      }))
    }
    return out
  },
})

export const unlabelledInputs = define({
  id: 'forms.unlabelled-inputs',
  severity: 'medium',
  title: 'A form control has no label',
  catches: 'A field with no <label>, aria-label or aria-labelledby — unlabelled to a screen reader, and often to everyone once the placeholder disappears.',
  run(ctx) {
    const out = []
    for (const { form, entry, where } of forms(ctx)) {
      // `needsLabel` is already false for hidden fields, buttons and honeypots, so this list is
      // exactly the controls a visitor is expected to fill in without being told what they are.
      const hits = form.inputs.filter((input) => input.needsLabel && !input.labelled)
      if (hits.length === 0) continue
      out.push(emit(unlabelledInputs, {
        page: entry.url,
        detail: `${hits.length} ${plural(hits.length, 'control', 'controls')} in ${where} ${plural(hits.length, 'has', 'have')} no accessible name. A screen reader announces the field type and nothing else, and a placeholder does not count — it vanishes as soon as anyone types.`,
        evidence: [url(entry.url), ...hits.slice(0, EVIDENCE_LIMIT).map((input) => html(`<${input.type === 'textarea' || input.type === 'select' ? input.type : 'input'} name="${input.name ?? '(unnamed)'}" type="${input.type}"> — no label`))],
        fix: 'Give each control a <label for="…">, or an aria-label where a visible label does not fit.',
      }))
    }
    return out
  },
})

export const embedBroken = define({
  id: 'forms.embed-broken',
  severity: 'high',
  title: 'A form embed does not load',
  catches: 'An embedded form or booking widget whose script or iframe answers 404 — the form simply never appears.',
  run(ctx) {
    const out = []
    for (const entry of htmlPages(ctx)) {
      const hits = embedsOn(ctx, entry).filter(({ response }) => response.status !== 0 && response.status !== 200)
      if (hits.length === 0) continue
      out.push(emit(embedBroken, {
        page: entry.url,
        detail: `${hits.length} embedded ${plural(hits.length, 'form does', 'forms do')} not load: the ${hits[0].kind} at ${hits[0].src} answers ${hits[0].response.status}. Where the form should be, the visitor sees an empty space.`,
        evidence: [url(entry.url), ...hits.flatMap((hit) => [url(hit.src), status(hit.response.status)]).slice(0, EVIDENCE_LIMIT * 2)],
        fix: 'Re-copy the embed snippet from the form provider, and load the page to confirm the form renders.',
      }))
    }
    return out
  },
})

export const noSpamProtection = define({
  id: 'forms.no-spam-protection',
  severity: 'info',
  title: 'A form has no spam protection',
  catches: 'A public form with neither a honeypot nor a captcha, which bots will find within days of launch.',
  run(ctx) {
    const out = []
    for (const { form, entry, where } of forms(ctx)) {
      if (form.hasHoneypot || form.hasCaptcha) continue
      out.push(emit(noSpamProtection, {
        page: entry.url,
        detail: `${where} has neither a honeypot field nor a captcha. Automated submissions find public forms quickly, and the first sign is usually the inbox nobody wants to open any more.`,
        evidence: [url(entry.url), html(`<form action="${describeAction(form.action)}">`), text('no honeypot field, no captcha widget')],
        fix: 'Add a hidden honeypot field the form rejects when filled, or a captcha if the form attracts real abuse.',
      }))
    }
    return out
  },
})

export const testSubmissionRequired = define({
  id: 'forms.test-submission-required',
  severity: 'info',
  tier: 'human',
  title: 'Submit this form yourself before launch',
  catches: 'The one thing no HTTP request can prove: that a submitted form reaches a mailbox somebody reads.',
  run(ctx) {
    return forms(ctx).map(({ form, entry, where }) => emit(testSubmissionRequired, {
      page: entry.url,
      detail: `${where} posts ${form.method.toUpperCase()} to ${describeAction(form.action)}. Nothing reachable over HTTP proves that a submission arrives, that the notification is routed to an address someone monitors, or that it survives the spam filter. Send one real submission and confirm you receive it.`,
      evidence: [url(entry.url), html(`<form action="${describeAction(form.action)}" method="${form.method}">`), text('human verification: submit the form and confirm the notification arrives')],
      fix: 'Submit the form with a real message, confirm it lands in the monitored inbox, and check it is not in spam.',
    }))
  },
})

export const checks = [
  inventory,
  deadAction,
  devEndpoint,
  placeholderId,
  unlabelledInputs,
  embedBroken,
  noSpamProtection,
  testSubmissionRequired,
]
