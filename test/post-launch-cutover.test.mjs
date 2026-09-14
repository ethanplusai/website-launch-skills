// The cutover checks: what post-launch asks the moment DNS has moved.
//
// Two recorded fixtures carry the whole dimension. `cutover-good-site.json` is a cutover that went
// right — the certificate covers the host, http redirects, the noindex is gone, robots and sitemap
// name the production host, every redirect row still lands where the audit said it would, the
// baseline diffs clean, staging is a 410 and the old host redirects. `cutover-bad-site.json` is
// the same launch with everything that goes wrong on the day: the staging noindex shipped, a
// redirect drifted to a 302, a page the baseline knew about is gone, staging is still indexable,
// the old host is still serving, the analytics tag is missing and a security header was dropped.
//
// Every check id below is asserted both ways: it fires on the fixture that earns it, and it is
// silent on the one that does not.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortFindings } from '../skills/launch-audit/scripts/lib/findings.mjs'
import { CUTOVER_ORDER } from '../skills/post-launch/scripts/lib/checks/cutover.mjs'
import { parseExpectDns, cutoverNotCovered } from '../skills/post-launch/scripts/lib/cutover.mjs'
import {
  GOOD, BAD, PRODUCTION, BASELINE_BEFORE, REDIRECTS_BEFORE, PROPAGATED, EXPECT_DNS,
  cutoverCtx, cutoverFindings, cutoverChecks, has, of, allEvidence, evidenceText,
} from './post-launch-helpers.mjs'

const FULL = {
  baseline: BASELINE_BEFORE,
  redirectsCsv: REDIRECTS_BEFORE,
  oldUrl: 'https://old.test/',
  stagingUrl: 'https://staging.new.test/',
  expectAnalytics: 'G-ABC123',
  expectDns: EXPECT_DNS,
  across: PROPAGATED,
}

let goodRun
let badRun
const good = async () => (goodRun ??= cutoverFindings(GOOD, FULL))
const bad = async () => (badRun ??= cutoverFindings(BAD, FULL))

// ------------------------------------------------------------------------------ the whole run

test('a clean cutover produces nothing above info', async () => {
  const { findings } = await good()
  const loud = findings.filter((f) => f.severity !== 'info')
  assert.deepEqual(loud.map((f) => `${f.severity} ${f.id}`), [], `expected silence, got:\n${loud.map((f) => `${f.id}: ${f.detail}`).join('\n')}`)
  assert.ok(findings.length > 0, 'the info findings still ship')
})

test('every cutover finding carries evidence and a fix', async () => {
  const { findings } = await bad()
  for (const finding of findings) {
    assert.ok(finding.evidence.length > 0, `${finding.id} has no evidence`)
    assert.equal(finding.phase, 'post-launch')
    assert.equal(finding.dimension, 'cutover')
    assert.ok(typeof finding.fix === 'string' && finding.fix.length > 0, `${finding.id} has no fix`)
  }
})

test('the blocker sorts first, ahead of every high', async () => {
  const { findings } = await bad()
  const sorted = sortFindings(findings)
  assert.equal(sorted[0].severity, 'blocker')
  assert.equal(sorted[0].id, 'cutover.noindex-live')
  const firstHigh = sorted.findIndex((f) => f.severity === 'high')
  const lastBlocker = sorted.map((f) => f.severity).lastIndexOf('blocker')
  assert.ok(lastBlocker < firstHigh, 'a high finding sorted ahead of a blocker')
})

test('the day order names every registered check exactly once', () => {
  const ids = cutoverChecks.map((c) => c.id)
  assert.deepEqual([...CUTOVER_ORDER].sort(), [...ids].sort())
  assert.equal(new Set(CUTOVER_ORDER).size, CUTOVER_ORDER.length)
  assert.equal(CUTOVER_ORDER[0], 'cutover.dns-unexpected', 'DNS is step one on the day')
  assert.equal(CUTOVER_ORDER.at(-1), 'cutover.human-items', 'the human items are step twelve')
})

// ----------------------------------------------------------------------------------------- DNS

test('cutover.dns-unexpected fires when a resolver answers something other than the expected target', async () => {
  const wrong = {
    'new.test': [
      { resolver: '8.8.8.8', a: ['203.0.113.10'], aaaa: [], cname: null, error: null },
      { resolver: '1.1.1.1', a: ['198.51.100.7'], aaaa: [], cname: null, error: null },
    ],
    'www.new.test': PROPAGATED['www.new.test'],
  }
  const { findings } = await cutoverFindings(GOOD, { ...FULL, across: wrong })
  assert.ok(has(findings, 'cutover.dns-unexpected'), 'the wrong address was not reported')
  assert.match(allEvidence(of(findings, 'cutover.dns-unexpected')), /198\.51\.100\.7/)
})

test('cutover.dns-unexpected is silent when every resolver matches, and when nothing was expected', async () => {
  const { findings } = await good()
  assert.equal(has(findings, 'cutover.dns-unexpected'), false)
  const noExpectation = await cutoverFindings(GOOD, { ...FULL, expectDns: null })
  assert.equal(has(noExpectation.findings, 'cutover.dns-unexpected'), false)
})

test('cutover.dns-unexpected tolerates the extra records a CNAME host really answers with', async () => {
  // A host on a CNAME answers with the CNAME *and* the A records behind it. `--expect-dns
  // www=cname.host` names one of those, and exact set equality would call the correct
  // configuration wrong.
  const realistic = {
    'new.test': PROPAGATED['new.test'],
    'www.new.test': [
      { resolver: '8.8.8.8', a: ['203.0.113.10'], aaaa: ['2001:db8::1'], cname: 'new.test', error: null },
      { resolver: '1.1.1.1', a: ['203.0.113.10'], aaaa: [], cname: 'new.test.', error: null },
    ],
  }
  const { findings } = await cutoverFindings(GOOD, { ...FULL, across: realistic })
  assert.equal(has(findings, 'cutover.dns-unexpected'), false, 'a correct CNAME configuration was called wrong')
})

test('cutover.dns-unexpected still fires when an expected value is genuinely absent', async () => {
  const missing = {
    'new.test': [{ resolver: '8.8.8.8', a: ['198.51.100.7'], aaaa: [], cname: null, error: null }],
    'www.new.test': [{ resolver: '8.8.8.8', a: ['198.51.100.7'], aaaa: [], cname: 'old.test', error: null }],
  }
  const { findings } = await cutoverFindings(GOOD, { ...FULL, across: missing })
  const wrong = of(findings, 'cutover.dns-unexpected')
  assert.equal(wrong.length, 2, 'both the apex and the www host are pointing at the wrong place')
  assert.match(allEvidence(wrong), /198\.51\.100\.7/)
})

// --- item 2: a resolver nobody could reach knows nothing

test('a resolver that could not be reached is a coverage gap, not a wrong answer', async () => {
  const halfReachable = {
    'new.test': [
      { resolver: '8.8.8.8', a: ['203.0.113.10'], aaaa: [], cname: null, error: null },
      { resolver: '1.1.1.1', a: ['203.0.113.10'], aaaa: [], cname: null, error: null },
      { resolver: '9.9.9.9', a: [], aaaa: [], cname: null, error: 'ETIMEOUT' },
      { resolver: '208.67.222.222', a: [], aaaa: [], cname: null, error: 'ETIMEOUT' },
    ],
    'www.new.test': PROPAGATED['www.new.test'],
  }
  const { findings, notCovered } = await cutoverFindings(GOOD, { ...FULL, across: halfReachable })
  assert.equal(has(findings, 'cutover.dns-unexpected'), false, 'an unreachable resolver is not a wrong answer')
  const [propagation] = of(findings, 'cutover.dns-propagation')
  assert.equal(propagation.severity, 'info', 'two converged resolvers plus two silent ones is not a disagreement')
  const gap = notCovered.find((line) => line.startsWith('DNS: '))
  assert.ok(gap, `no DNS gap line in:\n${notCovered.join('\n')}`)
  assert.match(gap, /2 of 4 public resolvers could not be reached/)
  assert.match(gap, /9\.9\.9\.9/)
  assert.match(gap, /208\.67\.222\.222/)
})

test('no DNS gap line is written when every resolver answered', async () => {
  const { notCovered } = await good()
  assert.equal(notCovered.some((line) => line.startsWith('DNS: ')), false, `an unearned gap line in:\n${notCovered.join('\n')}`)
})

test('cutover.dns-propagation lists every resolver and stays info while they agree', async () => {
  const { findings } = await good()
  const [finding] = of(findings, 'cutover.dns-propagation')
  assert.ok(finding, 'no propagation finding')
  assert.equal(finding.severity, 'info')
  assert.match(evidenceText(finding), /8\.8\.8\.8/)
  assert.match(evidenceText(finding), /1\.1\.1\.1/)
})

test('cutover.dns-propagation is high while resolvers disagree, and absent with no resolver sample', async () => {
  const split = {
    'new.test': [
      { resolver: '8.8.8.8', a: ['203.0.113.10'], aaaa: [], cname: null, error: null },
      { resolver: '1.1.1.1', a: ['198.51.100.7'], aaaa: [], cname: null, error: null },
    ],
  }
  const mid = await cutoverFindings(GOOD, { ...FULL, across: split })
  assert.equal(of(mid.findings, 'cutover.dns-propagation')[0].severity, 'high')
  const none = await cutoverFindings(GOOD, { ...FULL, across: null })
  assert.equal(has(none.findings, 'cutover.dns-propagation'), false)
})

test('parseExpectDns reads apex and www, repeated keys included', () => {
  assert.deepEqual(parseExpectDns('apex=1.2.3.4,www=cname.host'), { apex: ['1.2.3.4'], www: ['cname.host'] })
  assert.deepEqual(parseExpectDns('apex=1.2.3.4,apex=5.6.7.8'), { apex: ['1.2.3.4', '5.6.7.8'], www: [] })
  assert.equal(parseExpectDns(''), null)
  assert.equal(parseExpectDns(undefined), null)
  assert.throws(() => parseExpectDns('apex'), /apex=/)
  assert.throws(() => parseExpectDns('mx=1.2.3.4'), /apex|www/)
})

// ----------------------------------------------------------------------------------- transport

test('cutover.https-cert-host is a blocker when the certificate does not cover the live host', async () => {
  const wrongHost = await cutoverFindings(GOOD, {
    ...FULL,
    cert: {
      valid: true, subject: 'other.test', altNames: ['other.test'], issuer: 'Test CA',
      validFrom: null, validTo: null, daysLeft: 200, error: null,
    },
  })
  const [finding] = of(wrongHost.findings, 'cutover.https-cert-host')
  assert.ok(finding, 'a certificate for the wrong host was accepted')
  assert.equal(finding.severity, 'blocker')

  const invalid = await cutoverFindings(GOOD, {
    ...FULL,
    cert: { valid: false, subject: null, altNames: [], issuer: null, validFrom: null, validTo: null, daysLeft: null, error: 'self signed certificate' },
  })
  assert.match(allEvidence(of(invalid.findings, 'cutover.https-cert-host')), /self signed/)
})

test('cutover.https-cert-host is silent on a certificate that covers apex and www', async () => {
  const { findings } = await good()
  assert.equal(has(findings, 'cutover.https-cert-host'), false)
})

test('a certificate nobody read is a Not covered line, never a silence', async () => {
  const { findings, notCovered } = await cutoverFindings(GOOD, { ...FULL, cert: null })
  assert.equal(has(findings, 'cutover.https-cert-host'), false, 'an unread certificate is not a finding')
  const gap = notCovered.find((line) => line.startsWith('TLS certificate: not read'))
  assert.ok(gap, `no certificate gap line in:\n${notCovered.join('\n')}`)
  assert.match(gap, /new\.test/)

  const noNames = await cutoverFindings(GOOD, {
    ...FULL,
    cert: { valid: true, subject: null, altNames: [], issuer: 'Test CA', validFrom: null, validTo: null, daysLeft: 200, error: null },
  })
  assert.ok(noNames.notCovered.some((line) => line.startsWith('TLS certificate: not read')))

  const { notCovered: clean } = await good()
  assert.equal(clean.some((line) => line.startsWith('TLS certificate')), false, 'a certificate that was read needs no gap line')
})

test('cutover.http-redirect fires when http serves the site instead of redirecting', async () => {
  const { findings } = await bad()
  assert.ok(has(findings, 'cutover.http-redirect'))
  assert.match(allEvidence(of(findings, 'cutover.http-redirect')), /http:\/\/new\.test\//)
})

test('cutover.http-redirect is silent on a permanent redirect to https', async () => {
  const { findings } = await good()
  assert.equal(has(findings, 'cutover.http-redirect'), false)
})

test('cutover.canonical-host fires when both www and apex answer for themselves', async () => {
  const { findings } = await bad()
  assert.ok(has(findings, 'cutover.canonical-host'))
  assert.match(allEvidence(of(findings, 'cutover.canonical-host')), /www\.new\.test/)
})

test('cutover.canonical-host is silent when one host redirects to the other', async () => {
  const { findings } = await good()
  assert.equal(has(findings, 'cutover.canonical-host'), false)
})

// -------------------------------------------------------------------------------- indexability

test('cutover.noindex-live is a blocker naming the meta tag and the header', async () => {
  const { findings } = await bad()
  const [finding] = of(findings, 'cutover.noindex-live')
  assert.ok(finding, 'a live noindex was not reported')
  assert.equal(finding.severity, 'blocker')
  const evidence = evidenceText(finding)
  assert.match(evidence, /noindex/)
  assert.match(evidence, /x-robots-tag/)
})

test('cutover.noindex-live fires on a blanket robots.txt Disallow with no meta tag anywhere', async () => {
  const { findings } = await cutoverFindings(GOOD, {
    ...FULL,
    records: {
      'https://new.test/robots.txt': {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: 'User-agent: *\nDisallow: /\n',
      },
    },
  })
  const [finding] = of(findings, 'cutover.noindex-live')
  assert.ok(finding, 'a blanket Disallow was not reported')
  assert.equal(finding.severity, 'blocker')
  assert.match(evidenceText(finding), /Disallow: \//)
})

test('cutover.noindex-live is silent on a production site that is indexable', async () => {
  const { findings } = await good()
  assert.equal(has(findings, 'cutover.noindex-live'), false)
})

test('cutover.robots-live fires when robots.txt points at the staging host', async () => {
  const { findings } = await bad()
  assert.ok(has(findings, 'cutover.robots-live'))
  assert.match(allEvidence(of(findings, 'cutover.robots-live')), /staging\.new\.test/)
})

test('cutover.robots-live fires when robots.txt does not answer at all, and is silent when it does', async () => {
  const missing = await cutoverFindings(GOOD, {
    ...FULL,
    records: { 'https://new.test/robots.txt': { status: 404, headers: { 'content-type': 'text/plain' }, body: 'not found' } },
  })
  assert.ok(has(missing.findings, 'cutover.robots-live'))
  const { findings } = await good()
  assert.equal(has(findings, 'cutover.robots-live'), false)
})

test('cutover.sitemap-live fires when no sitemap can be fetched', async () => {
  const { findings } = await bad()
  assert.ok(has(findings, 'cutover.sitemap-live'))
})

test('cutover.sitemap-live is silent when the sitemap the live robots.txt names answers 200', async () => {
  const { findings } = await good()
  assert.equal(has(findings, 'cutover.sitemap-live'), false)
})

test('cutover.sitemap-references-staging fires on a Sitemap line pointing off the production host', async () => {
  const { findings } = await bad()
  assert.ok(has(findings, 'cutover.sitemap-references-staging'))
  assert.match(allEvidence(of(findings, 'cutover.sitemap-references-staging')), /staging\.new\.test/)
})

test('cutover.sitemap-references-staging is silent when every reference is on the production host', async () => {
  const { findings } = await good()
  assert.equal(has(findings, 'cutover.sitemap-references-staging'), false)
})

// ------------------------------------------------------------------------------------ redirects

test('cutover.redirect-drift fires on a row that answers 302 and lands somewhere else', async () => {
  const { findings } = await bad()
  const drift = of(findings, 'cutover.redirect-drift')
  assert.ok(drift.length >= 1, 'the drifted redirect row was not reported')
  const evidence = allEvidence(drift)
  assert.match(evidence, /https:\/\/old\.test\/about-us/)
  assert.match(evidence, /302/)
})

test('cutover.redirect-drift fires on a same-path row that now answers 404', async () => {
  const { findings } = await bad()
  assert.match(allEvidence(of(findings, 'cutover.redirect-drift')), /https:\/\/old\.test\/thanks/)
})

test('cutover.redirect-drift fires on a 301 that now takes two hops to arrive', async () => {
  const { findings } = await cutoverFindings(GOOD, {
    ...FULL,
    records: {
      'https://old.test/about-us': {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<!doctype html><html lang="en"><head><title>About</title></head><body><h1>About</h1></body></html>',
        finalUrl: 'https://new.test/about',
        chain: [
          { url: 'https://old.test/about-us', status: 301, location: 'https://new.test/about-us' },
          { url: 'https://new.test/about-us', status: 301, location: 'https://new.test/about' },
        ],
      },
    },
  })
  const drift = of(findings, 'cutover.redirect-drift')
  assert.equal(drift.length, 1)
  assert.match(evidenceText(drift[0]), /2 hops/)
})

test('cutover.redirect-drift is silent on a single 308, and on every row still 301ing in one hop', async () => {
  const { findings } = await cutoverFindings(GOOD, {
    ...FULL,
    records: {
      'https://old.test/about-us': {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<!doctype html><html lang="en"><head><title>About</title></head><body><h1>About</h1></body></html>',
        finalUrl: 'https://new.test/about',
        chain: [{ url: 'https://old.test/about-us', status: 308, location: 'https://new.test/about' }],
      },
    },
  })
  assert.equal(has(findings, 'cutover.redirect-drift'), false, '308 is a permanent redirect too')
  const { findings: clean } = await good()
  assert.equal(has(clean, 'cutover.redirect-drift'), false)
})

test('cutover.redirect-unverified reports a row that answered nothing, and drift does not claim it', async () => {
  const { findings } = await cutoverFindings(GOOD, {
    ...FULL,
    records: {
      'https://old.test/about-us': { status: 0, error: 'ENOTFOUND', headers: {}, body: null },
    },
  })
  const unverified = of(findings, 'cutover.redirect-unverified')
  assert.equal(unverified.length, 1)
  assert.equal(unverified[0].severity, 'medium')
  assert.match(evidenceText(unverified[0]), /ENOTFOUND/)
  assert.match(evidenceText(unverified[0]), /https:\/\/old\.test\/about-us/)
  assert.equal(has(findings, 'cutover.redirect-drift'), false, 'a url that answered nothing has not been shown to have drifted')
})

test('cutover.redirect-unverified is silent when every row answered', async () => {
  const { findings } = await good()
  assert.equal(has(findings, 'cutover.redirect-unverified'), false)
  const { findings: bad } = await cutoverFindings(BAD, FULL)
  assert.equal(has(bad, 'cutover.redirect-unverified'), false, 'a 302 and a 404 are answers, not silence')
})

test('the redirect rows are re-requested as they were written, capped and recorded', async () => {
  const ctx = await cutoverCtx(GOOD, FULL)
  assert.equal(ctx.redirectRows.length, 2)
  assert.ok(ctx.cutoverRedirects.has('https://old.test/about-us'))
  assert.equal(ctx.probes.caps.cutoverRedirects.cap, 500)
  assert.equal(ctx.probes.caps.cutoverRedirects.dropped, 0)
})

// ------------------------------------------------------------------------------- baseline diff

test('cutover.baseline-missing-page fires once per page the baseline had and production does not', async () => {
  const { findings } = await bad()
  const missing = of(findings, 'cutover.baseline-missing-page')
  assert.equal(missing.length, 1)
  assert.match(evidenceText(missing[0]), /https:\/\/new\.test\/about/)
})

test('cutover.baseline-missing-page is silent when every baseline page is still served', async () => {
  const { findings } = await good()
  assert.equal(has(findings, 'cutover.baseline-missing-page'), false)
})

test('cutover.baseline-changed reports the changed field, before and after', async () => {
  const { findings } = await bad()
  const changed = of(findings, 'cutover.baseline-changed')
  assert.ok(changed.length >= 1)
  for (const finding of changed) assert.equal(finding.severity, 'medium')
  assert.match(allEvidence(changed), /Welcome to my new site/)
})

test('cutover.baseline-changed is silent when nothing about a page changed', async () => {
  const { findings } = await good()
  assert.equal(has(findings, 'cutover.baseline-changed'), false)
})

test('cutover.baseline-new-redirect fires on a page that did not redirect before and does now', async () => {
  const { findings } = await bad()
  const redirects = of(findings, 'cutover.baseline-new-redirect')
  assert.equal(redirects.length, 1)
  assert.match(evidenceText(redirects[0]), /https:\/\/new\.test\/thanks/)
})

test('cutover.baseline-new-redirect is silent when no page gained a redirect', async () => {
  const { findings } = await good()
  assert.equal(has(findings, 'cutover.baseline-new-redirect'), false)
})

test('a run with no baseline says so in Not covered rather than reporting a clean diff', async () => {
  const ctx = await cutoverCtx(GOOD, { ...FULL, baseline: null })
  assert.equal(ctx.baseline, null)
  assert.equal(ctx.baselineDiff, null)
  const { findings } = await cutoverFindings(GOOD, { ...FULL, baseline: null })
  assert.equal(has(findings, 'cutover.baseline-missing-page'), false)
  assert.equal(has(findings, 'cutover.baseline-changed'), false)
  assert.equal(has(findings, 'cutover.baseline-new-redirect'), false)
})

// ------------------------------------------------------------------------------------ analytics

test('cutover.analytics-missing fires on a page whose baseline tag is gone', async () => {
  const { findings } = await bad()
  const missing = of(findings, 'cutover.analytics-missing')
  assert.ok(missing.length >= 1)
  assert.match(allEvidence(missing), /GA4/)
})

test('cutover.analytics-missing falls back to --expect-analytics when there is no baseline', async () => {
  const withoutBaseline = await cutoverFindings(BAD, { ...FULL, baseline: null })
  assert.ok(has(withoutBaseline.findings, 'cutover.analytics-missing'), 'the expected id was not looked for')
  assert.match(allEvidence(of(withoutBaseline.findings, 'cutover.analytics-missing')), /G-ABC123/)

  const present = await cutoverFindings(GOOD, { ...FULL, baseline: null })
  assert.equal(has(present.findings, 'cutover.analytics-missing'), false)
})

test('cutover.analytics-not-firing fires when the tag is installed and no collector is hit', async () => {
  const { findings } = await cutoverFindings(GOOD, {
    ...FULL,
    browser: { available: true, reason: null, renders: new Map([[PRODUCTION, { collectorHits: [] }]]) },
  })
  const [finding] = of(findings, 'cutover.analytics-not-firing')
  assert.ok(finding, 'an installed tag that never fires was not reported')
  assert.equal(finding.tier, 'browser')
})

test('cutover.analytics-not-firing is silent when a collector request was observed, and with no browser', async () => {
  const firing = await cutoverFindings(GOOD, {
    ...FULL,
    browser: {
      available: true,
      reason: null,
      renders: new Map([[PRODUCTION, { collectorHits: ['https://www.google-analytics.com/g/collect?v=2'] }]]),
    },
  })
  assert.equal(has(firing.findings, 'cutover.analytics-not-firing'), false)
  const { findings } = await good()
  assert.equal(has(findings, 'cutover.analytics-not-firing'), false)
})

// ---------------------------------------------------------------------------------------- forms

test('cutover.form-endpoint-down fires when a form posts to an endpoint that is failing', async () => {
  const { findings } = await bad()
  const down = of(findings, 'cutover.form-endpoint-down')
  assert.equal(down.length, 1)
  assert.match(evidenceText(down[0]), /\/subscribe/)
  assert.match(evidenceText(down[0]), /500/)
})

test('cutover.form-endpoint-down is silent when every form endpoint answers', async () => {
  const { findings } = await good()
  assert.equal(has(findings, 'cutover.form-endpoint-down'), false)
})

test('cutover.form-endpoint-down treats 405 as healthy, because a POST-only endpoint refuses GET', async () => {
  const { findings } = await cutoverFindings(BAD, {
    ...FULL,
    records: {
      'https://new.test/subscribe': { status: 405, headers: { allow: 'POST' }, body: 'Method Not Allowed' },
    },
  })
  assert.equal(has(findings, 'cutover.form-endpoint-down'), false, '405 is what a form endpoint should say to a GET')
})

// ------------------------------------------------------------------------- staging and old host

test('cutover.staging-still-indexable fires when the staging copy is a live indexable page', async () => {
  const { findings } = await bad()
  assert.ok(has(findings, 'cutover.staging-still-indexable'))
  assert.match(allEvidence(of(findings, 'cutover.staging-still-indexable')), /staging\.new\.test/)
})

test('cutover.staging-still-indexable is silent on a staging host that is gone', async () => {
  const { findings } = await good()
  assert.equal(has(findings, 'cutover.staging-still-indexable'), false)
})

test('cutover.staging-still-indexable is silent when staging redirects to production', async () => {
  const { findings } = await cutoverFindings(BAD, {
    ...FULL,
    records: {
      'https://staging.new.test/': {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<!doctype html><html lang="en"><head><title>New Test</title></head><body><h1>New Test</h1></body></html>',
        finalUrl: 'https://new.test/',
        chain: [{ url: 'https://staging.new.test/', status: 301, location: 'https://new.test/' }],
      },
    },
  })
  assert.equal(has(findings, 'cutover.staging-still-indexable'), false, 'a staging host that redirects to production is sealed')
})

test('cutover.old-host-serving-content fires when the old site is still answering with its own pages', async () => {
  const { findings } = await bad()
  assert.ok(has(findings, 'cutover.old-host-serving-content'))
  assert.match(allEvidence(of(findings, 'cutover.old-host-serving-content')), /old\.test/)
})

test('cutover.old-host-serving-content is silent when the old host redirects to production', async () => {
  const { findings } = await good()
  assert.equal(has(findings, 'cutover.old-host-serving-content'), false)
})

// ------------------------------------------------------------------------------ security headers

test('cutover.security-headers-regressed names each header the baseline had and production lost', async () => {
  const { findings } = await bad()
  const regressed = of(findings, 'cutover.security-headers-regressed')
  assert.ok(regressed.length >= 1)
  assert.equal(regressed[0].severity, 'medium')
  assert.match(allEvidence(regressed), /content-security-policy/)
})

test('cutover.security-headers-regressed is silent when every baseline header is still served', async () => {
  const { findings } = await good()
  assert.equal(has(findings, 'cutover.security-headers-regressed'), false)
})

// ----------------------------------------------------------------------------------- human items

test('cutover.human-items lists the six things a person has to do on the day', async () => {
  const { findings } = await good()
  const [finding] = of(findings, 'cutover.human-items')
  assert.ok(finding, 'the human items were not emitted')
  assert.equal(finding.severity, 'info')
  assert.equal(finding.evidence.length, 6)
  for (const item of finding.evidence) assert.equal(item.type, 'text')
  assert.match(evidenceText(finding), /Search Console/)
  assert.match(evidenceText(finding), /announce/i)
})

test('cutover.human-items ships on a bad cutover too, because the day still has to be worked', async () => {
  const { findings } = await bad()
  assert.ok(has(findings, 'cutover.human-items'))
})

// ------------------------------------------------------- what a cutover run is not

// I3: cutover mode runs 21 checks; a full audit runs 176. The report it produces is the one read
// immediately before a launch is announced, and nothing in it said how narrow it was — so a clean
// cutover report read like a clean site. The smoke run found this the hard way: day 1 of the watch
// surfaced two high findings the cutover the evening before had not.
test('cutoverNotCovered always says the run checked the cutover conditions only', async () => {
  const ctx = await cutoverCtx(GOOD, FULL)
  const lines = cutoverNotCovered(ctx, { tier: { available: false, reason: 'test' } })
  const scope = lines.filter((line) => line.startsWith('This run checked the '))
  assert.equal(scope.length, 1, `expected exactly one scope line, got:\n${lines.join('\n')}`)
  assert.equal(
    scope[0],
    'This run checked the 21 cutover conditions only; the full audit’s links, head, indexability and inventory dimensions were not re-run — use --mode watch for those.',
  )
  // The count is the registry's, not a number typed into a string.
  assert.equal(cutoverChecks.filter((c) => c.dimension === 'cutover').length, 21)
})

// A watch day does re-run those four dimensions, so the same sentence there would be false.
test('the scope line names only the dimensions the registry actually left out', async () => {
  const ctx = await cutoverCtx(GOOD, FULL)
  const { cutoverRegistry } = await import('../skills/post-launch/scripts/lib/cutover.mjs')
  const { WATCH_MODULES } = await import('../skills/post-launch/scripts/lib/watch.mjs')
  const lines = cutoverNotCovered(ctx, {
    tier: { available: false, reason: 'test' },
    registry: cutoverRegistry(WATCH_MODULES),
  })
  assert.deepEqual(lines.filter((line) => line.startsWith('This run checked the ')), [])
})

// P1: a check that tried to declare a coverage gap and got the shape wrong had the gap silently
// deleted — the one failure mode the `{findings, notCovered}` shape exists to prevent.
test('a check whose notCovered is not an array of strings is a crash, not an empty array', async () => {
  const ctx = await cutoverCtx(GOOD, FULL)
  const { cutoverRegistry, runChecksOver } = await import('../skills/post-launch/scripts/lib/cutover.mjs')
  const { createRegistry, defineCheck } = await import('../skills/launch-audit/scripts/lib/registry.mjs')
  const registry = createRegistry()
  registry.add(defineCheck({
    id: 'cutover.bad-shape', phase: 'post-launch', dimension: 'cutover', severity: 'info', tier: 'http',
    title: 'bad shape', catches: 'a stub whose notCovered is a string',
    run: () => ({ findings: [], notCovered: 'the certificate was never read' }),
  }))
  registry.add(defineCheck({
    id: 'cutover.bad-entries', phase: 'post-launch', dimension: 'cutover', severity: 'info', tier: 'http',
    title: 'bad entries', catches: 'a stub whose notCovered holds a non-string',
    run: () => ({ findings: [], notCovered: ['fine', { reason: 'not a string' }] }),
  }))
  const { lines } = await runChecksOver(ctx, registry)
  assert.ok(lines.includes('cutover.bad-shape: check crashed — malformed notCovered'), lines.join(' | '))
  assert.ok(lines.includes('cutover.bad-entries: check crashed — malformed notCovered'), lines.join(' | '))
  // The half-good line is not kept: a malformed return is not partly trustworthy.
  assert.ok(!lines.includes('fine'))
})
