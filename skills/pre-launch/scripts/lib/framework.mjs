// Group 5 — framework hints: what the generator was told to do, against what it produced.
//
// These four are the only checks in the gate that depend on recognising a stack, and every one of
// them skips rather than guesses. A hint derived from a mis-detected framework is worse than no
// hint: it sends somebody looking for a sitemap integration nobody configured, and it teaches them
// that this group is noise.
//
// What each one is really asking:
//
//   site-url            does the generator know which host it is building for?
//   sitemap-integration did the integration that promised a sitemap actually write one?
//   trailing-slash      do the config, the generated links and the redirect rules agree?
//   redirect-targets    does every redirect land on something that exists?

import { defineCheck, SkipCheck } from '../../../launch-audit/scripts/lib/registry.mjs'
import { normalizePath, resolveInBuild } from './context.mjs'

const PHASE = 'pre-launch'
const DIMENSION = 'framework'
const check = (def) => defineCheck({ phase: PHASE, dimension: DIMENSION, tier: 'repo', severity: 'blocker', ...def })

const text = (value) => ({ type: 'text', value })
const file = (value) => ({ type: 'file', value })
const MAX_LISTED = 20

const NO_FRAMEWORK = 'no framework was detected in this repository, so there is no generator configuration to compare against'

function requireFramework(ctx) {
  if (ctx.framework.name === null) throw new SkipCheck(NO_FRAMEWORK)
}

const configLabel = (ctx) => {
  const path = ctx.framework.configPath
  return path === null ? `${ctx.framework.name} (no config file)` : path.slice(ctx.dir.length + 1)
}

// Two site urls are the same url when they differ only by a trailing slash or by case in the host,
// which is the difference between how a person types one and how a config file stores it.
const sameUrl = (a, b) => {
  try {
    const left = new URL(a)
    const right = new URL(b)
    return left.protocol === right.protocol
      && left.hostname.toLowerCase() === right.hostname.toLowerCase()
      && left.port === right.port
      && normalizePath(left.pathname) === normalizePath(right.pathname)
  } catch {
    return false
  }
}

const siteUrl = check({
  id: 'framework.site-url',
  title: 'The configured site url is not the production url',
  catches: 'a generator building absolute urls — canonicals, sitemap entries, social cards — for the wrong host',
  run(ctx) {
    requireFramework(ctx)
    if (ctx.framework.siteUrl === null) {
      throw new SkipCheck(`${configLabel(ctx)} declares no site url, so there is nothing to compare with --production-url`)
    }
    if (sameUrl(ctx.framework.siteUrl, ctx.prodUrl)) return []
    return [this.mk({
      title: 'The configured site url is not the production url',
      detail: `${configLabel(ctx)} builds for ${ctx.framework.siteUrl}; the gate was told production is ${ctx.prodUrl}`,
      evidence: [text(`config site url: ${ctx.framework.siteUrl}`), text(`--production-url: ${ctx.prodUrl}`)],
      fix: 'Set the site url in the generator config to the production url, and rebuild. Every absolute url in the output derives from it.',
    })]
  },
})

const sitemapIntegration = check({
  id: 'framework.sitemap-integration',
  title: 'The sitemap integration produced no sitemap',
  catches: 'a configured sitemap plugin that silently wrote nothing, so the build ships without one',
  run(ctx) {
    requireFramework(ctx)
    if (ctx.framework.sitemapIntegration !== true) {
      throw new SkipCheck(`no sitemap integration is configured for ${ctx.framework.name}, so none promised a file`)
    }
    if (ctx.buildDir === null || ctx.buildDirNote !== null) {
      throw new SkipCheck(ctx.buildDirNote ?? 'there is no build output directory to look in')
    }
    const promised = ctx.framework.sitemapFile
    if (ctx.fileSet.has(promised)) return []
    return [this.mk({
      title: 'The sitemap integration produced no sitemap',
      detail: `${ctx.framework.name} is configured with a sitemap integration, which writes ${promised}, and ${ctx.buildDirName} does not contain it`,
      evidence: [file(`${ctx.buildDirName}/${promised} is missing`)],
      fix: 'Check the integration is registered and that the build completed, then rebuild and look for the file again.',
    })]
  },
})

const INTERNAL_LINK = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi

// The trailing-slash form the generated links actually use, ignoring the root (which has no form
// to choose) and anything with a file extension (an asset is not a page).
function linkForms(ctx) {
  let withSlash = 0
  let withoutSlash = 0
  for (const { raw } of ctx.html.values()) {
    for (const found of raw.matchAll(INTERNAL_LINK)) {
      const href = (found[1] ?? found[2] ?? found[3] ?? '').trim()
      if (!href.startsWith('/') || href.startsWith('//')) continue
      const path = href.split(/[?#]/)[0]
      if (path === '/' || /\.[a-z0-9]{2,5}$/i.test(path)) continue
      if (path.endsWith('/')) withSlash++
      else withoutSlash++
    }
  }
  return { withSlash, withoutSlash }
}

const trailingSlash = check({
  id: 'framework.trailing-slash',
  title: 'The trailing-slash policy contradicts the generated links',
  catches: 'a config that says one thing and links that say another, so every internal link takes a redirect hop',
  run(ctx) {
    requireFramework(ctx)
    const policy = ctx.framework.trailingSlash
    if (policy === null) throw new SkipCheck(`${configLabel(ctx)} declares no trailing-slash policy, so there is nothing to contradict`)
    if (policy === 'ignore') throw new SkipCheck('the configured trailing-slash policy is "ignore", which permits both forms')
    if (ctx.buildDir === null || ctx.buildDirNote !== null) {
      throw new SkipCheck(ctx.buildDirNote ?? 'there is no build output directory to read links from')
    }

    const { withSlash, withoutSlash } = linkForms(ctx)
    const total = withSlash + withoutSlash
    if (total === 0) throw new SkipCheck('the build contains no internal page links to compare the policy against')

    const majority = withSlash > withoutSlash ? 'always' : 'never'
    const problems = []
    if (majority !== policy) {
      problems.push(`the config says ${policy}, and ${majority === 'always' ? withSlash : withoutSlash} of ${total} internal links use the ${majority} form`)
    }
    // Redirect rules are the third voice in this argument, and the one that turns a mismatch into
    // a loop: a rule whose destination is in the losing form sends every request round again.
    for (const rule of ctx.redirects.rules) {
      if (rule.wildcard || !rule.to.startsWith('/') || rule.to === '/') continue
      const form = rule.to.endsWith('/') ? 'always' : 'never'
      if (form !== policy) problems.push(`the redirect ${rule.from} -> ${rule.to} uses the ${form} form against a ${policy} policy`)
    }
    if (problems.length === 0) return []
    return [this.mk({
      title: 'The trailing-slash policy contradicts the generated links',
      detail: problems.join('; '),
      evidence: problems.slice(0, MAX_LISTED).map(text),
      fix: 'Pick one form, set it in the generator config, regenerate the links, and write every redirect destination in that form.',
    })]
  },
})

// A destination that carries a capture (`:splat`, `$1`, `:path`) is a template, not a path, and
// cannot be resolved against the build without knowing what matched.
const TEMPLATED = /[:$]\w|\$\d/

const redirectTargets = check({
  id: 'framework.redirect-targets',
  title: 'A redirect destination resolves to nothing',
  catches: 'a redirect rule that sends visitors and crawlers to a page the build does not contain',
  run(ctx) {
    if (ctx.redirects.file === null) throw new SkipCheck('this repository has no redirect file to parse')
    if (ctx.buildDir === null || ctx.buildDirNote !== null) {
      throw new SkipCheck(ctx.buildDirNote ?? 'there is no build output directory to resolve destinations against')
    }
    const sources = new Set(ctx.redirects.rules.map((rule) => normalizePath(rule.from)))
    const broken = []
    // A templated destination cannot be resolved without knowing what its capture matched, so it
    // is not checked — and a check that quietly drops rules is a check that reports coverage it
    // does not have.
    let templated = 0
    for (const rule of ctx.redirects.rules) {
      if (!rule.to.startsWith('/')) continue
      if (TEMPLATED.test(rule.to)) { templated++; continue }
      const destination = normalizePath(rule.to)
      // A destination that is itself another rule's source is handled by that rule, and reported
      // as a chain by `predecessor.redirect-chains` rather than as a broken target here.
      if (sources.has(destination)) continue
      if (resolveInBuild(ctx, destination) !== null) continue
      broken.push(`${rule.from} -> ${rule.to} resolves to no file in the build`)
    }
    const notCovered = templated > 0
      ? [`framework.redirect-targets: ${templated} templated destinations not verified`]
      : []
    if (broken.length === 0) return { findings: [], notCovered }
    const label = ctx.redirects.file.slice(ctx.dir.length + 1)
    return {
      notCovered,
      findings: [this.mk({
        title: 'A redirect destination resolves to nothing',
        detail: `${broken.length} rule${broken.length === 1 ? '' : 's'} in ${label} point at pages the build does not contain`,
        evidence: broken.slice(0, MAX_LISTED).map(text),
        fix: 'Point each rule at a page that exists, or remove the rule and let the 404 page handle it honestly.',
      })],
    }
  },
})

export const checks = [siteUrl, sitemapIntegration, trailingSlash, redirectTargets]
