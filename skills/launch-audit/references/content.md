# Content sanity — the things a reader would notice

Everything in this dimension is something a person would spot in thirty seconds and a build
pipeline never will: lorem ipsum on the services page, a copyright year from the last rebuild, an
offer that expired in August, two different phone numbers on two different pages. None of it
breaks anything. All of it makes a site look unfinished or, worse, abandoned — and the phone
number one costs real enquiries.

These checks are deliberately conservative. They report what is demonstrably inconsistent or
demonstrably stale, and they hand the judgement calls — is this copy any good, is this the right
address — to a person, with the evidence collected in one place.

---

## Placeholders and staleness

### `content.placeholder-text` — high
**Means.** Lorem ipsum, "coming soon", a `TODO`, an unrendered `{{ template }}` or an `[INSERT]`
left in visible copy.
**At launch.** The clearest possible signal that a page shipped unfinished, and it is usually on
the page nobody re-read because it "was done weeks ago".
**Fix.** Write the copy, or remove the section. A page that says "coming soon" should usually not
be linked from the navigation at all.
*Any CMS:* an unrendered `{{ }}` or `${ }` in the output means a template variable reached the
content layer — check the field name, not the copy.
**Cannot say.** Whether placeholder-*looking* text is deliberate. Read the evidence before acting.

### `content.copyright-year-stale` — low
**Means.** The footer year is behind the current one.
**At launch.** The cheapest possible signal that a site is abandoned, and it is on every page.
**Fix.** Render the year at request time, or from the build date, rather than typing it.
*Static sites:* the build stamps the year, so a site that has not rebuilt since December will go
stale in January — schedule a periodic rebuild or render the year client-side.
**Cannot say.** Whether the year is a deliberate "established" date.

### `content.past-dated-promo` — medium
**Means.** A date in promotional copy has already passed — "Ends Aug 31" still on the page in
September.
**At launch.** The site is still making an offer it can no longer honour, which is a customer
service problem before it is a marketing one.
**Fix.** Remove the promotion, or give it an end date the CMS enforces.
**Cannot say.** Whether the date refers to an offer at all — it might be an event write-up.

### `content.broken-entity` — low
**Means.** An HTML entity is visible in the rendered text — the reader sees `&amp;` or `&nbsp;`.
**At launch.** Text was escaped twice, usually between a CMS field and a template that escapes
again.
**Fix.** Escape once, at output. Find the layer doing it twice rather than fixing the string.
**Cannot say.** Whether the entity is inside a code sample where it belongs.

---

## Contact details — the ones that cost money

### `content.phone-variants` — medium
**Means.** The site publishes more than one phone number.
**At launch.** Nearly always an old number left on one page after a change. Half the calls go to a
number nobody answers, and nobody finds out, because the people who called are gone.
**Fix.** Pick one number. Put it in one place in the content model — a site setting, a data file,
a config value — and reference it from every template. Then check:
- the header and the footer,
- every contact and location page,
- the `tel:` hrefs (see `links.tel-invalid`),
- the JSON-LD `telephone` property,
- images of the number, which nothing here can read.
**Cannot say.** Which number is correct, or whether two numbers are deliberate (a sales line and a
support line often are). Ask.

### `content.email-variants` — info
**Means.** Several contact addresses across the site.
**At launch.** At least one of them is usually a mailbox nobody monitors — commonly an address
from a previous provider, or a personal address used during the build.
**Fix.** Publish one address per purpose, and confirm each one has a person behind it.
**Cannot say.** Which addresses are monitored.

### `content.address-variants` — info
**Means.** More than one postal address.
**At launch.** A second address left after a move reads to search engines as two businesses, which
splits local ranking signals between them.
**Fix.** One address, formatted identically everywhere, matching the business listing exactly.
**Cannot say.** Whether the business genuinely has two locations.

### `content.mixed-spelling` — info
**Means.** American and British spellings of the same word across the site.
**At launch.** Two writers who never agreed. Harmless, visible, and trivially fixable while
somebody is already editing.
**Fix.** Pick one, and note it wherever the content guidelines live.
**Cannot say.** Which variant the audience expects.

---

## The judgment pass: contact details, in one sweep

`content.phone-variants`, `content.email-variants`, `content.address-variants` and
`links.tel-invalid` are four views of one question: **can somebody actually reach this business?**
Answer it once, as a single pass, rather than four times as separate findings.

1. Collect every phone number, address and email in the report's evidence into one list.
2. Ask the site's owner which are current. Do not guess — a disconnected number and a second
   office look identical from outside.
3. Check each `tel:` href dials the number shown next to it. A formatted display number with a
   stale href is common and invisible.
4. Check the structured data agrees with the page (`head.jsonld-*`), and that the business listing
   agrees with both.
5. Confirm the email addresses reach a monitored inbox — this overlaps with the form test in
   `forms.md`, and both should be done in the same sitting.

---

## The judgment pass: does the copy read as finished

The checks above find mechanical staleness. Three things remain that only a reader can judge, and
the report cannot even hint at them:

- **Boilerplate titles and descriptions.** `head.title-duplicate` catches identical ones; it
  cannot catch forty distinct titles that all read "Services | Company Name".
- **Copy that describes a different business.** Text carried over from a template or a previous
  client survives surprisingly often, and it always reads plausibly.
- **Sections nobody finished.** A testimonial with no name, a team page with one placeholder
  portrait, a case study that stops mid-sentence.

Read the home page, one service page and the contact page end to end. That is usually enough.

---

## How the text is read

These checks run over the visible text of each crawled page — the text content after markup is
stripped, with script and style contents removed — so they see what a reader sees and nothing
else. Two consequences:

- **Text inside an image is invisible.** A phone number in a header graphic, an address in a map
  screenshot, a promotional date baked into a banner: none of it is checked here, and all of it
  goes stale. Check images by eye against the screenshots.
- **Text a script writes after load may be missed.** A page whose copy is fetched client-side has
  very little visible text in its HTML. The browser tier's renders cover the sampled pages; the
  rest are named in **Not covered**.

The variant checks (phone, email, address, spelling) are **site-wide**: they compare what the
whole crawl found, which is why a second phone number on one forgotten page is visible here and
invisible on any single page.

---

## What this dimension cannot tell you

- Whether the copy is any good, accurate, or legally required.
- Whether text inside an image is stale — nothing here reads pixels.
- Whether a page matches a signed-off document. Copy versus source is one of the two things named
  as **never checked** in every report.
- Whether the pages that exist are the pages that were agreed. Pages versus scope is the other.
