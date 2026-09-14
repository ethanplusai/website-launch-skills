# The human checklist

Nine items. No script can verify any of them, which is why they are here rather than in the gate.

**The order is a dependency order and must not be changed.** Two of the dependencies are one-way
doors — a step you cannot go back and take later:

- The **Search Console baseline** must be exported *before* DNS moves. Once the domain points at
  the new host, the old property stops collecting, and the twelve months of query data that would
  have told you whether the migration worked are gone for good.
- The **forms** must reach a person *before* the deploy that makes them public. Every submission
  that arrives while a form points nowhere is a customer nobody can call back, and nobody finds out
  until they wonder why the enquiries stopped.

Work one item at a time. Ask, get an actual answer, then record it:

    node scripts/pre-launch.mjs --dir <repo> --confirm <id>

Never confirm an item on somebody's behalf, and never confirm one because it is probably fine.
`--progress` prints the list with ✓ and ☐ so a session that stops halfway can resume.

---

## 1. `forms` — Every form reaches a person

**Why.** A contact form is usually the only way a stranger can become a customer, and a broken one
fails silently in both directions: the visitor sees a success message, and nobody receives
anything. It is the single most common launch-day failure, and the most expensive.

**How to verify.** For each form: submit it yourself against the production endpoint. Then have
the person who will actually answer it confirm out loud that the message arrived. Check the
success message the visitor sees, any autoresponder, and that the record landed wherever it is
meant to — CRM, spreadsheet, ticket queue.

**Done looks like.** A named human says "yes, I got it, in the inbox I read". Not a spam folder.
Not a shared address nobody opens. Not "the endpoint returned 200".

---

## 2. `analytics` — Analytics is live and recording the right property

**Why.** Analytics that starts a week late has no before. Every question anybody asks after launch
— did traffic recover, is the new page converting, where did the enquiries go — needs data from
day one, and it cannot be backfilled.

**How to verify.** Confirm the measurement id in the build belongs to the production property, not
a test one. Load the live site and watch the real-time report register your visit. Define at least
one conversion event that matters — a form submission, a purchase, a call click — and fire it once
to see it arrive. Confirm the tag does not run on staging or on localhost.

**Done looks like.** Your own visit visible in real time, one conversion event recorded, and the
property named to whoever will read the reports.

---

## 3. `hosting` — The hosting project is connected and configured

**Why.** The environment variables that work locally are not on the host until somebody enters
them there, and a build that works on your machine proves nothing about the one the host runs.

**How to verify.** Confirm the hosting project is connected to the right repository and branch.
Confirm every production environment variable is entered in the hosting project, not only in a
local `.env`. Deploy the exact commit you are launching as a preview and open it.

**Done looks like.** A preview deploy of the launch commit, rendering correctly, and at least two
people with access to the hosting account.

---

## 4. `payments` — Payments are in live mode end to end

*Only asked when the repository depends on a payment SDK.*

**Why.** Test keys and live keys are different keys, and so are test webhooks. A checkout that
works perfectly in test mode and takes no money in production looks identical from the outside.

**How to verify.** Switch to live keys and confirm they are the ones in the production
environment. Confirm the products, prices and currencies are the agreed ones. Register the webhook
against the production url and confirm the provider shows a successful delivery. Then make one
real payment.

**Done looks like.** A real payment taken, visible in the provider dashboard and in your own
records, then refunded.

---

## 5. `legal` — Legal pages and contact details are correct

**Why.** Privacy and cookie obligations attach to what the site actually does, including its
analytics and its form processor. And a wrong phone number on one page sends half the calls
nowhere, which nothing can detect from outside.

**How to verify.** Confirm the privacy policy, terms, and any consent banner required where the
audience lives are present, linked from every page, and describe the real data flows. Check the
company name, registration details, postal address, phone number and email against the real ones.
Check every `tel:` link dials the number printed beside it.

**Done looks like.** The site owner confirms each detail is current, and the legal pages name the
actual processors.

---

## 6. `gsc-baseline` — The Search Console baseline is exported, before DNS moves

*Only asked when `--predecessor-url` was given.*

**Why.** This is the one-way door. After the cutover the old property stops collecting, and
without this export there is no way to tell whether the migration cost traffic or the season did.

**How to verify.** Verify the old site in Search Console if it is not already. Export twelve
months of performance data — queries, pages, clicks, impressions, average position — and the Pages
coverage report. Save both somewhere the whole team can reach.

**Done looks like.** Two files, dated, saved, and the link shared. Do it now, not on cutover day.

---

## 7. `dns` — The DNS cutover plan is written down

**Why.** A DNS mistake propagates at the speed of the TTL you set *before* you made it. A 24-hour
TTL turns a five-minute error into a day-long outage.

**How to verify.** Capture every current record for the apex and www — type, value, TTL — and save
the export. Lower the TTL to five minutes at least 24 hours before the cutover. Write down who
holds the registrar login, the exact records that will change, and the time window. Confirm the
old host stays up and serving through propagation.

**Done looks like.** A written plan naming records, values, times and the person with the login,
and a TTL already lowered.

---

## 8. `signoff` — Stakeholder sign-off on copy and imagery, in writing

**Why.** Nothing in this repository compares the words on the site against the words that were
approved, and nothing knows which pages were supposed to exist. A site can pass every mechanical
check and still be missing half of what was agreed.

**How to verify.** Get the person who owns the content to say, in writing, that the copy and the
images on the live pages are the approved ones. Confirm the page list against what was agreed, and
name anything that was dropped.

**Done looks like.** A message, an email or a signed document — something with a date on it.

---

## 9. `rollback` — The rollback plan is named

**Why.** The plan is only worth anything if it exists before it is needed. At the moment you need
it, nobody is in a state to invent one.

**How to verify.** Write down, in one paragraph: which DNS records revert to what values, which
deploy rolls back to which commit, who is allowed to make that call, and how long it takes to take
effect. Confirm the old site can still serve during that window.

**Done looks like.** One paragraph, written down, that somebody other than you could follow.
