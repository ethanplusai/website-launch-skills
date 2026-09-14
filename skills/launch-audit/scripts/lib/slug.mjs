export function slugify(input) {
  let s = String(input)
  try { const u = new URL(s); s = (u.hostname + u.pathname).replace(/\/$/, '') || 'index' } catch {}
  s = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!s) s = 'index'
  return s.slice(0, 80)
}
