// Group 6 — predecessor coverage: will the domain move take its rankings with it?
//
// One idea underpins all three checks: **the old site's sitemap is the source of truth about what
// used to exist.** Not the old site's navigation, not somebody's memory of it, and not a crawl —
// a sitemap is what the old site told search engines it had, and those are the urls that have
// links pointing at them today.
//
// So the group fails closed. A child sitemap that will not fetch is not "fewer urls to check", it
// is an unknown number of urls nobody checked, and reporting coverage of the rest would be a lie
// the size of whatever that child contained.
//
// The other two checks are about the shape of the redirect map rather than its coverage:
//
// - A **wildcard** over content paths looks like coverage and is not. `/legacy/*` to `/` answers
//   every old article with the homepage, which search engines treat as a soft 404 and drop.
// - A **chain** costs a hop each time and loses a little authority at each one; a cycle serves
//   nothing at all.

import { defineCheck, SkipCheck } from '../../../launch-audit/scripts/lib/registry.mjs'
import { normalizePath, resolveInBuild } from './context.mjs'

const PHASE = 'pre-launch'
const DIMENSION = 'predecessor'
const check = (def) => defineCheck({ phase: PHASE, dimension: DIMENSION, tier: 'repo', severity: 'blocker', ...def })

const url = (value) => ({ type: 'url', value })
const text = (value) => ({ type: 'text', value })
const MAX_LISTED = 40

const NO_PREDECESSOR = 'no --predecessor-url was given, so there is no old site to compare against'

function requirePredecessor(ctx) {
  if (ctx.predecessor === null) throw new SkipCheck(NO_PREDECESSOR)
  return ctx.predecessor
}

const explicitSources = (ctx) => new Set(
  ctx.redirects.rules.filter((rule) => !rule.wildcard).map((rule) => normalizePath(rule.from)),
)

const coverage = check({
  id: 'predecessor.coverage',
  title: 'Old urls have nowhere to land',
  catches: 'pages from the site being replaced that will 404 after the cutover, taking their links and rankings with them',
  run(ctx) {
    const predecessor = requirePredecessor(ctx)

    // Fail closed. A sitemap that could not be read is an unknown number of unchecked urls, and
    // an unknown is not a pass.
    if (predecessor.errors.length > 0) {
      return [this.mk({
        title: 'The predecessor sitemap could not be read in full',
        detail: `${predecessor.errors.length} sitemap${predecessor.errors.length === 1 ? '' : 's'} could not be fetched or parsed, so an unknown number of old urls were never checked`,
        evidence: predecessor.errors.slice(0, MAX_LISTED).map(url),
        fix: 'Make the old sitemap reachable and run the gate again — this must happen while the old site is still up.',
      })]
    }
    if (predecessor.paths.length === 0) {
      return [this.mk({
        title: 'The predecessor sitemap listed no urls',
        detail: `${predecessor.url} served a sitemap with no urls on its own host, so nothing could be checked`,
        evidence: [url(`${predecessor.url} sitemap contained no same-host urls`)],
        fix: 'Point --predecessor-url at the host whose sitemap lists the old pages, and run the gate again.',
      })]
    }

    if (ctx.buildDir === null || ctx.buildDirNote !== null) {
      throw new SkipCheck(ctx.buildDirNote ?? 'there is no build output directory to check old urls against')
    }

    const redirected = explicitSources(ctx)
    const leftover = predecessor.paths.filter((path) => resolveInBuild(ctx, path) === null && !redirected.has(path))
    if (leftover.length === 0) return []
    return [this.mk({
      title: 'Old urls have nowhere to land',
      detail: `${leftover.length} of ${predecessor.paths.length} urls on ${predecessor.url} exist neither at the same path in the build nor as an explicit redirect`,
      evidence: leftover.slice(0, MAX_LISTED).map((path) => url(`${predecessor.origin}${path} has no destination`)),
      fix: 'For each one: publish the page at the same path, or add a one-hop 301 to the closest equivalent. A path with no equivalent may 410, but that is a decision somebody has to make.',
    })]
  },
})

// The literal prefix a wildcard rule matches on: everything before its first wildcard character.
// `/legacy/:path*` covers `/legacy/`; `/blog/*` covers `/blog/`; a bare `/*` covers everything.
function wildcardPrefix(from) {
  const cut = from.search(/[*:(]/)
  return cut === -1 ? from : from.slice(0, cut)
}

const wildcardRedirects = check({
  id: 'predecessor.wildcard-redirects',
  title: 'A wildcard redirect swallows old content urls',
  catches: 'a catch-all rule that answers every old article with one page, which search engines read as a soft 404',
  run(ctx) {
    const predecessor = requirePredecessor(ctx)
    const wildcards = ctx.redirects.rules.filter((rule) => rule.wildcard)
    if (wildcards.length === 0) return []

    const problems = []
    for (const rule of wildcards) {
      const prefix = wildcardPrefix(rule.from)
      const covered = predecessor.paths.filter((path) => path.startsWith(prefix) && path !== prefix)
      if (covered.length === 0) continue
      problems.push(`"${rule.from} -> ${rule.to}" covers ${covered.length} old content url${covered.length === 1 ? '' : 's'}: ${covered.slice(0, 5).join(', ')}${covered.length > 5 ? ', …' : ''}`)
    }
    if (problems.length === 0) return []
    return [this.mk({
      title: 'A wildcard redirect swallows old content urls',
      detail: `${problems.length} wildcard rule${problems.length === 1 ? '' : 's'} stand in for urls that need their own destinations`,
      evidence: problems.slice(0, MAX_LISTED).map(text),
      fix: 'Replace the wildcard with one explicit rule per old url, each pointing at the page that replaces it. Keep the wildcard only for paths with no content, if at all.',
    })]
  },
})

// Follows one rule's destination through the map, returning the hops after the first. A repeat
// visit is a cycle and stops the walk.
function chainFrom(start, byFrom) {
  const hops = []
  const seen = new Set([start])
  let current = byFrom.get(start)
  while (current !== undefined) {
    const next = normalizePath(current.to)
    hops.push(next)
    if (seen.has(next)) return { hops, cycle: true }
    seen.add(next)
    current = byFrom.get(next)
  }
  return { hops, cycle: false }
}

const redirectChains = check({
  id: 'predecessor.redirect-chains',
  title: 'A redirect chain or loop',
  catches: 'a redirect that lands on another redirect, costing a hop and some authority, or a loop that serves nothing',
  run(ctx) {
    requirePredecessor(ctx)
    const byFrom = new Map()
    for (const rule of ctx.redirects.rules) {
      if (rule.wildcard) continue
      const from = normalizePath(rule.from)
      if (!byFrom.has(from)) byFrom.set(from, rule)
    }
    const problems = []
    for (const from of byFrom.keys()) {
      const { hops, cycle } = chainFrom(from, byFrom)
      if (cycle) {
        problems.push(`${from} -> ${hops.join(' -> ')} is a loop and serves nothing`)
        continue
      }
      if (hops.length > 1) problems.push(`${from} -> ${hops.join(' -> ')} takes ${hops.length} hops`)
    }
    if (problems.length === 0) return []
    return [this.mk({
      title: 'A redirect chain or loop',
      detail: `${problems.length} rule${problems.length === 1 ? '' : 's'} do not reach their destination in one hop`,
      evidence: problems.slice(0, MAX_LISTED).map(text),
      fix: 'Flatten every chain so each source points straight at its final destination, and break any loop.',
    })]
  },
})

export const checks = [coverage, wildcardRedirects, redirectChains]
