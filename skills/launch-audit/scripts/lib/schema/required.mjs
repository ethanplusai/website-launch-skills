// The schema.org properties a rich result actually needs, and a reader for the JSON-LD a page ships.
//
// REQUIRED is deliberately short. It is not schema.org's own definition of a type — almost every
// property there is optional — but the set Google's structured-data documentation lists as
// required for the corresponding rich result. A node missing one of these is not "less rich"; it
// is ineligible, which is why `head.jsonld-missing-required` is worth a finding at all.
//
// checkJsonLd(parsed) takes one already-parsed <script type="application/ld+json"> body and
// returns one entry per typed node:
//
//   { type: 'Organization', missing: ['url'], urlsToVerify: ['https://acme.test/logo.png'] }
//
// Three shapes count as carrying nodes: a bare object, a top-level array of objects, and the
// `@graph` array that most CMS plugins emit. Nodes are read one level deep on purpose — a typed
// object sitting in a property (`Article.author`, `Product.offers`) is part of its parent's
// completeness, not a node with requirements of its own, and judging it separately would report
// every author of every article as an incomplete Person.
//
// A `@type` array picks the first type the table knows, because that is the type the rich result
// would be granted for; a type the table does not know is reported with `missing: []` rather than
// dropped, so `head.jsonld-types-summary` can still name it.
//
// `urlsToVerify` is the subset of a node's urls that a check can follow: absolute http(s) strings
// in `url`, `logo` and `image`, including the `{ "@type": "ImageObject", "url": ... }` spelling
// and arrays of either. A relative url, a data: uri or a number is skipped — there is nothing to
// verify and nothing the author got wrong by writing it.

export const REQUIRED = Object.freeze({
  Organization: ['name', 'url'],
  LocalBusiness: ['name', 'address', 'telephone'],
  WebSite: ['name', 'url'],
  Article: ['headline', 'datePublished', 'author'],
  BlogPosting: ['headline', 'datePublished', 'author'],
  Product: ['name', 'image', 'offers'],
  FAQPage: ['mainEntity'],
  BreadcrumbList: ['itemListElement'],
  Service: ['name', 'provider'],
  Person: ['name'],
  Event: ['name', 'startDate', 'location'],
})

const URL_PROPERTIES = ['url', 'logo', 'image']
const ABSOLUTE_HTTP = /^https?:\/\/\S+$/i

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

// "Present" means a reader would see something: a blank string, a null and an empty array are all
// the property not being there.
function present(value) {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0
  return true
}

function typeOf(node) {
  const raw = node['@type']
  const types = (Array.isArray(raw) ? raw : [raw]).filter((t) => typeof t === 'string' && t.trim() !== '').map((t) => t.trim())
  if (types.length === 0) return null
  return types.find((t) => REQUIRED[t] !== undefined) ?? types[0]
}

function urlsFrom(value, out) {
  if (typeof value === 'string') {
    if (ABSOLUTE_HTTP.test(value.trim())) out.push(value.trim())
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) urlsFrom(item, out)
    return
  }
  if (isObject(value) && typeof value.url === 'string') urlsFrom(value.url, out)
}

// The nodes a document carries, one level deep: the object itself, the members of a top-level
// array, and the members of a `@graph`.
function nodesOf(parsed) {
  if (Array.isArray(parsed)) return parsed.filter(isObject).flatMap((entry) => nodesOf(entry))
  if (!isObject(parsed)) return []
  const graph = parsed['@graph']
  const nodes = Array.isArray(graph) ? graph.filter(isObject) : []
  if (parsed['@type'] !== undefined) nodes.unshift(parsed)
  return nodes
}

export function checkJsonLd(parsed) {
  const entries = []
  for (const node of nodesOf(parsed)) {
    const type = typeOf(node)
    if (type === null) continue
    const required = REQUIRED[type] ?? []
    const urlsToVerify = []
    for (const property of URL_PROPERTIES) urlsFrom(node[property], urlsToVerify)
    entries.push({
      type,
      missing: required.filter((property) => !present(node[property])),
      urlsToVerify: [...new Set(urlsToVerify)],
    })
  }
  return entries
}
