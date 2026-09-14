// Reading CSV, which is the other half of the redirect map.
//
// `checks/redirects.mjs` writes `redirects.csv` at audit time — one row per old url, with the
// destination each one should have after the cutover. On cutover day `post-launch` reads that same
// file back and re-requests every row, so the two halves have to agree exactly. The column list
// here is imported from the writer rather than retyped, and a test asserts the two are the same
// string, because a redirect map that parses into the wrong columns is worse than one that fails
// to parse: it would silently check the wrong thing.
//
// parseCsv(text) is RFC 4180, in the only way that matters for a file a human may have edited in a
// spreadsheet: CRLF or bare LF between records, a field quoted when it holds a comma, a quote or a
// newline, and a quote inside a quoted field written twice. A byte order mark, which is what Excel
// writes on a "CSV UTF-8" save, is skipped rather than glued to the first header name.
//
// parseRedirectCsv(text) adds the shape: it refuses a file whose header is not the redirect
// header, and it reports a malformed row by line number instead of dropping it quietly. An empty
// `confidence` or `new_status` is null, never 0 — "nobody scored this row" and "the server
// answered 0" are different facts, and a redirect map that turned the first into the second would
// invent a status the audit never saw.

import { CSV_HEADER } from './checks/redirects.mjs'

export const REDIRECT_COLUMNS = CSV_HEADER.split(',')

const NUMERIC_COLUMNS = new Set(['confidence', 'new_status'])

// Every record in `text`, as an array of raw field strings. A record is never dropped and a field
// is never trimmed: leading whitespace inside a url is a defect in the file, and hiding it here
// would hide it everywhere.
export function parseCsv(text) {
  const src = typeof text === 'string' ? text.replace(/^﻿/, '') : String(text ?? '')
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  let started = false // this record has at least one field, even if that field is empty

  const endField = () => {
    row.push(field)
    field = ''
    started = true
  }
  const endRecord = () => {
    endField()
    // A record of one empty field is a blank line, which carries nothing.
    if (!(row.length === 1 && row[0] === '')) rows.push(row)
    row = []
    started = false
  }

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch !== '"') {
        field += ch
        continue
      }
      if (src[i + 1] === '"') {
        field += '"'
        i++
        continue
      }
      quoted = false
      continue
    }
    if (ch === '"' && field === '') {
      quoted = true
      started = true
      continue
    }
    if (ch === ',') {
      endField()
      continue
    }
    if (ch === '\r') {
      if (src[i + 1] === '\n') i++
      endRecord()
      continue
    }
    if (ch === '\n') {
      endRecord()
      continue
    }
    field += ch
  }

  // A file with no trailing newline still ends on a record.
  if (quoted || field !== '' || started) endRecord()

  return rows
}

// An empty numeric cell is null, never 0: "nobody scored this row" and "the server answered 0"
// are different facts. A non-numeric value is kept verbatim, so a hand-edited cell shows up as
// what somebody typed rather than as NaN.
function numeric(value) {
  if (value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : value
}

// `{rows, errors}`: the redirect rows the file holds, and one line per thing about the file that
// could not be read. Errors never throw — a bad row on cutover day is a coverage gap to report,
// not a crash that loses the twenty good rows above it.
export function parseRedirectCsv(text) {
  const records = parseCsv(text)
  if (records.length === 0) return { rows: [], errors: ['the redirect csv is empty: it has no header row'] }

  const header = records[0].map((name) => name.trim())
  if (header.join(',') !== REDIRECT_COLUMNS.join(',')) {
    return {
      rows: [],
      errors: [`the redirect csv header is "${header.join(',')}"; expected "${REDIRECT_COLUMNS.join(',')}"`],
    }
  }

  const rows = []
  const errors = []
  for (let i = 1; i < records.length; i++) {
    const record = records[i]
    const line = i + 1
    if (record.length !== REDIRECT_COLUMNS.length) {
      errors.push(`redirect csv line ${line}: ${record.length} fields, expected ${REDIRECT_COLUMNS.length}`)
      continue
    }
    const row = { line }
    REDIRECT_COLUMNS.forEach((column, at) => {
      const raw = record[at]
      row[column] = NUMERIC_COLUMNS.has(column) ? numeric(raw) : raw
    })
    // `old_url` is the only field nothing downstream can work without.
    if (row.old_url === '') {
      errors.push(`redirect csv line ${line}: old_url is empty`)
      continue
    }
    rows.push(row)
  }
  return { rows, errors }
}
