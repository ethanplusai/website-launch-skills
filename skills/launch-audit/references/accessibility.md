# Accessibility — who can use this site

Accessibility is the one dimension where a clean report is most likely to be wrong, and the file
says so up front. HTML alone can prove a handful of things: that a field has a name, that a link
announces something, that the page declares a language, that there is a `<main>` to skip to. It
cannot prove contrast, focus order as rendered, keyboard traps, or anything a script builds after
load. Those need a browser, and when one is available the audit runs axe-core against a sample of
pages. Even then, automated testing finds somewhere between a quarter and a half of real barriers.
The rest needs a keyboard and a screen reader.

So read this section as a floor, never as a pass. `a11y.browser-tier-required` exists to say that
out loud in every report where no browser ran.

---

## The HTML tier

### `a11y.form-labels` — high
**Means.** An input, select or textarea has no `<label>`, `aria-label` or `aria-labelledby`.
**At launch.** A screen reader announces the field as nothing at all — the user hears "edit text"
and has to guess. It is also the most common single accessibility failure on the web.
**Fix.** A `<label for="…">` bound to the control's id. If the design has no room for visible text,
use `aria-label`, but prefer a visible label: everyone benefits from one, and placeholders vanish
the moment typing starts.
*Any framework:* generate the id and the `for` from one value so they cannot drift.
**Cannot say.** Whether a label positioned nearby reads as a label visually. Proximity is not
programmatic association.

### `a11y.link-text-empty` — medium
**Means.** An anchor with no text, no image alt inside it, and no `aria-label`.
**At launch.** A screen reader can only read the url. Icon-only links — social icons, a logo, a
cart, a close button that is really a link — are almost always the cause.
**Fix.** Add an `aria-label` describing the destination, or alt text on the icon inside.
**Cannot say.** Whether sighted users understand the icon either. Often they do not.

### `a11y.main-landmark-missing` — medium
**Means.** No `<main>` and no `role="main"`.
**At launch.** Landmarks are how screen reader users jump past the navigation. Without one, the
skip link has nowhere to go and every page starts with the whole menu.
**Fix.** Wrap the page content in `<main>`. One per page.
**Cannot say.** Whether the other landmarks (`header`, `nav`, `footer`) are correctly placed.

### `a11y.iframe-title-missing` — medium
**Means.** An `<iframe>` with no `title`.
**At launch.** It is announced as "frame", which tells a user nothing about whether to enter it.
Maps, videos and embedded forms are the usual cases.
**Fix.** `title="Map of the workshop"`, `title="Booking form"`. Describe the content, not the
technology.
**Cannot say.** Whether the content inside the frame is itself accessible — that is the
provider's responsibility and yours to check.

### `a11y.heading-order` — low
**Means.** A heading jumps more than one level below the heading before it.
**At launch.** Screen reader users navigate by heading. A skipped level reads as a missing
section, and the usual cause is picking a level for its font size.
**Fix.** Choose levels by structure; set size in CSS.
**Cannot say.** Whether the structure itself is sensible.

### `a11y.tabindex-positive` — low
**Means.** `tabindex="1"` or higher.
**At launch.** Positive values pull an element in front of every other focusable thing on the page,
in a global order nobody maintains. The result is a tab sequence that jumps around the screen.
**Fix.** Use `tabindex="0"` to make something focusable, `-1` to make it programmatically
focusable, and never a positive number. Fix the DOM order instead.
**Cannot say.** What the resulting tab order actually feels like — tab through it yourself.

### `a11y.autofocus` — low
**Means.** An `autofocus` attribute.
**At launch.** Focus moves before the visitor has read anything; on a phone it also opens the
keyboard and scrolls the page. On a search page it is sometimes right, everywhere else it is not.
**Fix.** Remove it unless the page's entire purpose is that one field.
**Cannot say.** Whether the page is a search page.

### `a11y.image-alt-coverage` — info
**Means.** The share of images across the crawled pages that carry an `alt` attribute at all.
**At launch.** A single number that says how seriously the content model treats descriptions. Note
it counts presence, including `alt=""`, which is correct for decorative images.
**Fix.** Nothing directly — see `images.alt-missing` for the individual failures.
**Cannot say.** Whether any of the alt text is good.

### `a11y.browser-tier-required` — info
**Means.** No browser rendered the pages, so the axe scan did not run.
**At launch.** This is the honesty line for this dimension. Colour contrast, rendered focus order,
keyboard traps, ARIA that lies about state, and script-built content are all unchecked.
**Fix.** Re-run with the browser tier available, and test the main journeys by hand.
**Cannot say.** Anything about the unchecked categories — which is the point.

---

## The browser tier

### `browser.axe-violation` — severity follows axe's impact
**Means.** axe-core found a WCAG 2.2 A/AA violation on a rendered page. Critical and serious map
to `high`, moderate to `medium`, minor to `low`.
**At launch.** These are the findings the HTML tier structurally cannot make: contrast ratios,
computed roles and names, focus management, ARIA state as the page actually renders it.
**Fix.** Each violation carries a rule id and a help url — start there, and fix the rule rather
than the instance, since one component usually produces the same violation on every page.
The most common at launch, in order: colour contrast on muted body text and on buttons in a brand
colour; missing form labels in a component library's inputs; a missing document language; links
that rely on colour alone.
**Cannot say.** Roughly half of what matters. axe is a static analysis of a rendered tree — it
cannot follow a journey, operate a menu, or judge whether an error message is understandable.

---

## The manual pass — fifteen minutes, every launch

Do this on the two or three most important pages. It finds more than the automated tiers combined.

1. **Tab through the page from the address bar.** Every stop must be visible — if you lose the
   focus ring, that is a finding. The order must follow the visual order.
2. **Open and close the mobile menu with the keyboard alone.** Then a modal, if there is one.
   Focus must move into it, stay inside while it is open, and return to the trigger on close.
3. **Submit a form with an error.** The error must be announced, associated with its field, and
   focusable — not only red.
4. **Zoom the browser to 200%.** Nothing may be cut off, overlapped, or require horizontal
   scrolling to read.
5. **Turn the sound on and use a screen reader on the home page.** Listen to the first thirty
   seconds. You will hear the unlabelled things immediately.

---

## How to say this to a client

Accessibility findings land badly when they are presented as a compliance threat and well when
they are presented as reach. Two framings that work:

- *"Roughly one in five of your visitors has something that makes a site harder to use. These are
  the places where this site is harder than it needs to be."*
- *"Most of this is one component fixed once. The contrast change is a colour value; the labels
  are in one form component."*

And one thing to be honest about, every time: **an automated pass is not a compliance statement.**
If the client needs a conformance claim, they need an audit by a specialist against the full
standard, with assistive-technology testing. Say that plainly rather than letting a clean section
imply it.

---

## What this dimension cannot tell you

- Whether the site is *accessible*. It reports specific, provable failures and names the whole
  categories it never examined.
- Whether the content is understandable — reading level, jargon, instructions that assume sight.
- Whether assistive technologies actually work with the site. Only testing with them says that.
- Anything about pages the browser tier did not render. The sample is named in **Not covered**.
