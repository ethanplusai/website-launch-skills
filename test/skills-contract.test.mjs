// The Agent Skills contract, enforced on every skill in the repo.
//
// These are the rules a SKILL.md has to satisfy to load in any agent that reads the standard, plus
// the two this repository adds for itself: a skill that never says `read-only` is not honest about
// its posture, and one that never says `Not covered` has nowhere to put what it did not check.
//
// The test walks `skills/*/SKILL.md`, so it covers whichever skills exist when it runs and starts
// covering the next one the day it lands, with no edit here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { REPO_ROOT } from './helpers.mjs'

const SKILLS_DIR = join(REPO_ROOT, 'skills')
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/
const MAX_LINES = 200
const MAX_NAME = 64
const MAX_DESCRIPTION = 1024

// Every backticked relative path a SKILL.md mentions that points into the skill's own tree. Only
// `scripts/…` and `references/…` are claimed here: those are the two directories the standard says
// a skill owns, and a backticked `--flag` or a shell snippet is not a path.
const PATH_IN_BACKTICKS = /`([^`]+)`/g
const OWNED = /^(scripts|references)\/[A-Za-z0-9._\-/]+$/

function skillDirs() {
  if (!existsSync(SKILLS_DIR)) return []
  return readdirSync(SKILLS_DIR)
    .map((name) => join(SKILLS_DIR, name))
    .filter((dir) => statSync(dir).isDirectory() && existsSync(join(dir, 'SKILL.md')))
}

// A deliberately small YAML reader: the frontmatter of a SKILL.md is a flat map of scalars, and a
// parser that accepts more than that would accept a file no other agent's parser would.
function parseFrontmatter(text) {
  const lines = text.split('\n')
  if (lines[0].trim() !== '---') return { ok: false, error: 'no frontmatter fence on line 1', data: {} }
  const end = lines.indexOf('---', 1)
  if (end === -1) return { ok: false, error: 'frontmatter fence is never closed', data: {} }
  const data = {}
  for (let i = 1; i < end; i++) {
    const line = lines[i]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon === -1) return { ok: false, error: `frontmatter line ${i + 1} is not "key: value"`, data }
    const key = line.slice(0, colon).trim()
    let value = line.slice(colon + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    data[key] = value
  }
  return { ok: true, error: null, data }
}

const skills = skillDirs()

test('the repo ships at least one skill', () => {
  assert.ok(skills.length > 0, 'no skills/*/SKILL.md found')
})

test('the frontmatter reader rejects a file with no fence', () => {
  assert.equal(parseFrontmatter('# hello\n').ok, false)
  assert.equal(parseFrontmatter('---\nname: x\n---\nbody\n').data.name, 'x')
})

for (const dir of skills) {
  const name = basename(dir)
  const file = join(dir, 'SKILL.md')
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')

  test(`${name}: frontmatter parses`, () => {
    const { ok, error } = parseFrontmatter(text)
    assert.ok(ok, `${error}`)
  })

  test(`${name}: name is the directory name and a legal skill name`, () => {
    const { data } = parseFrontmatter(text)
    assert.equal(data.name, name, 'frontmatter name must equal the directory name')
    assert.match(data.name, NAME)
    assert.ok(data.name.length <= MAX_NAME, `name is ${data.name.length} chars, max ${MAX_NAME}`)
  })

  test(`${name}: description says what and when, within the length limit`, () => {
    const { data } = parseFrontmatter(text)
    assert.equal(typeof data.description, 'string')
    assert.ok(data.description.length >= 1, 'description is empty')
    assert.ok(data.description.length <= MAX_DESCRIPTION, `description is ${data.description.length} chars, max ${MAX_DESCRIPTION}`)
  })

  test(`${name}: SKILL.md is at most ${MAX_LINES} lines`, () => {
    const count = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
    assert.ok(count <= MAX_LINES, `SKILL.md is ${count} lines, max ${MAX_LINES}`)
  })

  test(`${name}: every script and reference it names exists`, () => {
    const missing = []
    for (const match of text.matchAll(PATH_IN_BACKTICKS)) {
      const candidate = match[1].trim()
      if (!OWNED.test(candidate)) continue
      if (!existsSync(join(dir, candidate))) missing.push(candidate)
    }
    assert.deepEqual(missing, [], `SKILL.md names files that do not exist: ${missing.join(', ')}`)
  })

  test(`${name}: references are one level deep`, () => {
    const refs = join(dir, 'references')
    if (!existsSync(refs)) return
    const nested = readdirSync(refs).filter((entry) => statSync(join(refs, entry)).isDirectory())
    assert.deepEqual(nested, [], 'references/ must be a flat directory')
  })

  test(`${name}: states its read-only posture and its Not covered contract`, () => {
    assert.match(text, /read-only/)
    assert.match(text, /Not covered/)
  })

  test(`${name}: no agent-specific variables or paths`, () => {
    assert.ok(!text.includes('CLAUDE_PLUGIN_ROOT'), 'SKILL.md must not name an agent-specific variable')
    assert.ok(!text.includes('${'), 'SKILL.md must not interpolate a shell or agent variable')
  })

  test(`${name}: the skill directory it lives in is the one it names`, () => {
    assert.equal(basename(dirname(file)), name)
  })
}
