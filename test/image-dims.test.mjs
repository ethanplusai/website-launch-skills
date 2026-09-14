import { test } from 'node:test'
import assert from 'node:assert/strict'
import { imageDimensions } from '../skills/launch-audit/scripts/lib/image-dims.mjs'

// Every fixture here is a hand-built header: the bytes a decoder reads before it reaches pixel
// data, and nothing else. That is all imageDimensions() ever looks at, so a real file would only
// add megabytes to the repository without adding coverage.
const bytes = (...parts) => Uint8Array.from(parts.flat())
const ascii = (s) => [...s].map((c) => c.charCodeAt(0))
const be16 = (n) => [(n >> 8) & 0xff, n & 0xff]
const be32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
const le16 = (n) => [n & 0xff, (n >> 8) & 0xff]
const le24 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]
const le32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]

const png = (w, h) => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), ascii('IHDR'), be32(w), be32(h), [8, 6, 0, 0, 0])

// SOI, a JFIF APP0 to be walked past, then the SOF the dimensions live in.
const jpeg = (w, h, sof = 0xc0) =>
  bytes(
    [0xff, 0xd8],
    [0xff, 0xe0], be16(16), ascii('JFIF'), [0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
    [0xff, sof], be16(17), [8], be16(h), be16(w), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
  )

const gif = (w, h) => bytes(ascii('GIF89a'), le16(w), le16(h), [0xf7, 0x00, 0x00])

const webpLossy = (w, h) =>
  bytes(ascii('RIFF'), le32(30), ascii('WEBP'), ascii('VP8 '), le32(18), [0x30, 0x01, 0x00], [0x9d, 0x01, 0x2a], le16(w), le16(h))

// VP8L packs width-1 into the low 14 bits and height-1 into the next 14, read LSB-first.
const webpLossless = (w, h) =>
  bytes(ascii('RIFF'), le32(20), ascii('WEBP'), ascii('VP8L'), le32(8), [0x2f], le32((w - 1) | ((h - 1) << 14)))

const webpExtended = (w, h) =>
  bytes(ascii('RIFF'), le32(22), ascii('WEBP'), ascii('VP8X'), le32(10), [0x10, 0, 0, 0], le24(w - 1), le24(h - 1))

const ico = (w, h) => bytes([0, 0, 1, 0], le16(1), [w & 0xff, h & 0xff, 0, 0], le16(1), le16(32), le32(0), le32(22))

const utf8 = (s) => new TextEncoder().encode(s)

test('reads PNG dimensions out of the IHDR chunk', () => {
  assert.deepEqual(imageDimensions(png(1200, 630)), { type: 'png', width: 1200, height: 630 })
  assert.deepEqual(imageDimensions(png(1, 1)), { type: 'png', width: 1, height: 1 })
})

test('reads JPEG dimensions from SOF0, SOF1 and SOF2, walking past earlier segments', () => {
  assert.deepEqual(imageDimensions(jpeg(1200, 630, 0xc0)), { type: 'jpeg', width: 1200, height: 630 })
  assert.deepEqual(imageDimensions(jpeg(800, 400, 0xc1)), { type: 'jpeg', width: 800, height: 400 })
  assert.deepEqual(imageDimensions(jpeg(64, 48, 0xc2)), { type: 'jpeg', width: 64, height: 48 })
})

test('a JPEG with no SOF before the scan reports the type without dimensions', () => {
  const noSof = bytes([0xff, 0xd8], [0xff, 0xe0], be16(4), [0, 0], [0xff, 0xda], be16(4), [0, 0])
  assert.deepEqual(imageDimensions(noSof), { type: 'jpeg', width: null, height: null })
})

test('reads GIF dimensions from the logical screen descriptor', () => {
  assert.deepEqual(imageDimensions(gif(300, 200)), { type: 'gif', width: 300, height: 200 })
  assert.deepEqual(imageDimensions(bytes(ascii('GIF87a'), le16(16), le16(9), [0, 0, 0])), { type: 'gif', width: 16, height: 9 })
})

test('reads WebP dimensions from VP8, VP8L and VP8X chunks', () => {
  assert.deepEqual(imageDimensions(webpLossy(1200, 630)), { type: 'webp', width: 1200, height: 630 })
  assert.deepEqual(imageDimensions(webpLossless(1200, 630)), { type: 'webp', width: 1200, height: 630 })
  assert.deepEqual(imageDimensions(webpExtended(2400, 1260)), { type: 'webp', width: 2400, height: 1260 })
})

test('reads ICO dimensions from the first directory entry, where 0 means 256', () => {
  assert.deepEqual(imageDimensions(ico(32, 32)), { type: 'ico', width: 32, height: 32 })
  assert.deepEqual(imageDimensions(ico(0, 0)), { type: 'ico', width: 256, height: 256 })
})

test('reads SVG dimensions from width and height attributes', () => {
  assert.deepEqual(imageDimensions(utf8('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"></svg>')), { type: 'svg', width: 64, height: 32 })
  assert.deepEqual(imageDimensions(utf8('<svg width="120px" height="60px"/>')), { type: 'svg', width: 120, height: 60 })
})

test('falls back to the SVG viewBox when width and height are absent or relative', () => {
  assert.deepEqual(imageDimensions(utf8('<?xml version="1.0"?>\n<svg viewBox="0 0 1200 630"></svg>')), { type: 'svg', width: 1200, height: 630 })
  assert.deepEqual(imageDimensions(utf8('<svg width="100%" height="100%" viewBox="0 0 48 24"/>')), { type: 'svg', width: 48, height: 24 })
  assert.deepEqual(imageDimensions(utf8('<svg></svg>')), { type: 'svg', width: null, height: null })
})

test('anything else is unknown, including empty and absent input', () => {
  assert.deepEqual(imageDimensions(utf8('not an image at all')), { type: 'unknown', width: null, height: null })
  assert.deepEqual(imageDimensions(new Uint8Array(0)), { type: 'unknown', width: null, height: null })
  assert.deepEqual(imageDimensions(null), { type: 'unknown', width: null, height: null })
  assert.deepEqual(imageDimensions(undefined), { type: 'unknown', width: null, height: null })
  assert.deepEqual(imageDimensions(bytes([0x89, 0x50, 0x4e])), { type: 'unknown', width: null, height: null })
})

test('accepts a Buffer as well as a Uint8Array', () => {
  assert.deepEqual(imageDimensions(Buffer.from(png(10, 20))), { type: 'png', width: 10, height: 20 })
})
