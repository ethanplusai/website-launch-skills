# Forms — the part of a launch that fails silently

A broken form is the most expensive launch bug there is, because nothing tells you. The page
looks right, the button submits, the visitor sees a thank-you message, and the enquiry goes
nowhere. Nobody complains — the people who would complain are the ones whose message never
arrived. So this dimension inventories every form on the site and checks the things HTTP can
check, and then hands you two jobs no request can do: classifying each form, and submitting one.

**The audit never submits a form.** Not once, not with test data, not to a staging endpoint. Every
finding below comes from the markup and from fetching the embed's own assets.

---

## The inventory

### `forms.inventory` — info
**Means.** One entry per form found: where it is, what it posts to, how many fields a visitor
fills in, how many are required, and what spam protection it carries.
**At launch.** Read this list first and count it against what you expect. A missing form is
invisible to every other check here — the audit cannot report a contact form that was never built.
**Fix.** Nothing. Confirm each form is one you meant to ship, and that none is missing.
**Cannot say.** Whether a form built entirely by JavaScript after load appears at all. The browser
tier's renders catch some of these; the rest need a human to open the page.

---

## Endpoints

### `forms.dev-endpoint` — blocker
**Means.** The form's action points at `localhost`, a tunnel url, a preview deployment or staging.
**At launch.** Every submission goes to a machine that visitors cannot reach, or into a system
that is about to be torn down. Nothing errors visibly.
**Fix.** Point the action at the production endpoint and redeploy. Then check the other forms.
**Cannot say.** Every development host — pass the ones you know with `--dev-host`.

### `forms.dead-action` — high
**Means.** No `action`, an action of `#`, or a `javascript:` action.
**At launch.** Without JavaScript the form posts to the page itself and the data is lost. With
JavaScript it depends entirely on a handler the audit cannot see.
**Fix.** Give the form a real endpoint, and keep the JavaScript as an enhancement over it.
*Static hosts:* a form-handling attribute or a function endpoint is the usual answer; confirm the
attribute is actually present in the built HTML, not only in the source.
**Cannot say.** Whether a script intercepts the submit and posts somewhere valid. This is one of
the findings you confirm by classification, below.

### `forms.placeholder-id` — high
**Means.** An endpoint or hidden field still reads `your-form-id`, `xxxx`, or an example property
id copied from documentation.
**At launch.** The submission is accepted by nothing, or accepted into somebody else's account.
**Fix.** Replace with the real id from the form provider's dashboard.
**Cannot say.** Whether a real-looking id belongs to the right account.

### `forms.embed-broken` — high
**Means.** An embedded form or booking widget's script or iframe answers 404.
**At launch.** The form never appears on the page at all — there is simply a gap where it should
be, which is easy to miss on a long page.
**Fix.** Re-copy the embed code from the provider. Embeds break when an account is renamed or a
widget is deleted.
**Cannot say.** Whether an embed that loads actually works — see `browser.embed-console-error`.

---

## Fields and abuse

### `forms.unlabelled-inputs` — medium
**Means.** A control with no `<label>`, `aria-label` or `aria-labelledby`.
**At launch.** A screen reader announces the field as nothing. For everyone else the placeholder
disappears the moment they start typing, so a half-filled form loses its own labels.
**Fix.** A real `<label>` tied to the input's id. Placeholders are not labels.
**Cannot say.** Whether a visually adjacent text node reads as a label to a sighted user.

### `forms.no-spam-protection` — info
**Means.** A public form with neither a honeypot field nor a captcha.
**At launch.** Bots find new forms within days. The first sign is usually the client asking why
they are getting twenty enquiries a day in a foreign language.
**Fix.** A honeypot costs one hidden field and catches most of it. Add a captcha only if that is
not enough — it costs every real visitor something.
**Cannot say.** Whether the provider does spam filtering server-side, which many do.

### `forms.test-submission-required` — info (human)
**Means.** The one thing no HTTP request can prove: that a submitted form reaches a mailbox
somebody reads.
**At launch.** Do this before launch, not after. It is the single highest-value ten minutes in the
whole process.
**Fix.** Submit each form with real-looking data. Confirm: the success message appears; the
notification arrives; it arrives in the **inbox**, not the spam folder; the reply-to address is
the visitor's, not the site's; and any CRM or spreadsheet row was created.
**Cannot say.** Anything. This finding exists to make sure a person does it.

---

## Embeds at runtime (browser tier)

### `browser.embed-console-error` — high
**Means.** A third-party form, booking widget or payment embed loaded, and then threw JavaScript
errors on the page.
**At launch.** This is the failure mode that quietly loses every enquiry a site receives: the
widget's script arrives, so nothing 404s, and then it fails to initialise — a wrong account id, a
content-security-policy that blocks its second request, a cookie banner that blocks it entirely.
The form either never renders or renders and never submits.
**Fix.** Read the error text in the evidence. A CSP violation names the directive that blocked it;
an authentication error names the account. Re-copy the embed code if neither is obvious.
**Cannot say.** Whether the widget works for a visitor who accepts cookies — the audit never
clicks a consent banner.

### `browser.failed-requests` — medium (see also `performance.md`)
**Means.** Requests the page made that did not load, including ones built by script.
**At launch.** On a page with a form, look for the embed's own requests here first: a widget
failing to fetch its configuration is invisible in the markup and obvious in this list.
**Fix.** Depends on the request. Read the url.
**Cannot say.** Whether a failed request mattered to the page.

---

## The judgment pass: classify every form

For each entry in `forms.inventory`, decide which of three it is. The audit gives you the
evidence; the classification is yours, and it changes what "broken" means.

**First-party.** The form posts to this site's own origin or a function endpoint it owns.
- Check the action resolves to a route that exists (`links.internal-broken` covers this).
- The submission handler is server code the audit cannot see. A test submission is the only proof.

**Third-party.** The form posts to, or is embedded from, a form, booking or marketing provider.
- The endpoint returning 200 proves the provider is up, not that the account is configured.
- Check the account id in the action or the embed is the client's and not one from documentation.
- A test submission must be confirmed **in the provider's dashboard as well as in the inbox** —
  a notification email that never sends leaves the data sitting in a dashboard nobody opens.

**Dead.** The form posts nowhere real: no action, a `#`, a placeholder id, or an embed that 404s.
- Treat as a launch blocker regardless of the severity printed, if it is a contact form. A site
  whose only enquiry route is broken is not launched.

Then ask the two questions that decide whether the form is *finished*:

1. **Where does a submission go, and who reads that?** Name a person, not an address.
2. **What does the visitor see afterwards?** A thank-you page you can link to is better than an
   inline message: it is what conversion tracking fires on.

---

## After the site is live

Two of these come back. Re-check them the day of the cutover, because both depend on DNS:

- **Notification delivery.** Mail from a domain whose SPF, DKIM or DMARC records changed during
  the move starts landing in spam folders, and the form itself is unchanged. See
  `ops.email-auth`.
- **Third-party allow-lists.** Some form providers restrict submissions to named domains. A form
  tested on staging can start rejecting submissions the moment the production hostname is the one
  posting.

---

## What this dimension cannot tell you

- Whether a submission arrives. Nothing here submits anything.
- Whether server-side validation, rate limiting or storage work.
- Whether the notification email is routed to a monitored inbox — that is an ops item.
- Whether a form rendered entirely by script exists at all on pages the browser tier did not
  render. The rendered sample is named in **Not covered**.
