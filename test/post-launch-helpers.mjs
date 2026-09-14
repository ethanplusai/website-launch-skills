// Cutover contexts for the post-launch tests.
//
// Same idea as checks-helpers.mjs: a recorded net, a fake DNS, and the real context builder, so
// every cutover check can be exercised end to end without a socket. The three test-only keys are
// `records` (recordings merged over the fixture), `cert` (what net.cert() resolves to) and
// `across` (a table of `host → [{resolver, a, aaaa, cname, error}]` that stands in for
// dns.resolveAcross; the real one is unit-tested in dns.test.mjs).

import { join } from 'node:path'
import { readFixture, recordedNet, REPO_ROOT } from './helpers.mjs'
import { defaultCert, fakeResolvers, NOW } from './checks-helpers.mjs'
import { createDns } from '../skills/launch-audit/scripts/lib/dns.mjs'
import { buildCutoverContext } from '../skills/post-launch/scripts/lib/cutover.mjs'
import { checks as cutoverChecks } from '../skills/post-launch/scripts/lib/checks/cutover.mjs'

export { NOW, cutoverChecks }

export const GOOD = 'recorded/cutover-good-site.json'
export const BAD = 'recorded/cutover-bad-site.json'
export const PRODUCTION = 'https://new.test/'
export const BASELINE_BEFORE = join(REPO_ROOT, 'test', 'fixtures', 'cutover', 'baseline-before.json')
export const REDIRECTS_BEFORE = join(REPO_ROOT, 'test', 'fixtures', 'cutover', 'redirects-before.csv')

// The answers a fully propagated cutover gets back from the public resolvers. `www` carries the
// realistic shape for a CNAME'd host: the CNAME *and* the A records it resolves to, which is what
// a real resolver returns and what `--expect-dns www=cname.host` has to tolerate.
export const PROPAGATED = {
  'new.test': [
    { resolver: '8.8.8.8', a: ['203.0.113.10'], aaaa: [], cname: null, error: null },
    { resolver: '1.1.1.1', a: ['203.0.113.10'], aaaa: [], cname: null, error: null },
  ],
  'www.new.test': [
    { resolver: '8.8.8.8', a: ['203.0.113.10'], aaaa: [], cname: 'new.test', error: null },
    { resolver: '1.1.1.1', a: ['203.0.113.10'], aaaa: [], cname: 'new.test', error: null },
  ],
}

export const EXPECT_DNS = { apex: ['203.0.113.10'], www: ['new.test'] }

export function cutoverNet(fixture, records = {}) {
  const net = recordedNet({ ...JSON.parse(readFixture(fixture)), ...records })
  net.head = (url) => net.get(url)
  return net
}

export async function cutoverCtx(fixture, options = {}) {
  const { records = {}, cert, across = null, ...rest } = options
  const net = cutoverNet(fixture, records)
  const host = new URL(rest.url ?? PRODUCTION).hostname
  net.cert = async () => (cert === undefined ? defaultCert(host) : cert)
  const dns = createDns(fakeResolvers())
  if (across !== null) dns.resolveAcross = async (name) => across[name] ?? []
  else delete dns.resolveAcross
  return buildCutoverContext({
    net,
    dns,
    options: { url: PRODUCTION, random: () => 'deadbeef', ...rest },
    now: NOW,
  })
}

// Every cutover check, run over one context, in registration order. A check may return
// `Finding[]` or `{findings, notCovered}` — the same pair the runner accepts — and both halves
// come back, because "this check could not look" is an assertion the tests need to make.
export async function cutoverFindings(fixture, options = {}) {
  const ctx = await cutoverCtx(fixture, options)
  const findings = []
  const notCovered = []
  for (const check of cutoverChecks) {
    const produced = await check.run(ctx)
    const isPair = produced !== null && typeof produced === 'object' && !Array.isArray(produced) && Array.isArray(produced.findings)
    if (!Array.isArray(produced) && !isPair) {
      throw new Error(`${check.id}.run() must return an array or { findings, notCovered }`)
    }
    if (isPair) notCovered.push(...(produced.notCovered ?? []))
    for (const finding of isPair ? produced.findings : produced) {
      if (finding.id !== check.id) throw new Error(`${check.id} produced ${finding.id}`)
      findings.push(finding)
    }
  }
  return { ctx, findings, notCovered }
}

export const has = (findings, id) => findings.some((f) => f.id === id)
export const of = (findings, id) => findings.filter((f) => f.id === id)
export const evidenceText = (finding) => finding.evidence.map((e) => `${e.type}:${e.value}`).join(' | ')
export const allEvidence = (findings) => findings.map(evidenceText).join(' || ')
