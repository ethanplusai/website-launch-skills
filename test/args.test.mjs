import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineArgs } from '../skills/launch-audit/scripts/lib/args.mjs'
import { tmpDir } from './helpers.mjs'

const p = defineArgs({ name: 'demo', description: 'd', flags: {
  url: { type: 'string', required: true, help: 'target' },
  'max-pages': { type: 'number', default: 200, help: 'cap' },
  'dev-host': { type: 'list', help: 'hosts', repeatable: true },
  staging: { type: 'boolean', default: false, help: 's' },
}})

test('parses strings, numbers, lists (repeat and comma), booleans', () => {
  const { values, errors } = p.parse(['--url', 'https://a.test', '--max-pages', '5', '--dev-host', 'a,b', '--dev-host', 'c', '--staging'])
  assert.deepEqual(errors, [])
  assert.equal(values.url, 'https://a.test'); assert.equal(values['max-pages'], 5)
  assert.deepEqual(values['dev-host'], ['a', 'b', 'c']); assert.equal(values.staging, true); assert.equal(values.json, false)
})
test('missing required flag is an error, not a throw', () => { assert.match(p.parse([]).errors[0], /--url is required/) })
test('unknown flag is an error', () => { assert.match(p.parse(['--url', 'x', '--nope']).errors[0], /unknown flag --nope/) })
test('config supplies defaults, CLI overrides', () => {
  const { values } = p.parse(['--max-pages', '9'], { config: { url: 'https://c.test', 'max-pages': 1 } })
  assert.equal(values.url, 'https://c.test'); assert.equal(values['max-pages'], 9)
})
test('--help and --json are always accepted; help text lists every flag', () => {
  assert.equal(p.parse(['--help']).values.help, true)
  const h = p.helpText(); for (const f of ['--url', '--max-pages', '--dev-host', '--staging', '--json', '--config']) assert.ok(h.includes(f), f)
  assert.ok(h.includes('(required)'))
})
test('a non-numeric value for a number flag is an error', () => { assert.match(p.parse(['--url', 'x', '--max-pages', 'lots']).errors[0], /--max-pages expects a number/) })

// --- Decision 1: --flag=value, boolean --no-<flag>, boolean not consuming next token ---
test('accepts --flag=value form', () => {
  const { values, errors } = p.parse(['--url=https://eq.test', '--max-pages=7'])
  assert.deepEqual(errors, [])
  assert.equal(values.url, 'https://eq.test')
  assert.equal(values['max-pages'], 7)
})
test('--no-<flag> sets boolean false', () => {
  const { values, errors } = p.parse(['--url', 'x', '--no-staging'])
  assert.deepEqual(errors, [])
  assert.equal(values.staging, false)
})
test('a boolean flag does not consume a following non-flag token as its value', () => {
  const { values, errors } = p.parse(['--staging', 'extra', '--url', 'x'])
  // "extra" is not another flag, so it must NOT be consumed by --staging;
  // it should surface as an unexpected positional argument instead.
  assert.equal(values.staging, true)
  assert.ok(errors.some((e) => /unexpected argument "extra"/.test(e)))
})

// --- Decision 2: --config <path> read by the parser itself ---
test('--config <path> loads JSON file; CLI flags win over file values', () => {
  const { dir, cleanup } = tmpDir('args-config')
  try {
    const cfgPath = join(dir, 'config.json')
    writeFileSync(cfgPath, JSON.stringify({ url: 'https://file.test', 'max-pages': 3 }))
    const { values, errors } = p.parse(['--config', cfgPath, '--max-pages', '11'])
    assert.deepEqual(errors, [])
    assert.equal(values.config, cfgPath)
    assert.equal(values.url, 'https://file.test')
    assert.equal(values['max-pages'], 11)
  } finally {
    cleanup()
  }
})
test('unreadable --config path is an error value, not a throw', () => {
  const { errors } = p.parse(['--url', 'x', '--config', '/nonexistent/path/does-not-exist.json'])
  assert.match(errors[0], /--config \/nonexistent\/path\/does-not-exist\.json: /)
})
test('invalid JSON in --config file is an error value, not a throw', () => {
  const { dir, cleanup } = tmpDir('args-config-bad')
  try {
    const cfgPath = join(dir, 'bad.json')
    writeFileSync(cfgPath, '{ not valid json')
    const { errors } = p.parse(['--url', 'x', '--config', cfgPath])
    assert.match(errors[0], new RegExp(`--config ${cfgPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `))
  } finally {
    cleanup()
  }
})
test('--config file values merge before the {config} option, which merges before CLI flags', () => {
  const { dir, cleanup } = tmpDir('args-config-merge-order')
  try {
    const cfgPath = join(dir, 'config.json')
    writeFileSync(cfgPath, JSON.stringify({ url: 'https://file.test', 'max-pages': 1 }))
    const { values } = p.parse(['--config', cfgPath], { config: { 'max-pages': 2 } })
    // file provides url (option object has none) and max-pages=1, but the option
    // object overrides max-pages to 2 since it merges after the file.
    assert.equal(values.url, 'https://file.test')
    assert.equal(values['max-pages'], 2)
  } finally {
    cleanup()
  }
})

// --- Decision 4: unknown flags and stray positionals are both errors ---
test('stray positional argument is an error', () => {
  const { errors } = p.parse(['--url', 'x', 'stray'])
  assert.match(errors[0], /unexpected argument "stray"/)
})

// --- Decision 3/5/6 spot checks ---
test('list flag defaults to empty array when absent', () => {
  const { values } = p.parse(['--url', 'x'])
  assert.deepEqual(values['dev-host'], [])
})
test('comma-split drops empty items', () => {
  const { values, errors } = p.parse(['--url', 'x', '--dev-host', 'a,,b,'])
  assert.deepEqual(errors, [])
  assert.deepEqual(values['dev-host'], ['a', 'b'])
})
test('values.help and values.json are always booleans; values.config is path or null', () => {
  const r1 = p.parse(['--url', 'x'])
  assert.equal(typeof r1.values.help, 'boolean')
  assert.equal(typeof r1.values.json, 'boolean')
  assert.equal(r1.values.config, null)
  const r2 = p.parse(['--url', 'x', '--json'])
  assert.equal(r2.values.json, true)
})

// --- Fix round 1, finding 1: required is not enforced for type: 'list' flags ---
test('a required list flag with no input is an error; with a value it passes', () => {
  const rp = defineArgs({ name: 'req-list-demo', description: 'd', flags: {
    checks: { type: 'list', required: true, help: 'which checks to run' },
  }})
  const missing = rp.parse([])
  assert.match(missing.errors[0], /--checks is required/)
  assert.deepEqual(missing.values.checks, [])
  const present = rp.parse(['--checks', 'a'])
  assert.deepEqual(present.errors, [])
  assert.deepEqual(present.values.checks, ['a'])
})

// --- Fix round 1, finding 2: unknown-flag detection bypassed by inherited property names ---
test('inherited Object.prototype property names are never treated as known flags', () => {
  const r1 = p.parse(['--url', 'x', '--constructor', 'evil'])
  assert.ok(r1.errors.includes('unknown flag --constructor'), r1.errors.join('; '))
  assert.ok(r1.errors.includes('unexpected argument "evil"'), r1.errors.join('; '))

  const r2 = p.parse(['--url', 'x', '--__proto__', 'evil'])
  assert.ok(r2.errors.includes('unknown flag --__proto__'), r2.errors.join('; '))
  assert.ok(r2.errors.includes('unexpected argument "evil"'), r2.errors.join('; '))
})
test('the --no-<flag> negation lookup also refuses to resolve inherited property names', () => {
  const r = p.parse(['--url', 'x', '--no-constructor', 'evil'])
  assert.ok(r.errors.includes('unknown flag --no-constructor'), r.errors.join('; '))
  assert.ok(r.errors.includes('unexpected argument "evil"'), r.errors.join('; '))
})
