// Which analytics tools a page installs, read from the page source.
//
// detectAnalytics(html) runs over the raw response body rather than extracted text, because every
// signature here lives in markup a reader never sees: a script src, a data- attribute, a call
// inside an inline script. Running it over `page.text` would find nothing on a correctly installed
// site.
//
// One entry per *occurrence*, not per tool. That is what lets `analytics.duplicate-install` see the
// same snippet pasted into both a layout and a page template, and it is why each entry carries the
// text it matched: a signature written as an alternation (Plausible matches either the script host
// or its `data-domain` attribute) hits twice on a single correct install, and a check that compared
// only tool names would call that a duplicate. Two entries whose `match` differs are two halves of
// one install; two entries whose `match` is identical are two installs.
//
// `id` is the first capture group of the signature when it has one (`idGroup` names a different
// group), and null for signatures that identify a tool without identifying the property — knowing
// Fathom is installed is useful even when the site id is not in the markup.

export const SIGNATURES = [
  { name: 'GA4', re: /gtag\(\s*['"]config['"]\s*,\s*['"](G-[A-Z0-9]+)/, idGroup: 1 },
  { name: 'GTM', re: /googletagmanager\.com\/gtm\.js\?id=(GTM-[A-Z0-9]+)/ },
  { name: 'Plausible', re: /plausible\.io\/js\/|data-domain=/ },
  { name: 'Fathom', re: /cdn\.usefathom\.com/ },
  { name: 'PostHog', re: /posthog\.(?:init|com)/ },
  { name: 'Umami', re: /data-website-id=/ },
  { name: 'Matomo', re: /matomo\.js|_paq\.push/ },
  { name: 'Meta Pixel', re: /fbq\(\s*['"]init['"]/ },
  { name: 'Hotjar', re: /static\.hotjar\.com/ },
  { name: 'Clarity', re: /clarity\.ms\/tag/ },
]

// A per-call global clone, so SIGNATURES stays a plain readable list and no `lastIndex` survives
// between two documents.
const global = (re) => new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)

export function detectAnalytics(html) {
  if (typeof html !== 'string' || html === '') return []
  const out = []
  for (const signature of SIGNATURES) {
    const re = global(signature.re)
    let found
    while ((found = re.exec(html)) !== null) {
      out.push({
        name: signature.name,
        id: found[signature.idGroup ?? 1] ?? null,
        match: found[0],
        index: found.index,
      })
      // A zero-length match would spin forever; no signature can produce one, but the guard costs
      // nothing and keeps that true if one is ever added.
      if (found[0] === '') re.lastIndex++
    }
  }
  return out
}
