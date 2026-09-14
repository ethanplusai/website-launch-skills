// Running one group of gate checks over a fixture repository.
//
// Split from `pre-launch-helpers.mjs` because this half pulls in the whole gate — the context, all
// six check modules and the runner — while the other half is only fixtures and fakes, and the
// detector tests should not have to load a gate to use them.

import { buildGateContext, normalizeOptions } from '../skills/pre-launch/scripts/lib/context.mjs'
import { runChecks } from '../skills/pre-launch/scripts/lib/gate.mjs'
import { FAILING, FAILING_URL, PASSING_URL, noGit } from './pre-launch-helpers.mjs'

// A context over one of the two fixtures with the build skipped (both ship a committed `dist`, so
// the gate has real output to read without shelling out to a package manager).
export function ctxFor(dir, { exec = noGit(), net = null, env = {}, now = new Date('2026-09-14T00:00:00Z'), ...over } = {}) {
  const productionUrl = over.productionUrl ?? (dir === FAILING ? FAILING_URL : PASSING_URL)
  return buildGateContext({
    dir,
    options: normalizeOptions({ skipBuild: true, ...over, productionUrl }),
    exec,
    net,
    env,
    now,
  })
}

// Runs one module's checks over a context and returns them keyed by id.
export async function group(checks, ctx) {
  const results = await runChecks(checks, ctx)
  return new Map(results.map((r) => [r.id, r]))
}

export function assertStatus(map, id, status, assert) {
  const found = map.get(id)
  assert.ok(found !== undefined, `${id} did not run`)
  assert.equal(found.status, status, `${id}: expected ${status}, got ${found.status} — ${found.detail}`)
  return found
}
