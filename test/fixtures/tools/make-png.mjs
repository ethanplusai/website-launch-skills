#!/usr/bin/env node
// A minimal PNG writer, committed so the image fixtures can be regenerated from source.
//
// The gate reads image dimensions out of the first bytes of a file (lib/image-dims.mjs), so an
// og:image or an apple-touch-icon fixture has to be a real PNG with a real IHDR — a text file
// named `.png` would be reported as `unknown`, and the check it is meant to exercise would never
// fire. Nothing here draws: every pixel is one solid colour, because the only thing under test is
// the header.
//
// Usage: node test/fixtures/tools/make-png.mjs <out.png> <width> <height> [r] [g] [b]

import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { Buffer } from 'node:buffer'

// The standard CRC-32 table (polynomial 0xEDB88320), built once. Every PNG chunk carries a CRC of
// its type and data, and a viewer that finds a bad one is entitled to reject the file.
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

export function makePng(width, height, [r, g, b] = [32, 64, 128]) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour RGB
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  // One scanline is a filter byte (0 = None) followed by width RGB triples.
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const row = y * stride
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      const at = row + 1 + x * 3
      raw[at] = r
      raw[at + 1] = g
      raw[at + 2] = b
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// An ICO whose single image is a PNG. The format allows it (and every browser since Vista reads
// it), which means one generator covers both fixtures: a 6-byte header, one 16-byte directory
// entry, then the PNG itself. A side of 256 is stored as 0, the value the byte-wide field uses for
// the size that no longer fits in a byte.
export function makeIco(side, colour) {
  const png = makePng(side, side, colour)
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(1, 4) // one image
  const entry = Buffer.alloc(16)
  entry[0] = side >= 256 ? 0 : side
  entry[1] = side >= 256 ? 0 : side
  entry[2] = 0 // palette colours
  entry[3] = 0 // reserved
  entry.writeUInt16LE(1, 4) // colour planes
  entry.writeUInt16LE(32, 6) // bits per pixel
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(header.length + entry.length, 12)
  return Buffer.concat([header, entry, png])
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const [out, width, height, r, g, b] = process.argv.slice(2)
  if (!out || !width || !height) {
    process.stderr.write('usage: make-png.mjs <out.png|out.ico> <width> <height> [r] [g] [b]\n')
    process.exit(2)
  }
  const colour = [r, g, b].every((v) => v !== undefined) ? [Number(r), Number(g), Number(b)] : undefined
  const bytes = out.endsWith('.ico') ? makeIco(Number(width), colour) : makePng(Number(width), Number(height), colour)
  writeFileSync(out, bytes)
  process.stdout.write(`${out} ${width}x${height}\n`)
}
