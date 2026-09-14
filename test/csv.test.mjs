// The CSV reader, which is the other half of redirects.mjs's writer.
//
// launch-audit writes `redirects.csv`; post-launch reads it back on cutover day and re-requests
// every row. The two have to agree exactly, so the round-trip tests below run the writer's own
// output back through the parser rather than through a hand-typed string.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv, parseRedirectCsv, REDIRECT_COLUMNS } from '../skills/launch-audit/scripts/lib/csv.mjs'
import { toCsv, CSV_HEADER } from '../skills/launch-audit/scripts/lib/checks/redirects.mjs'

test('parseCsv reads plain records separated by CRLF', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']])
})

test('parseCsv accepts bare LF and a file with no trailing newline', () => {
  assert.deepEqual(parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']])
})

test('parseCsv keeps a comma, a newline and a doubled quote inside a quoted field', () => {
  const rows = parseCsv('a,b\r\n"one, two","line\r\nbreak"\r\n"say ""hi""",z\r\n')
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['one, two', 'line\r\nbreak'],
    ['say "hi"', 'z'],
  ])
})

test('parseCsv keeps an empty field rather than dropping it', () => {
  assert.deepEqual(parseCsv('a,,c\r\n'), [['a', '', 'c']])
})

test('parseCsv ignores a UTF-8 byte order mark', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']])
})

test('parseCsv returns no records for empty text', () => {
  assert.deepEqual(parseCsv(''), [])
  assert.deepEqual(parseCsv('\r\n'), [])
})

test('the redirect columns are exactly the ones the audit writes', () => {
  assert.equal(REDIRECT_COLUMNS.join(','), CSV_HEADER)
})

test('parseRedirectCsv reads a row the audit wrote, confidence as a number', () => {
  const csv = toCsv([{
    old_url: 'https://old.test/a', status_on_new: 'would-404', final_url: 'https://new.test/a',
    recommendation: 'redirect to /about, maybe', confidence: 0.82, new_status: 404,
  }])
  const { rows, errors } = parseRedirectCsv(csv)
  assert.deepEqual(errors, [])
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0], {
    old_url: 'https://old.test/a',
    status_on_new: 'would-404',
    final_url: 'https://new.test/a',
    recommendation: 'redirect to /about, maybe',
    confidence: 0.82,
    new_status: 404,
    line: 2,
  })
})

test('parseRedirectCsv reports an empty confidence and status as null, not as zero', () => {
  const { rows } = parseRedirectCsv(`${CSV_HEADER}\r\nhttps://old.test/,same-path-200,https://new.test/,,,\r\n`)
  assert.equal(rows[0].confidence, null)
  assert.equal(rows[0].new_status, null)
})

test('parseRedirectCsv refuses a file whose header is not the redirect header', () => {
  const { rows, errors } = parseRedirectCsv('url,status\r\nhttps://old.test/,200\r\n')
  assert.deepEqual(rows, [])
  assert.equal(errors.length, 1)
  assert.match(errors[0], /header/)
})

test('parseRedirectCsv names the line of a row with the wrong number of fields', () => {
  const { rows, errors } = parseRedirectCsv(`${CSV_HEADER}\r\nhttps://old.test/,same-path-200\r\n`)
  assert.deepEqual(rows, [])
  assert.equal(errors.length, 1)
  assert.match(errors[0], /line 2/)
})

test('parseRedirectCsv on an empty file says the file has no header', () => {
  const { rows, errors } = parseRedirectCsv('')
  assert.deepEqual(rows, [])
  assert.match(errors[0], /header/)
})
