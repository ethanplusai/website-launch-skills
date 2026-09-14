import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REQUIRED, checkJsonLd } from '../skills/launch-audit/scripts/lib/schema/required.mjs'

const byType = (entries, type) => entries.find((e) => e.type === type)

test('REQUIRED covers the types a launch audit is expected to judge', () => {
  assert.deepEqual(REQUIRED.Organization, ['name', 'url'])
  assert.deepEqual(REQUIRED.LocalBusiness, ['name', 'address', 'telephone'])
  assert.deepEqual(REQUIRED.WebSite, ['name', 'url'])
  assert.deepEqual(REQUIRED.Article, ['headline', 'datePublished', 'author'])
  assert.deepEqual(REQUIRED.BlogPosting, ['headline', 'datePublished', 'author'])
  assert.deepEqual(REQUIRED.Product, ['name', 'image', 'offers'])
  assert.deepEqual(REQUIRED.FAQPage, ['mainEntity'])
  assert.deepEqual(REQUIRED.BreadcrumbList, ['itemListElement'])
  assert.deepEqual(REQUIRED.Service, ['name', 'provider'])
  assert.deepEqual(REQUIRED.Person, ['name'])
  assert.deepEqual(REQUIRED.Event, ['name', 'startDate', 'location'])
})

test('a complete node reports no missing properties', () => {
  const entries = checkJsonLd({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Acme', url: 'https://acme.test/' })
  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0].missing, [])
  assert.equal(entries[0].type, 'Organization')
})

test('an incomplete node names every required property it lacks', () => {
  const entries = checkJsonLd({ '@type': 'LocalBusiness', name: 'Acme' })
  assert.deepEqual(entries[0].missing, ['address', 'telephone'])
})

test('empty strings, nulls and empty arrays count as missing', () => {
  const entries = checkJsonLd({ '@type': 'Event', name: '  ', startDate: null, location: [] })
  assert.deepEqual(entries[0].missing, ['name', 'startDate', 'location'])
})

test('walks a @graph and reports one entry per typed node', () => {
  const entries = checkJsonLd({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', name: 'Acme', url: 'https://acme.test/' },
      { '@type': 'Organization', name: 'Acme' },
      { name: 'untyped, and so not judged' },
    ],
  })
  assert.deepEqual(entries.map((e) => e.type), ['WebSite', 'Organization'])
  assert.deepEqual(byType(entries, 'Organization').missing, ['url'])
})

test('walks a top-level array', () => {
  const entries = checkJsonLd([{ '@type': 'Person', name: 'Ada' }, { '@type': 'Product', name: 'Widget' }])
  assert.deepEqual(entries.map((e) => e.type), ['Person', 'Product'])
  assert.deepEqual(byType(entries, 'Product').missing, ['image', 'offers'])
})

test('an array @type picks the first type the table knows', () => {
  const entries = checkJsonLd({ '@type': ['CreativeWork', 'Article'], headline: 'Hello' })
  assert.equal(entries[0].type, 'Article')
  assert.deepEqual(entries[0].missing, ['datePublished', 'author'])
})

test('a type the table does not know is reported with nothing missing', () => {
  const entries = checkJsonLd({ '@type': 'SoftwareApplication', name: 'Thing' })
  assert.equal(entries[0].type, 'SoftwareApplication')
  assert.deepEqual(entries[0].missing, [])
})

test('nested typed objects are not judged as nodes of their own', () => {
  const entries = checkJsonLd({
    '@type': 'Article',
    headline: 'Hello',
    datePublished: '2026-01-01',
    author: { '@type': 'Person' },
  })
  assert.deepEqual(entries.map((e) => e.type), ['Article'])
  assert.deepEqual(entries[0].missing, [])
})

test('collects absolute http(s) urls from url, logo and image', () => {
  const entries = checkJsonLd({
    '@type': 'Organization',
    name: 'Acme',
    url: 'https://acme.test/',
    logo: 'https://acme.test/logo.png',
    image: { '@type': 'ImageObject', url: 'https://acme.test/hero.jpg' },
  })
  assert.deepEqual(entries[0].urlsToVerify, ['https://acme.test/', 'https://acme.test/logo.png', 'https://acme.test/hero.jpg'])
})

test('skips relative urls, other schemes and non-string values', () => {
  const entries = checkJsonLd({
    '@type': 'Organization',
    name: 'Acme',
    url: '/about',
    logo: 'data:image/png;base64,AAAA',
    image: ['https://acme.test/one.png', 42, 'mailto:a@acme.test'],
  })
  assert.deepEqual(entries[0].urlsToVerify, ['https://acme.test/one.png'])
})

test('a parse result that is not an object yields no entries', () => {
  assert.deepEqual(checkJsonLd(null), [])
  assert.deepEqual(checkJsonLd('a string'), [])
  assert.deepEqual(checkJsonLd(undefined), [])
  assert.deepEqual(checkJsonLd(7), [])
})
