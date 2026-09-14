import { finding, SEVERITIES, TIERS } from './findings.mjs'
const ID = /^[a-z0-9-]+\.[a-z0-9-]+$/
const CHECK = Symbol('website-launch.check')
export class SkipCheck extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'SkipCheck'
    this.reason = reason
  }
}
export function defineCheck(def) {
  for (const k of ['id', 'phase', 'dimension', 'severity', 'tier', 'title', 'catches', 'run']) if (def[k] === undefined) throw new Error(`check.${k} is required`)
  if (typeof def.run !== 'function') throw new Error('check.run must be a function')
  if (!ID.test(def.id)) throw new Error(`check id "${def.id}" must be dimension.slug`)
  if (def.id.split('.')[0] !== def.dimension) throw new Error(`check id "${def.id}" prefix must equal dimension "${def.dimension}"`)
  if (!SEVERITIES.includes(def.severity)) throw new Error(`check severity "${def.severity}"`)
  if (!TIERS.includes(def.tier)) throw new Error(`check tier "${def.tier}"`)
  const check = { ...def }
  check.mk = (o) => finding({ id: def.id, phase: def.phase, dimension: def.dimension, severity: def.severity, tier: def.tier, ...o })
  check[CHECK] = true
  return Object.freeze(check)
}
export function createRegistry() {
  const map = new Map()
  return {
    add(c) { if (c?.[CHECK] !== true) throw new Error('add() takes a defineCheck() result'); if (map.has(c.id)) throw new Error(`duplicate check id ${c.id}`); map.set(c.id, c); return c },
    list: () => [...map.values()],
    byPhase: (p) => [...map.values()].filter((c) => c.phase === p),
    ids: () => new Set(map.keys()),
    byId: (id) => map.get(id),
  }
}
