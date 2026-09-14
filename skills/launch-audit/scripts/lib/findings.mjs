export const SEVERITIES = ['blocker', 'high', 'medium', 'low', 'info']
export const TIERS = ['http', 'browser', 'repo', 'human']
export const EVIDENCE_TYPES = ['url', 'status', 'header', 'html', 'file', 'screenshot', 'dns', 'cert', 'metric', 'text']
export class FindingError extends Error {}
const req = (o, k) => { if (o[k] === undefined || o[k] === null || o[k] === '') throw new FindingError(`finding.${k} is required`) }
export function finding(input) {
  for (const k of ['id', 'phase', 'dimension', 'severity', 'tier', 'title', 'detail', 'evidence', 'fix']) req(input, k)
  if (!SEVERITIES.includes(input.severity)) throw new FindingError(`unknown severity "${input.severity}"`)
  if (!TIERS.includes(input.tier)) throw new FindingError(`unknown tier "${input.tier}"`)
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) throw new FindingError('evidence must be a non-empty array')
  for (const e of input.evidence) {
    if (!EVIDENCE_TYPES.includes(e?.type)) throw new FindingError(`unknown evidence type "${e?.type}"`)
    if (e.value === undefined || e.value === null || e.value === '') throw new FindingError('evidence.value is required')
  }
  return Object.freeze({ page: null, ...input, evidence: Object.freeze(input.evidence.map((e) => Object.freeze({ ...e }))) })
}
export function validateFinding(f, knownIds) {
  const errors = []
  try { finding(f) } catch (e) { errors.push(e.message) }
  if (knownIds && !knownIds.has(f.id)) errors.push(`finding id "${f.id}" is not registered`)
  return { ok: errors.length === 0, errors }
}
export function sortFindings(list) {
  const rank = (s) => SEVERITIES.indexOf(s)
  return [...list].sort((a, b) => rank(a.severity) - rank(b.severity) || a.dimension.localeCompare(b.dimension) || String(a.page).localeCompare(String(b.page)))
}
