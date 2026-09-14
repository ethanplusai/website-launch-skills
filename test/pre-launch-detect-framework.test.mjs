// The repo-side framework detector, and the redirect-file parsers that come with it.
//
// The detector is a guess made from two cheap signals — what package.json declares and what the
// config file says in a light regex read — and the point of these tests is that the guess is
// conservative: an unknown repository answers `null` rather than a plausible default, because a
// wrong framework hint sends the gate looking for a sitemap that was never promised.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectFramework, parseRedirects } from '../skills/launch-audit/scripts/lib/detect/framework.mjs'
import { PASSING, FAILING, outsideRepoDir } from './pre-launch-helpers.mjs'

function scratch(files) {
  const { dir, cleanup } = outsideRepoDir('framework')
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return { dir, cleanup }
}

test('astro: site, trailing slash and the sitemap integration come out of the config', () => {
  const found = detectFramework(PASSING, JSON.parse('{"dependencies":{"astro":"^4.16.0","@astrojs/sitemap":"^3.2.0"}}'))
  assert.equal(found.name, 'astro')
  assert.equal(found.siteUrl, 'https://passing.test')
  assert.equal(found.trailingSlash, 'never')
  assert.equal(found.sitemapIntegration, true)
  assert.equal(found.buildDirGuess, 'dist')
  assert.match(found.configPath, /astro\.config\.mjs$/)
})

test('astro: a staging site url is reported as written, not normalised away', () => {
  const found = detectFramework(FAILING, { dependencies: { astro: '^4' } })
  assert.equal(found.siteUrl, 'https://staging.example.com')
  assert.equal(found.trailingSlash, 'always')
})

test('next: build dir is .next and next-sitemap is the integration signal', () => {
  const { dir, cleanup } = scratch({ 'next.config.mjs': 'export default { trailingSlash: true }\n' })
  try {
    const found = detectFramework(dir, { dependencies: { next: '^15.0.0', 'next-sitemap': '^4' } })
    assert.equal(found.name, 'next')
    assert.equal(found.buildDirGuess, '.next')
    assert.equal(found.sitemapIntegration, true)
    assert.equal(found.trailingSlash, 'always')
  } finally { cleanup() }
})

test('hugo: baseURL out of hugo.toml, and the sitemap is built in', () => {
  const { dir, cleanup } = scratch({ 'hugo.toml': 'baseURL = "https://hugo.test/"\ntitle = "x"\n' })
  try {
    const found = detectFramework(dir, {})
    assert.equal(found.name, 'hugo')
    assert.equal(found.siteUrl, 'https://hugo.test/')
    assert.equal(found.sitemapIntegration, true)
    assert.equal(found.buildDirGuess, 'public')
  } finally { cleanup() }
})

test('eleventy, sveltekit, nuxt, vite and wordpress are each recognised', () => {
  const cases = [
    ['eleventy', { '.eleventy.js': 'module.exports = () => {}\n' }, {}, '_site'],
    ['sveltekit', { 'svelte.config.js': 'export default {}\n' }, { devDependencies: { '@sveltejs/kit': '^2' } }, 'build'],
    ['nuxt', { 'nuxt.config.ts': 'export default defineNuxtConfig({})\n' }, { dependencies: { nuxt: '^3' } }, '.output/public'],
    ['vite', { 'vite.config.js': 'export default {}\n' }, { devDependencies: { vite: '^5' } }, 'dist'],
    ['wordpress', { 'wp-config.php': '<?php define("DB_NAME", "x");\n' }, {}, null],
  ]
  for (const [name, files, pkg, buildDirGuess] of cases) {
    const { dir, cleanup } = scratch(files)
    try {
      const found = detectFramework(dir, pkg)
      assert.equal(found.name, name, `expected ${name}`)
      assert.equal(found.buildDirGuess, buildDirGuess, `${name} build dir`)
    } finally { cleanup() }
  }
})

test('an unrecognised repository answers null rather than guessing', () => {
  const { dir, cleanup } = scratch({ 'readme.md': 'hello\n' })
  try {
    const found = detectFramework(dir, {})
    assert.equal(found.name, null)
    assert.equal(found.siteUrl, null)
    assert.equal(found.sitemapIntegration, null)
    assert.equal(found.trailingSlash, null)
  } finally { cleanup() }
})

test('vercel.json redirects parse, and a :param source counts as a wildcard', () => {
  const { file, rules } = parseRedirects(FAILING)
  assert.match(file, /vercel\.json$/)
  assert.deepEqual(rules[0], { from: '/legacy/:path*', to: '/', status: 301, wildcard: true })
  assert.deepEqual(rules[2], { from: '/team', to: '/about', status: 301, wildcard: false })
})

test('netlify.toml, _redirects and .htaccess each parse into the same rule shape', () => {
  const netlify = scratch({ 'netlify.toml': '[[redirects]]\n  from = "/old"\n  to = "/new"\n  status = 301\n' })
  try {
    assert.deepEqual(parseRedirects(netlify.dir).rules, [{ from: '/old', to: '/new', status: 301, wildcard: false }])
  } finally { netlify.cleanup() }

  const plain = scratch({ '_redirects': '# a comment\n/blog/*  /articles/:splat  301\n/one /two\n' })
  try {
    assert.deepEqual(parseRedirects(plain.dir).rules, [
      { from: '/blog/*', to: '/articles/:splat', status: 301, wildcard: true },
      { from: '/one', to: '/two', status: 301, wildcard: false },
    ])
  } finally { plain.cleanup() }

  const apache = scratch({ '.htaccess': 'Redirect 301 /a /b\nRewriteRule ^shop/(.*)$ /store/$1 [R=301,L]\n' })
  try {
    assert.deepEqual(parseRedirects(apache.dir).rules, [
      { from: '/a', to: '/b', status: 301, wildcard: false },
      { from: '^shop/(.*)$', to: '/store/$1', status: 301, wildcard: true },
    ])
  } finally { apache.cleanup() }
})

test('next.config redirects are read out of the source by regex', () => {
  const { dir, cleanup } = scratch({
    'next.config.js': [
      'module.exports = {',
      '  async redirects() {',
      '    return [',
      '      { source: "/old", destination: "/new", permanent: true },',
      '      { source: "/tmp", destination: "/now", permanent: false },',
      '    ]',
      '  },',
      '}',
    ].join('\n'),
  })
  try {
    const { rules } = parseRedirects(dir)
    assert.deepEqual(rules, [
      { from: '/old', to: '/new', status: 301, wildcard: false },
      { from: '/tmp', to: '/now', status: 302, wildcard: false },
    ])
  } finally { cleanup() }
})

test('a repository with no redirect file answers with no file and no rules', () => {
  const { dir, cleanup } = scratch({ 'readme.md': 'x\n' })
  try {
    assert.deepEqual(parseRedirects(dir), { file: null, rules: [] })
  } finally { cleanup() }
})
