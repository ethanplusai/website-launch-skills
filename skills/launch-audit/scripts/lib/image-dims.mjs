// Image dimensions from the first bytes of a response, without decoding the image.
//
// imageDimensions(bytes) → { type, width, height }. Every format here declares its size in a
// fixed-position header, so the only work is recognising the container and reading two integers:
// no pixel data is ever touched, and a truncated download still answers as long as the header
// survived. `type` is 'png' | 'jpeg' | 'gif' | 'webp' | 'svg' | 'ico' | 'unknown'; `width` and
// `height` are null whenever the container is recognised but the size is not readable (a JPEG
// whose SOF was cut off, an SVG with neither dimensions nor a viewBox).
//
// This exists so `head.og-image-small` can say "your og:image is 600×315" about a url the audit
// only fetched once, and so `head.og-image-not-raster` can tell an SVG from a PNG when the server
// misreports the content type.
//
// Byte order is per format and worth stating, because it is the thing that goes wrong: PNG and
// JPEG are big-endian, GIF and every WebP chunk are little-endian, and VP8L is a little-endian
// *bit* stream where width-1 occupies the low 14 bits of a 32-bit word.

const UNKNOWN = { type: 'unknown', width: null, height: null }

const result = (type, width, height) => ({ type, width, height })

const at = (bytes, offset, ...expected) => expected.every((byte, i) => bytes[offset + i] === byte)
const ascii = (bytes, offset, text) => at(bytes, offset, ...[...text].map((c) => c.charCodeAt(0)))
const be16 = (b, i) => (b[i] << 8) | b[i + 1]
const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
const le16 = (b, i) => b[i] | (b[i + 1] << 8)
const le24 = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)
const le32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0

// PNG: an 8-byte signature, then IHDR — always the first chunk — carrying two big-endian u32s.
function png(bytes) {
  if (bytes.length < 24 || !ascii(bytes, 12, 'IHDR')) return result('png', null, null)
  return result('png', be32(bytes, 16), be32(bytes, 20))
}

// JPEG: walk the segment list from SOI to the first start-of-frame. SOF0/1/2 are baseline,
// extended sequential and progressive; the rest of the C-block is either arithmetic-coded (rare
// enough to skip) or not a frame header at all (C4 is a Huffman table, C8/CC are not frames).
const SOF = new Set([0xc0, 0xc1, 0xc2])
const STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9])
function jpeg(bytes) {
  let i = 2
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue } // resynchronise on entropy-coded padding
    const marker = bytes[i + 1]
    if (marker === 0xff) { i++; continue } // fill bytes
    if (STANDALONE.has(marker)) { i += 2; continue }
    if (marker === 0xda) break // start of scan: no frame header follows
    const length = be16(bytes, i + 2)
    if (length < 2) break
    if (SOF.has(marker)) {
      if (i + 9 >= bytes.length) break
      return result('jpeg', be16(bytes, i + 7), be16(bytes, i + 5))
    }
    i += 2 + length
  }
  return result('jpeg', null, null)
}

// GIF: the logical screen descriptor sits right after the 6-byte version signature.
function gif(bytes) {
  if (bytes.length < 10) return result('gif', null, null)
  return result('gif', le16(bytes, 6), le16(bytes, 8))
}

// WebP: a RIFF container whose first chunk says which of the three encodings this is.
function webp(bytes) {
  const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
  if (chunk === 'VP8 ' && bytes.length >= 30 && at(bytes, 23, 0x9d, 0x01, 0x2a)) {
    return result('webp', le16(bytes, 26) & 0x3fff, le16(bytes, 28) & 0x3fff)
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const packed = le32(bytes, 21)
    return result('webp', (packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1)
  }
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return result('webp', le24(bytes, 24) + 1, le24(bytes, 27) + 1)
  }
  return result('webp', null, null)
}

// ICO: a 6-byte header then one directory entry per image. The first entry is the one a browser
// reaches for first, and a stored 0 means 256 — the size that no longer fits in a byte.
function ico(bytes) {
  if (bytes.length < 8 || le16(bytes, 4) === 0) return result('ico', null, null)
  const side = (value) => (value === 0 ? 256 : value)
  return result('ico', side(bytes[6]), side(bytes[7]))
}

const SVG_TAG = /<svg\b[^>]*>/i
const LENGTH = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/i
const VIEWBOX = /viewBox\s*=\s*["']?\s*(-?[0-9.]+)[\s,]+(-?[0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)/i

function svgLength(tag, name) {
  const found = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  if (found === null) return null
  const parsed = LENGTH.exec(found[1] ?? found[2] ?? found[3] ?? '')
  return parsed === null ? null : Math.round(Number(parsed[1]))
}

// SVG carries its size in attributes that may be absent, relative ("100%") or unitful; the
// viewBox is the fallback, because that is the ratio a renderer actually lays out.
function svg(text) {
  const tag = SVG_TAG.exec(text)
  if (tag === null) return result('svg', null, null)
  const width = svgLength(tag[0], 'width')
  const height = svgLength(tag[0], 'height')
  if (width !== null && height !== null) return result('svg', width, height)
  const box = VIEWBOX.exec(tag[0])
  if (box === null) return result('svg', null, null)
  return result('svg', Math.round(Number(box[3])), Math.round(Number(box[4])))
}

const SNIFF_BYTES = 4096

export function imageDimensions(input) {
  if (input === null || input === undefined) return { ...UNKNOWN }
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input.buffer ?? input)
  if (bytes.length === 0) return { ...UNKNOWN }

  if (at(bytes, 0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return png(bytes)
  if (ascii(bytes, 0, 'GIF8')) return gif(bytes)
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return webp(bytes)
  if (at(bytes, 0, 0xff, 0xd8, 0xff)) return jpeg(bytes)
  if (at(bytes, 0, 0x00, 0x00, 0x01, 0x00)) return ico(bytes)

  // Nothing binary matched; an SVG is just text, so decode the head of the body and look for the
  // root element. A decode that produces replacement characters is simply not SVG.
  const text = new TextDecoder('utf-8').decode(bytes.subarray(0, SNIFF_BYTES))
  if (SVG_TAG.test(text)) return svg(text)
  return { ...UNKNOWN }
}
