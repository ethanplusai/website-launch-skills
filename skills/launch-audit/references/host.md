# Host & transport — is the site served correctly

This dimension is about everything between a visitor typing the address and the HTML arriving:
which protocol answers, which hostname is the real one, whether the certificate is trusted, what
the server says in its headers, and what happens when somebody asks for a page that does not
exist. None of it is visible in the design, all of it is visible to browsers and crawlers, and
most of it is configured once at launch and then never looked at again. Two findings here are
`blocker`-grade because they break the site outright for everyone: an invalid certificate and a
development hostname shipped to production.

---

## HTTPS and certificates

### `host.cert-invalid` — blocker
**Means.** The certificate is self-signed, expired, or issued for a different name.
**At launch.** Every visitor gets a full-page browser warning. There is no partial version of this
failure.
**Fix.** Reissue the certificate for the exact hostname being served and install the full chain.
*Static hosts:* certificates are automatic but only after the domain's DNS points at the host —
this finding on a managed host usually means DNS has not finished moving.
**Cannot say.** Whether the chain is complete for older clients; it validates from here.

### `host.cert-expiring` — high
**Means.** The certificate expires soon and nothing here shows a renewal.
**At launch.** A certificate that lapses two weeks after launch produces the same full-page
warning, at the point where everybody has stopped watching.
**Fix.** Confirm automatic renewal is running, and that the renewal hook reloads the server.
**Cannot say.** Whether renewal is configured — only what today's certificate says.

### `host.cert-missing-san` — high
**Means.** The certificate covers one of apex and www but the other is still reachable.
**At launch.** Whichever host is not covered throws a warning, and it is usually the one people
type.
**Fix.** Issue for both names, or stop serving the uncovered host entirely.
**Cannot say.** Whether the uncovered host is meant to be served.

### `host.http-not-redirected` — high
**Means.** Plain `http://` serves the site instead of redirecting to `https://`.
**At launch.** Every link, bookmark and typed address that omits the scheme goes out in the clear,
and search engines see two copies of the site.
**Fix.** Redirect all http traffic to the https url with a 301, at the server or the edge.
*Static hosts:* usually a toggle called "force HTTPS"; confirm it is on for the custom domain and
not only for the host's own subdomain.
**Cannot say.** Whether an http endpoint is required by something else (rare, and usually wrong).

### `host.http-redirect-not-301` — medium
**Means.** The http-to-https redirect is a 302 or another temporary status.
**At launch.** Temporary redirects do not consolidate ranking signals and are re-requested forever.
**Fix.** Make it a 301 (or 308 if the method must be preserved).
**Cannot say.** Whether the temporary status was deliberate during a migration.

### `host.hsts-missing` — medium
**Means.** No `Strict-Transport-Security` header.
**At launch.** The very first request to the domain still goes out over http before the redirect,
which is the request an attacker on the same network wants.
**Fix.** Add `Strict-Transport-Security: max-age=31536000; includeSubDomains` once you are certain
every subdomain can serve https.
**Cannot say.** Whether every subdomain is ready for `includeSubDomains` — check before adding it.

### `host.hsts-short` — low
**Means.** The `max-age` is under a year.
**At launch.** Short values are fine while testing and too short for a preload list.
**Fix.** Raise to `31536000` once the site has run on https without incident.
**Cannot say.** Whether the short value is a deliberate rollout step.

---

## One site, one hostname

### `host.www-apex-split` — high
**Means.** Both `www.example.com` and `example.com` serve the site, neither redirecting.
**At launch.** Links, shares and rankings split between two hosts that search engines treat as two
sites, and cookies set on one are invisible to the other.
**Fix.** Pick one as canonical and 301 the other to it, path and query preserved.
*Static hosts:* set the primary domain in the host's dashboard and add the other as a redirect —
adding both as primary domains is what produces this finding.
*WordPress:* Site Address and WordPress Address must both be the canonical host.
**Cannot say.** Which host you want. Pick the one already in use, and keep it forever.

### `host.www-apex-no-redirect` — medium
**Means.** The other host variant errors or times out instead of redirecting.
**At launch.** Anyone who types the other form gets nothing. It is a small audience and a bad
first impression.
**Fix.** Serve the other host and redirect it. A DNS record alone is not enough — the host needs a
certificate for the name too.
**Cannot say.** Whether the other variant is intentionally unregistered.

### `host.trailing-slash-both-200` — medium
**Means.** `/path` and `/path/` both return 200 with no redirect between them.
**At launch.** Two urls for one page, splitting links and often producing duplicate analytics rows.
**Fix.** Choose one form and redirect the other.
*Next / Nuxt / SvelteKit:* the trailing-slash option in the framework config.
*Hugo / Eleventy / Astro:* directory-style output implies a trailing slash; make the host agree.
*Static hosts:* there is usually a "trailing slash" or "pretty urls" setting that must match the
framework's choice — a mismatch here is the most common cause.
**Cannot say.** Which form the canonical tags use — see `indexability.canonical-*`.

### `host.mixed-content` — high
**Means.** A page served over https references a subresource — a script, a stylesheet, an image,
an iframe — over plain `http://`.
**At launch.** Browsers block active mixed content outright, so the script or stylesheet simply
never loads and the page is broken in a way that looks like a bug in the code. Passive mixed
content (an image) loads with a warning and strips the padlock, which visitors read as "this site
is not safe".
**Fix.** Rewrite the reference to `https://`, or to a protocol-relative path if the asset lives on
this site. Then find where the url came from — a hard-coded absolute url in a template, a CMS
field holding an old address, or a third-party embed whose snippet predates its own https support.
*WordPress:* content fields hold absolute urls from whenever they were pasted; a search-and-replace
across the database after the Site Address changes is the usual fix.
*Any framework:* a `<base>` or site-url value still set to `http` produces this on every page at
once.
**Cannot say.** Whether the asset is available over https at all. Some old third-party hosts are
not, and the honest answer there is to stop using them.

### `host.redirect-chain` — medium
**Means.** A url redirects more than once before landing.
**At launch.** Each hop is a round trip, and chains lose a little ranking signal at every step.
Typing the bare domain over http commonly costs three.
**Fix.** Collapse the rules so one redirect goes straight to the final https, canonical-host,
correct-slash url.
**Cannot say.** Which layer added each hop — read the chain in the evidence.

### `host.redirect-loop` — high
**Means.** A url redirects back to itself, directly or via a cycle.
**At launch.** The page never loads for anyone.
**Fix.** Two rules are fighting — commonly a host-level https redirect and an application-level
one, or a www rule on both sides.
**Cannot say.** Which rule to remove.

### `host.meta-refresh` — medium
**Means.** A page redirects with `<meta http-equiv="refresh">` instead of a server status.
**At launch.** Slower, worse for accessibility, and treated as a weak signal by search engines.
**Fix.** Replace with a 301 at the server or the edge.
**Cannot say.** Whether the refresh is a deliberate delay on a "thank you" page.

---

## Headers

### `host.security-header-missing` — medium
**Means.** One of the headers the OWASP Secure Headers project recommends is absent.
**At launch.** These are the cheapest security work on any site — a few lines of configuration
that close off clickjacking, content-type sniffing and referrer leakage.
**Fix.** Add them at the edge or in the host's headers configuration, not in each page.
*Static hosts:* a headers file or a dashboard section applies them to every response.
*WordPress:* a server-level rule beats a plugin, which cannot set headers for static assets.
Introduce a Content-Security-Policy in report-only mode first; a strict CSP added blind will break
an embed somewhere.
**Cannot say.** Whether your CSP is *correct* — only whether one is present.

### `host.security-header-coop-corp` — info
**Means.** The cross-origin isolation headers are not set.
**At launch.** Only matters if the site uses features that require isolation. Reported, not urged.
**Fix.** Leave alone unless you know you need it.
**Cannot say.** Whether the site needs isolation.

### `host.leaky-header-present` — low
**Means.** A response header names the software and often its version.
**At launch.** It tells an attacker which exploits to try first. Removing it is free.
**Fix.** Strip `Server`, `X-Powered-By` and similar at the edge.
**Cannot say.** Whether the version named is actually vulnerable.

### `host.no-compression` — medium
**Means.** HTML came back uncompressed.
**At launch.** HTML compresses by roughly 70%. This is the largest single-line performance win
available on most sites.
**Fix.** Enable gzip or brotli for text content types.
*Static hosts:* usually automatic — this finding there often means a proxy in front is stripping
the `Accept-Encoding` header.
**Cannot say.** Whether compression is applied to assets served from another origin.

### `host.no-cache-static` — low
**Means.** A fingerprinted static asset is served without a long cache lifetime.
**At launch.** Repeat visitors re-download files that can never change.
**Fix.** Serve hashed filenames with `Cache-Control: public, max-age=31536000, immutable`, and
keep HTML itself short-lived.
**Cannot say.** Whether the filename is genuinely fingerprinted.

### `host.http-version` — info
**Means.** Which protocol version the origin advertises.
**At launch.** Informational. HTTP/2 and HTTP/3 are usually a switch rather than a project.
**Fix.** Enable the newer protocol if the host offers it.
**Cannot say.** Whether the protocol is negotiated for every client.

---

## The 404 page, and what leaked

### `host.soft-404` — high
**Means.** A url that cannot exist answered 200.
**At launch.** Search engines index typos and dead links as real pages, monitoring never sees a
failure, and every broken link on the site looks like a working one.
**Fix.** Return a genuine 404 status with the friendly page as the body.
*Next / Nuxt / SvelteKit:* a catch-all route must set the status, not just render.
*Static hosts:* a SPA fallback rewriting everything to `index.html` with 200 is the classic cause —
configure the 404 page separately from the SPA fallback.
**Cannot say.** Whether the body looks like an error page to a person.

### `host.default-404-body` — medium
**Means.** The 404 page is the server's or framework's stock error page.
**At launch.** It looks broken and abandoned at exactly the moment a visitor needs help.
**Fix.** Design a 404 page with the site's header, a search box and links to the main sections.
**Cannot say.** Whether a custom page exists at a different path.

### `host.404-no-navigation` — low
**Means.** The 404 page has no links out.
**At launch.** A dead end. Visitors leave.
**Fix.** Include the site navigation and two or three likely destinations.
**Cannot say.** Whether the links are the right ones.

### `host.dev-host-leak` — blocker
**Means.** A page, asset, canonical, sitemap or robots file references `localhost`, a tunnel url,
or a staging hostname.
**At launch.** Whatever it points at is either unreachable for visitors or an internal system they
should never see. A leaked staging host can also get indexed as a duplicate of the whole site.
**Fix.** Replace with the production host and rebuild. Then search the repository for the string —
one leak usually means several.
*Any framework:* the cause is nearly always a base-url variable read from the wrong environment, or
a value hard-coded during development.
**Cannot say.** Every dev host — pass the ones you know with `--dev-host` so they are searched for
by name.

---

## What this dimension cannot tell you

- Whether the host is fast for real visitors. These are single requests from one location.
- Whether a header is correct, only whether it is present.
- Whether redirects behave the same for every path — the audit probes the roots and the crawled
  urls, and `--old-url` covers the cutover map.
- Anything about a CDN's behaviour at other edges, or about traffic that never reaches the origin.
