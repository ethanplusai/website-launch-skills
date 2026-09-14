import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const fixturePath = (rel) => join(REPO_ROOT, 'test', 'fixtures', rel)
export const readFixture = (rel) => readFileSync(fixturePath(rel), 'utf8')
export function tmpDir(name) {
  const dir = join(REPO_ROOT, 'test', 'tmp', `${name}-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// The recorded-response net adapter lives in the skill's own lib, because the CLI needs it too
// (WEBSITE_LAUNCH_RECORDED_FIXTURE). Re-exported here so every test keeps its existing import, and
// so there is exactly one implementation of the fixture shape.
import { recordedNet } from '../skills/launch-audit/scripts/lib/recorded-net.mjs'

export { recordedNet }

export function recordedNetFromFile(relPath) {
  return recordedNet(JSON.parse(readFixture(relPath)))
}
