import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
export function walk(dir, { skipDirs = new Set(['node_modules', '.git']) } = {}) {
  const out = []
  ;(function rec(d) {
    for (const entry of readdirSync(d).sort()) {
      if (skipDirs.has(entry)) continue
      const full = join(d, entry)
      const st = statSync(full)
      if (st.isDirectory()) rec(full)
      else out.push(full)
    }
  })(dir)
  return out
}
export const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
export const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2) + '\n')
export const ensureDir = (p) => mkdirSync(p, { recursive: true })
