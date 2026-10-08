// Placeholders and leaks: the strings that mean the site is not finished, and the ones that mean
// it was built for somebody else's machine.
//
// The patterns themselves live in the shared detector (`detect/placeholders.mjs`) and are proved
// one by one in `detect.test.mjs`. What is under test here is the surface: which files the gate
// looks at, whether a hit in source and a hit in the build are both caught, and the one check
// whose severity a flag is allowed to raise.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { checks } from '../skills/pre-launch/scripts/lib/placeholders.mjs'
import { PASSING, FAILING, STARTER, STARTER_URL, copyFixture } from './pre-launch-helpers.mjs'
import { ctxFor, group, assertStatus } from './pre-launch-check-helpers.mjs'

const IDS = ['placeholders.analytics-id', 'placeholders.form-id', 'placeholders.copy', 'placeholders.required-env', 'placeholders.dev-host', 'placeholders.source-maps']

test('a finished site trips none of them', async () => {
  const map = await group(checks, await ctxFor(PASSING))
  for (const id of IDS) {
    const found = map.get(id)
    assert.ok(found !== undefined, `${id} did not run`)
    assert.notEqual(found.status, 'fail', `${id} failed on the passing fixture — ${found.detail}`)
  }
})

test('a placeholder analytics id fails with the file it was found in', async () => {
  const map = await group(checks, await ctxFor(FAILING))
  const found = assertStatus(map, 'placeholders.analytics-id', 'fail', assert)
  assert.ok(found.evidence.some((e) => /G-XXXXXXXXXX/.test(e.value)), JSON.stringify(found.evidence))
})

test('a placeholder form id fails', async () => {
  const map = await group(checks, await ctxFor(FAILING))
  const found = assertStatus(map, 'placeholders.form-id', 'fail', assert)
  assert.ok(found.evidence.some((e) => /your-form-id/.test(e.value)))
})

test('placeholder copy is caught in source and in the rendered text of the build', async () => {
  const map = await group(checks, await ctxFor(FAILING))
  const found = assertStatus(map, 'placeholders.copy', 'fail', assert)
  const values = found.evidence.map((e) => e.value).join(' | ')
  assert.match(values, /REPLACE_ME/)
  assert.match(values, /[Ll]orem ipsum/)
})

// The starter's own placeholders. Every one of them shipped once, because no pattern named it:
// the tokens in site.ts and the contact form, the sample blog post, and the documentation host in a
// canonical and an image. Evidence lines read `path:line — match`.
const evidenceOf = (found) => found.evidence.map((e) => e.value)

test('a site left exactly as the starter ships it fails placeholders.copy, and names each placeholder', async () => {
  const map = await group(checks, await ctxFor(STARTER, { productionUrl: STARTER_URL }))
  const found = assertStatus(map, 'placeholders.copy', 'fail', assert)
  const lines = evidenceOf(found)
  const has = (pattern) => lines.some((line) => pattern.test(line))

  // The template tokens, one per file: the first of a pattern in a file is the one that is reported.
  assert.ok(has(/^src\/lib\/site\.ts:\d+ — REPLACE_WITH_THIS_SITES_BUCKET_URL$/), lines.join('\n'))
  assert.ok(has(/^src\/components\/SiteForm\.astro:\d+ — REPLACE_WITH_FORM_ID$/), lines.join('\n'))
  // The sample post, in the data it ships, in the page it renders, and in the build output.
  assert.ok(has(/^src\/data\/blog\.json:\d+ — Sample Post$/), lines.join('\n'))
  assert.ok(has(/^src\/data\/blog\.json:\d+ — Delete Me$/), lines.join('\n'))
  assert.ok(has(/^src\/data\/blog-pages\/post-sample-post\.html:\d+ — Sample Post$/), lines.join('\n'))
  assert.ok(has(/^dist\/blog\/index\.html:\d+ — Sample Post$/), lines.join('\n'))
  assert.ok(has(/^dist\/blog\/sample-post\/index\.html:\d+ — Delete Me$/), lines.join('\n'))
})

test('a link or an image on example.com is caught in the source and in the build output', async () => {
  const map = await group(checks, await ctxFor(STARTER, { productionUrl: STARTER_URL }))
  const lines = evidenceOf(assertStatus(map, 'placeholders.copy', 'fail', assert))
  // The image the sample post ships, in source and as built. Its host is a bucket; the placeholder
  // is the example.com key prefix inside the url.
  assert.ok(lines.some((l) => /^src\/data\/blog-pages\/post-sample-post\.html:\d+ — src="https:\/\/pub-[0-9a-f]+\.r2\.dev\/example\.com\//.test(l)), lines.join('\n'))
  // A canonical left on the documentation host exists only in the build output.
  assert.ok(lines.some((l) => /^dist\/blog\/sample-post\/index\.html:\d+ — href="https:\/\/example\.com\/blog\/sample-post\/$/.test(l)), lines.join('\n'))
})

test('example.com as a form hint, or as a sentence, is not a placeholder', async () => {
  const map = await group(checks, await ctxFor(STARTER, { productionUrl: STARTER_URL }))
  const lines = evidenceOf(assertStatus(map, 'placeholders.copy', 'fail', assert))
  // The contact page and its source carry `placeholder="you@example.com"` and a url hint, and are
  // otherwise finished, so nothing in them is named.
  assert.ok(!lines.some((l) => /contact/.test(l)), lines.join('\n'))
  assert.ok(!lines.some((l) => /^dist\/index\.html/.test(l)), lines.join('\n'))
})

test('placeholders.copy passes on a finished site that has a contact form with example.com hints', async () => {
  const { dir, cleanup } = copyFixture(PASSING, 'form-hints')
  try {
    const hint = '<label>Email <input type="email" name="reply" placeholder="you@example.com"></label>\n'
    const page = (body) => `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Quote request</title></head><body><main>${body}</main></body></html>\n`
    for (const rel of ['src/quote.html', 'dist/quote.html']) writeFileSync(join(dir, rel), page(hint))
    const map = await group(checks, await ctxFor(dir))
    assertStatus(map, 'placeholders.copy', 'pass', assert)
  } finally { cleanup() }
})

// What finishing a starter site means: the one per-site file, src/lib/site.ts, is filled; the sample
// post is deleted; nothing else is edited. In particular not the form component, which is the
// starter's code and not the site's. An earlier version of this test rewrote the component's fallback
// as well, which hid that a correctly configured starter still carried a REPLACE_WITH_ literal.
function finishStarter(dir) {
  const swap = (rel, edit) => writeFileSync(join(dir, rel), edit(readFileSync(join(dir, rel), 'utf8')))
  swap('src/lib/site.ts', (t) => t
    .replace('REPLACE_WITH_THIS_SITES_BUCKET_URL', 'https://pub-1.r2.dev')
    .replace('REPLACE_WITH_FORM_ID', 'f_7c2e91a4'))
  // The build output a rebuild would write.
  swap('dist/contact/index.html', (t) => t.replace('REPLACE_WITH_FORM_ID', 'f_7c2e91a4'))
  for (const rel of ['src/data/blog.json', 'src/data/blog-pages/post-sample-post.html', 'dist/blog/index.html', 'dist/blog/sample-post/index.html']) {
    rmSync(join(dir, rel))
  }
}

// The form component as the starter ships it today, with a literal stand-in as the last fallback.
// The fix is for the component to stop carrying one: no fallback, and a build that stops when the
// form has no id. Its guard compares against the prefix REPLACE_, which is not itself a token.
const STOCK_FALLBACK = "const resolvedFormId = formId || site.forms[form] || 'REPLACE_WITH_FORM_ID';"
const THROWING = [
  'const resolvedFormId = formId || site.forms[form];',
  "if (!resolvedFormId || resolvedFormId.startsWith('REPLACE_')) {",
  '  throw new Error(`[forms] No form id for "${form}". Fill in site.forms.${form} in src/lib/site.ts.`);',
  '}',
].join('\n')

const FORM_COMPONENT = 'src/components/SiteForm.astro'
const useThrowingForm = (dir) => {
  const file = join(dir, FORM_COMPONENT)
  const source = readFileSync(file, 'utf8')
  assert.ok(source.includes(STOCK_FALLBACK), 'the fixture should carry the starter\'s stock fallback line, so the swap means something')
  writeFileSync(file, source.replace(STOCK_FALLBACK, THROWING))
}

test('a filled site.ts is not enough while the form component keeps its stock REPLACE_WITH_ fallback', async () => {
  const { dir, cleanup } = copyFixture(STARTER, 'starter-stock-fallback')
  try {
    finishStarter(dir)
    const found = assertStatus(await group(checks, await ctxFor(dir, { productionUrl: STARTER_URL })), 'placeholders.copy', 'fail', assert)
    // The one thing left to name is the fallback itself. That is why the starter throws instead of keeping it:
    // a literal in the component would fail every correctly configured site.
    const lines = evidenceOf(found)
    assert.equal(lines.length, 1, lines.join('\n'))
    assert.match(lines[0], /^src\/components\/SiteForm\.astro:\d+ — REPLACE_WITH_FORM_ID$/)
  } finally { cleanup() }
})

test('a filled site.ts and a form component that throws instead of falling back pass placeholders.copy', async () => {
  const { dir, cleanup } = copyFixture(STARTER, 'starter-throwing-form')
  try {
    finishStarter(dir)
    useThrowingForm(dir)
    assertStatus(await group(checks, await ctxFor(dir, { productionUrl: STARTER_URL })), 'placeholders.copy', 'pass', assert)
  } finally { cleanup() }
})

test('a form component that throws does not hide a site.ts that is still unfilled', async () => {
  const { dir, cleanup } = copyFixture(STARTER, 'starter-throwing-unfilled')
  try {
    useThrowingForm(dir)
    const found = assertStatus(await group(checks, await ctxFor(dir, { productionUrl: STARTER_URL })), 'placeholders.copy', 'fail', assert)
    const lines = evidenceOf(found)
    assert.ok(lines.some((l) => /^src\/lib\/site\.ts:\d+ — REPLACE_WITH_THIS_SITES_BUCKET_URL$/.test(l)), lines.join('\n'))
    assert.ok(!lines.some((l) => l.startsWith(FORM_COMPONENT)), lines.join('\n'))
  } finally { cleanup() }
})

test('a required env var that is defined nowhere fails; one in .env.production passes', async () => {
  const missing = await group(checks, await ctxFor(FAILING, { requiredEnv: ['PUBLIC_API_BASE'] }))
  const found = assertStatus(missing, 'placeholders.required-env', 'fail', assert)
  assert.match(found.detail, /PUBLIC_API_BASE/)

  const { dir, cleanup } = copyFixture(FAILING, 'required-env')
  try {
    writeFileSync(join(dir, '.env.production'), 'PUBLIC_API_BASE=https://api.failing.test\n')
    const present = await group(checks, await ctxFor(dir, { requiredEnv: ['PUBLIC_API_BASE'], productionUrl: 'https://failing.test' }))
    assertStatus(present, 'placeholders.required-env', 'pass', assert)
  } finally { cleanup() }
})

test('with no --required-env names the check skips rather than passing', async () => {
  const map = await group(checks, await ctxFor(PASSING))
  const found = assertStatus(map, 'placeholders.required-env', 'skip', assert)
  assert.match(found.detail, /--required-env/)
})

test('a dev host in the build output fails, and the production host itself never counts', async () => {
  const map = await group(checks, await ctxFor(FAILING))
  const found = assertStatus(map, 'placeholders.dev-host', 'fail', assert)
  assert.ok(found.evidence.some((e) => /localhost/.test(e.value)))

  const own = await group(checks, await ctxFor(PASSING, { devHosts: ['passing.test'] }))
  assertStatus(own, 'placeholders.dev-host', 'pass', assert)
})

test('an operator-named dev host is searched for too', async () => {
  const map = await group(checks, await ctxFor(FAILING, { devHosts: ['other.example'] }))
  const found = assertStatus(map, 'placeholders.dev-host', 'fail', assert)
  assert.ok(found.evidence.some((e) => /other\.example/.test(e.value)), JSON.stringify(found.evidence))
})

test('source maps are advisory by default and a blocker under --strict', async () => {
  const lenient = await group(checks, await ctxFor(FAILING))
  const advisory = assertStatus(lenient, 'placeholders.source-maps', 'advisory', assert)
  assert.equal(advisory.severity, 'low')

  const strict = await group(checks, await ctxFor(FAILING, { strict: true }))
  const blocking = assertStatus(strict, 'placeholders.source-maps', 'fail', assert)
  assert.equal(blocking.severity, 'blocker')
  assert.ok(blocking.evidence.some((e) => /sourceMappingURL/.test(e.value)))
})

test('the source directories that were scanned are declared by name', async () => {
  const map = await group(checks, await ctxFor(PASSING))
  for (const id of ['placeholders.analytics-id', 'placeholders.form-id', 'placeholders.copy']) {
    assert.deepEqual(map.get(id).notCovered, ['placeholders: source scan limited to src'], id)
  }
  // The checks that do not read source declare no such bound.
  assert.deepEqual(map.get('placeholders.dev-host').notCovered, [])
})

test('a repository with no recognised source directory says so rather than implying a full scan', async () => {
  const { dir, cleanup } = copyFixture(PASSING, 'no-source-dir')
  try {
    const { renameSync } = await import('node:fs')
    const { join } = await import('node:path')
    renameSync(join(dir, 'src'), join(dir, 'assembled-by-hand'))
    const map = await group(checks, await ctxFor(dir))
    // The line is read out loud to a person, so it has to be a sentence. The smoke run against a
    // real repository printed "source scan limited to (no known source directory is present…)",
    // which says the scan was limited to a parenthesis.
    const line = map.get('placeholders.copy').notCovered[0]
    assert.match(line, /^placeholders: no source directory was scanned — this repository has none of /)
    assert.match(line, /src, content, pages, app/)
    assert.match(line, /so only the build output was searched$/)
    assert.ok(!line.includes('limited to ('), 'the line must not say the scan was limited to a parenthesis')
  } finally { cleanup() }
})

test('--strict cannot turn any other placeholder failure into anything softer', async () => {
  const lenient = await group(checks, await ctxFor(FAILING, { requiredEnv: ['PUBLIC_API_BASE'] }))
  const strict = await group(checks, await ctxFor(FAILING, { requiredEnv: ['PUBLIC_API_BASE'], strict: true }))
  for (const id of IDS) {
    if (id === 'placeholders.source-maps') continue
    assert.equal(strict.get(id).status, lenient.get(id).status, id)
  }
})
