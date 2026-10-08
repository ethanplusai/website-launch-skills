// The unfinished-site detectors: text nobody meant to ship, ids nobody replaced, links nobody
// finished, hosts only the developer can reach, and credentials nobody meant to publish.
//
// Five pattern lists and one scanner, deliberately separated from the checks that use them, so the
// same list drives the launch-audit content and forms dimensions and the pre-launch gate without
// either one re-deriving it. Every pattern is proved by a planted string in test/detect.test.mjs:
// the proof table has one entry per pattern and fails if a pattern is added without one, which is
// what keeps a silently-broken regex from reading as a clean site.
//
// Three conventions matter to callers:
//
// - These are matchers, not validators. `scanText` reports what it saw and where; deciding whether
//   a `TODO` in a code sample is a defect is the check's job, not this module's.
// - Each list says what it may be read against. PLACEHOLDER_TEXT is for words a reader sees, so a
//   check runs it over rendered text. PLACEHOLDER_URLS is for the attribute that carries a url, so
//   a check has to run it over raw markup: in rendered text there is nothing for it to match.
// - `extraHosts` (the operator's own `--dev-host` list) is escaped and anchored to host segments
//   before it joins DEV_HOSTS, so `dev` never matches `devices.example.test` and a host containing
//   regex punctuation is matched literally rather than as a pattern.

export const PLACEHOLDER_TEXT = [
  /lorem ipsum/i,
  /\byour text here\b/i,
  /\bcoming soon\b/i,
  /\[INSERT[^\]]*\]/i,
  /\{\{\s*[\w.]+\s*\}\}/,
  /\bTODO\b/,
  /\bFIXME\b/,
  /REPLACE[_ ]ME/i,
  // A token a template ships with, so the one file that needs a real value cannot be missed:
  // REPLACE_WITH_FORM_ID, REPLACE_WITH_THIS_SITES_BUCKET_URL. Upper case only, because that is how a
  // token is written and `replace_with_care()` is code.
  /REPLACE_WITH_[A-Z0-9_]+/,
  // The sample blog post a starter ships so its blog routes render, "Sample Post — Delete Me". Title
  // case on purpose: "delete me" in lower case is ordinary English (a privacy page says it), and a
  // gate that blocks a launch over a sentence like that is a gate people learn to ignore.
  /\bSample Posts?\b/,
  /\bDelete Me\b/,
]

export const PLACEHOLDER_IDS = [
  /G-XXXXXXX+/i,
  /G-PLACEHOLDER/i,
  /UA-\d+-\d+/,
  /formspree\.io\/f\/(your-form-id|xxxx+|REPLACE)/i,
  /GTM-XXXX+/i,
]

// A url that is a placeholder only as the value of an `href` or `src`: a link or an asset that points
// at the documentation host, so the visitor lands on a page that has nothing to do with the site.
// The same host is ordinary everywhere else somebody writes it for a reader. `placeholder="you@example.com"`
// is the hint on nearly every contact form, and an address written out in a paragraph is an example
// someone chose, so a pattern that matched the bare host would block every launch that has a form.
// This list therefore only works over raw markup. The host has to be a whole host name, which is why
// `my-example.com`, `notexample.com`, `example.community` and `example.com.au` are not hits. The match
// runs to the end of the value, so the evidence reads as the attribute and not as half of one.
export const PLACEHOLDER_URLS = [
  /\b(?:href|src)\s*=\s*["']?\s*[^"'\s>]*(?<![A-Za-z0-9-])example\.com(?![A-Za-z0-9-]|\.[A-Za-z0-9])[^"'\s>]*/i,
]

export const DEV_HOSTS = [
  /\blocalhost\b/,
  /127\.0\.0\.1/,
  /\.vercel\.app\b/,
  /\.netlify\.app\b/,
  /\.pages\.dev\b/,
  /\bstaging\./,
  /\bdev\./,
  /\.local\b/,
]

export const SECRETS = [
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{36}/,
  /AKIA[0-9A-Z]{16}/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]

const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// An operator-supplied host, as a pattern that only matches a whole host segment: `old.internal`
// matches `build.old.internal` and not `old.internals.test`, and `dev` matches `dev.example.test`
// and not `devices.example.test`. A host written with a trailing dot (`dev.`) is already anchored
// on its right by that dot, so no trailing assertion is added — one would forbid the very thing it
// is meant to match.
export function hostPattern(host) {
  const literal = escapeRe(String(host).trim())
  if (literal === '') return null
  const tail = literal.endsWith('\\.') ? '' : '(?![A-Za-z0-9-])'
  return new RegExp(`(?<![A-Za-z0-9-])${literal}${tail}`, 'i')
}

// Every pattern that matches, in pattern order, with the text it matched and where. One entry per
// pattern: a second `TODO` further down the page is the same defect, and the evidence a check
// prints is the pattern and the first thing it caught.
export function scanText(text, patterns, { extraHosts = [] } = {}) {
  if (typeof text !== 'string' || text === '') return []
  const all = [...patterns]
  for (const host of extraHosts) {
    const pattern = hostPattern(host)
    if (pattern !== null) all.push(pattern)
  }
  const out = []
  for (const pattern of all) {
    const found = pattern.exec(text)
    if (found === null) continue
    out.push({ pattern, match: found[0], index: found.index })
  }
  return out
}
