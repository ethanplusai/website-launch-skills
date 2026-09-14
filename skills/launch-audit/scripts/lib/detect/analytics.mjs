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

// Where the tools above actually send a hit.
//
// SIGNATURES answers "is this tool installed"; COLLECTOR_HOSTS answers "did it fire". The two
// belong together because the browser tier's whole analytics finding is the gap between them: a
// GA4 snippet in the markup with no request to google-analytics.com/g/collect is a tag that is
// installed and not working, and neither list alone can say that.
//
// Every entry names a url a *hit* is sent to, never a url a library is loaded from, and the
// difference is the whole point: `googletagmanager.com/gtag/js?id=G-1` is gtag.js downloading and
// proves nothing about measurement, while `googletagmanager.com/g/collect` is a GA4 event going
// out. Same for Hotjar — `static.hotjar.com/c/hotjar-1.js` is the script, `in.hotjar.com` is where
// the recording data goes. A library url in this list would make `browser.analytics-not-firing`
// unfireable on exactly the sites it exists for.
//
// Each entry is matched as a plain substring of the request url rather than as a host, because
// several of these are only a collector at one path, and Umami's endpoint is a path on the site's
// own host, which has no fixed hostname at all.
export const COLLECTOR_HOSTS = [
  'google-analytics.com/g/collect',
  'analytics.google.com',
  'googletagmanager.com/g/collect',
  'plausible.io/api/event',
  'api.usefathom.com',
  'posthog.com/e',
  '/api/collect',
  'matomo.php',
  'facebook.com/tr',
  'in.hotjar.com',
  'hotjar.com/api/v2/client',
  'clarity.ms/collect',
]

export const isCollectorUrl = (url) => typeof url === 'string' && COLLECTOR_HOSTS.some((needle) => url.includes(needle))

// The tools that set a cookie in the browser they run in. The cookieless ones (Plausible, Fathom,
// Umami) are here by their absence: a site running only those has nothing to ask consent for, so
// `browser.consent-missing` never fires on it.
export const COOKIE_SETTING_TOOLS = new Set(['GA4', 'GTM', 'PostHog', 'Matomo', 'Meta Pixel', 'Hotjar', 'Clarity'])
