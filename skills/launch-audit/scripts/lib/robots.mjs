// robots.txt parsing, group/rule matching, and the AI-crawler policy table.
//
// parseRobots(text) groups records the way real crawlers do: one or more consecutive
// `User-agent:` lines share a group; any other directive line — recognized or not — ends that
// run, so the next `User-agent:` starts a fresh group (RFC 9309). `Allow`/`Disallow` with an
// empty value carry no information and are dropped from the group's rules, though the line still
// closes the run of agents. `Crawl-delay` and unrecognized directives (e.g. `Host:`) are read only
// far enough to close that run; their values are never stored. `Sitemap:` is collected globally
// regardless of which group it falls in or near; only absolute URLs are collected, relative ones
// are reported in `errors` instead.
//
// isAllowed(robots, ua, path) picks the single most specific group for `ua` — the group whose
// agent token is the longest case-insensitive substring match of `ua`, falling back to a literal
// `*` group, falling back to allow when neither exists — then finds the longest Allow/Disallow
// pattern in that group that matches `path`. Ties go to Allow. No match at all is allow.

export const AI_CRAWLERS = [
  { ua: 'GPTBot', vendor: 'OpenAI', purpose: 'training' },
  { ua: 'ChatGPT-User', vendor: 'OpenAI', purpose: 'user' },
  { ua: 'OAI-SearchBot', vendor: 'OpenAI', purpose: 'search' },
  { ua: 'ClaudeBot', vendor: 'Anthropic', purpose: 'training' },
  { ua: 'Claude-User', vendor: 'Anthropic', purpose: 'user' },
  { ua: 'Claude-SearchBot', vendor: 'Anthropic', purpose: 'search' },
  { ua: 'PerplexityBot', vendor: 'Perplexity', purpose: 'search' },
  { ua: 'Perplexity-User', vendor: 'Perplexity', purpose: 'user' },
  { ua: 'Google-Extended', vendor: 'Google', purpose: 'training' },
  { ua: 'Applebot-Extended', vendor: 'Apple', purpose: 'training' },
  { ua: 'CCBot', vendor: 'Common Crawl', purpose: 'training' },
  { ua: 'Bytespider', vendor: 'ByteDance', purpose: 'training' },
]

const ASSET_CANDIDATES = [
  '/a.css', '/a.js', '/assets/a.png', '/static/a.js', '/_next/static/a.js',
  '/_astro/a.css', '/images/a.png', '/img/a.png', '/wp-content/a.css', '/wp-includes/a.js',
]

function isAbsoluteUrl(value) {
  return /^https?:\/\//i.test(value)
}

export function parseRobots(text) {
  const groups = []
  const sitemaps = []
  const errors = []
  let current = null
  let groupOpen = false // true while we're still inside a run of consecutive User-agent lines

  for (const raw of String(text).split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const sep = line.indexOf(':')
    if (sep === -1) continue
    const name = line.slice(0, sep).trim().toLowerCase()
    const value = line.slice(sep + 1).trim()

    if (name === 'user-agent') {
      if (!value) continue
      if (!current || !groupOpen) {
        current = { agents: [], allow: [], disallow: [] }
        groups.push(current)
      }
      current.agents.push(value)
      groupOpen = true
      continue
    }

    // Per RFC 9309, any non-User-agent record line ends a run of consecutive User-agent
    // lines — whether or not we act on that line's content.
    groupOpen = false

    if (name === 'allow' || name === 'disallow') {
      if (!value || !current) continue
      current[name].push(value)
    } else if (name === 'sitemap') {
      if (isAbsoluteUrl(value)) sitemaps.push(value)
      else errors.push(`relative sitemap url ignored: ${value}`)
    }
    // Crawl-delay and unrecognized directives are read only to close the group above; their
    // values are never stored.
  }

  return { groups, sitemaps, errors }
}

function patternToRegex(pattern) {
  const anchored = pattern.endsWith('$')
  const body = anchored ? pattern.slice(0, -1) : pattern
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`)
}

function chooseGroup(robots, ua) {
  const uaLower = String(ua).toLowerCase()
  let best = null
  let bestLen = -1
  let starGroup = null
  for (const group of robots.groups) {
    for (const token of group.agents) {
      if (token === '*') {
        if (!starGroup) starGroup = group
        continue
      }
      if (uaLower.includes(token.toLowerCase()) && token.length > bestLen) {
        bestLen = token.length
        best = group
      }
    }
  }
  return best || starGroup || null
}

export function isAllowed(robots, ua, path) {
  const group = chooseGroup(robots, ua)
  if (!group) return true

  const matches = []
  for (const value of group.allow) {
    if (patternToRegex(value).test(path)) matches.push({ type: 'allow', len: value.length })
  }
  for (const value of group.disallow) {
    if (patternToRegex(value).test(path)) matches.push({ type: 'disallow', len: value.length })
  }
  if (matches.length === 0) return true

  const maxLen = Math.max(...matches.map((m) => m.len))
  return matches.some((m) => m.len === maxLen && m.type === 'allow')
}

export function aiPolicy(robots) {
  return AI_CRAWLERS.map((c) => ({ ...c, allowed: isAllowed(robots, c.ua, '/') }))
}

export function blocksAssets(robots, ua = '*') {
  return ASSET_CANDIDATES.filter((path) => !isAllowed(robots, ua, path))
}
