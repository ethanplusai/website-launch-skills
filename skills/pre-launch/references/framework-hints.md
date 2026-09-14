# Framework hints

The `framework` group compares what the generator was **told to do** against what it **produced**.
Four checks, and every one of them skips rather than guesses. A hint derived from a mis-detected
framework is worse than no hint: it sends somebody looking for a sitemap integration nobody
configured, and it teaches them the group is noise.

---

## What the detector reads

It reads two things only — the dependency list in `package.json`, and a light regex pass over the
config file. It never installs or executes anything.

| Framework | Recognised by | Build dir guess | Site url read from | Sitemap signal | Sitemap file |
|---|---|---|---|---|---|
| Astro | `astro` dep, or `astro.config.*` | `dist` | `site: '…'` | `@astrojs/sitemap` in deps or config | `sitemap-index.xml` |
| Next | `next` dep, or `next.config.*` | `.next` | `siteUrl: '…'` (config, or `next-sitemap.config.js`) | `next-sitemap` dep | `sitemap.xml` |
| Nuxt | `nuxt` dep, or `nuxt.config.*` | `.output/public` | `siteUrl:` / `url: 'https://…'` | `@nuxtjs/sitemap`, `nuxt-simple-sitemap` | `sitemap.xml` |
| SvelteKit | `@sveltejs/kit` dep, or `svelte.config.*` | `build` | `siteUrl: '…'` | `svelte-sitemap`, `super-sitemap` | `sitemap.xml` |
| Eleventy | `@11ty/eleventy` dep, or `.eleventy.js` / `eleventy.config.*` | `_site` | `siteUrl:` / `site:` | not detected | `sitemap.xml` |
| Hugo | `hugo.toml`, `hugo.yaml` or `config.toml` | `public` | `baseURL = "…"` | built in (always true) | `sitemap.xml` |
| WordPress | `wp-config.php` | — | not detected | not detected | `wp-sitemap.xml` |
| Vite | `vite` dep, or `vite.config.*` | `dist` | not detected | not detected | `sitemap.xml` |

Trailing slash is read from `trailingSlash: 'always' | 'never' | 'ignore'`, or from
`trailingSlash: true | false` (Next), wherever the config declares it.

Astro, Nuxt and SvelteKit all bring Vite with them, so Vite is asked **last** and only ever answers
for a repository that is nothing but Vite.

**The limits, stated plainly.** A value the regex cannot see — a site url built from a variable, a
config spread across imported files, a value computed at build time — is reported as *not
detected*, and the check that would have used it skips with that reason. It is never reported as a
mismatch.

---

## The four checks

### `framework.site-url`
**Means.** The generator's configured site url is not `--production-url`.
**Why it matters.** Every absolute url in the output derives from it: canonicals, sitemap `<loc>`
entries, `og:url`, RSS links. A staging site url produces a build that tells search engines the
real site lives somewhere else.
**Fix.** Set the site url in the config to the production url and rebuild. Per framework, that is
`site` (Astro), `siteUrl` (next-sitemap, SvelteKit), `site.url` (Nuxt), `baseURL` (Hugo).
**Skips when.** No framework was detected, or the config declares no site url.

### `framework.sitemap-integration`
**Means.** A sitemap integration is configured, and the file it writes is not in the build.
**Why it matters.** A plugin that fails silently leaves the build with no sitemap at all, and the
usual cause is a missing or misconfigured site url — the integration needs one and skips without
it. Fixing `framework.site-url` often fixes this one too.
**Fix.** Confirm the integration is registered, confirm the site url is set, rebuild, and look for
the file. If the build writes a different filename than the table above, name it explicitly and
reference it from `robots.txt`.
**Skips when.** No framework was detected, or no sitemap integration is configured — a site with
no integration was never promised a file, and `output.sitemap` covers whether one exists.

### `framework.trailing-slash`
**Means.** The configured policy contradicts the form the generated links actually use, or a
redirect destination is written in the losing form.
**Why it matters.** `/about` and `/about/` are two urls. With a policy of `always` and links
written without the slash, every internal click takes a redirect hop — slower for visitors,
weaker for crawlers, and duplicated in analytics. A redirect destination in the wrong form can
turn the hop into a loop.
**Fix.** Pick one form. Set it in the generator config, regenerate so the links match, and write
every redirect destination in that form. Which one you pick matters much less than picking.
**Skips when.** No framework was detected, no policy is configured, the policy is `ignore`, or the
build contains no internal page links to compare against.

### `framework.redirect-targets`
**Means.** A redirect rule's destination resolves to no file in the build.
**Why it matters.** A rule pointing at a page that does not exist sends visitors and crawlers from
a working url to a 404, which is worse than leaving the old url alone.
**Fix.** Point each rule at a page that exists, or remove the rule and let the 404 page handle it
honestly.
**Skips when.** The repository has no redirect file.

A destination that is itself another rule's source is **not** reported here — that is a chain, and
`predecessor.redirect-chains` reports it as one. A destination carrying a capture (`:splat`, `$1`,
`:path`) is a template, not a path, and cannot be resolved without knowing what matched.

---

## Redirect files the gate parses

The first one found wins — a repository deploys to one host, and merging two rule sets would
invent a configuration that runs nowhere.

| File | Shape read |
|---|---|
| `vercel.json` | `redirects: [{ source, destination, permanent }]` |
| `netlify.toml` | `[[redirects]]` blocks with `from`, `to`, `status` |
| `_redirects` (root, `public/`, `static/`, `src/`) | `from  to  [status]`, one per line, `#` comments |
| `next.config.*` | literal `source:` / `destination:` pairs, with `permanent` |
| `.htaccess` (root, `public/`) | `Redirect [301] /from /to`, `RewriteRule ^pat$ /to [R=301]` |

A rule is a **wildcard** when its source contains `*`, `:`, `(` or `.*`. That is the field that
matters most: see `predecessor-redirects.md` for why a wildcard over content urls is a failure
rather than coverage.

`next.config.*` is JavaScript and may compute its redirects. The parser finds the literal pairs and
nothing else, which is the honest limit — a rule built in a loop is not in the parsed set, and the
checks report on what they parsed.

---

## An unrecognised stack

The whole group skips, with the reason in `Not covered`. That is the correct outcome, not a gap to
work around: the sixteen `output` checks read the build directly and do not care what produced it,
so an unrecognised generator loses four hints and keeps everything that reads the files. If the
build directory is not auto-detected either, name it with `--build-dir`.
