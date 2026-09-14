// Group 3 — the build, and the directory it was supposed to produce.
//
// These two are the hinge of the gate. Everything in the `output` group reads files that exist
// only because the build wrote them, so a build that failed and a build directory that is not
// there have to be reported as themselves — once, by name — rather than as forty separate
// missing-file findings that bury the actual cause.
//
// The build itself was run by the context, before any of the output was read (see context.mjs).
// This check reads the result; it does not run anything.

import { defineCheck, SkipCheck } from '../../../launch-audit/scripts/lib/registry.mjs'
import { BUILD_DIR_ORDER } from './context.mjs'

const PHASE = 'pre-launch'
const DIMENSION = 'build'
const check = (def) => defineCheck({ phase: PHASE, dimension: DIMENSION, tier: 'repo', severity: 'blocker', ...def })

const text = (value) => ({ type: 'text', value })
const file = (value) => ({ type: 'file', value })

// Forty lines is what a failed build's last error and its stack fit into. The head of a build log
// is progress output; the tail is the reason it stopped.
const STDERR_TAIL_LINES = 40

const tail = (output, lines = STDERR_TAIL_LINES) => String(output ?? '')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .slice(-lines)

const succeeds = check({
  id: 'build.succeeds',
  title: 'The production build failed',
  catches: 'a deploy attempted from a build that never completed',
  run(ctx) {
    if (ctx.build.skipped !== null) throw new SkipCheck(ctx.build.skipped)
    if (ctx.build.code === 0) return []
    const lines = tail(ctx.build.stderr)
    const fallback = tail(ctx.build.stdout)
    const quoted = lines.length > 0 ? lines : fallback
    return [this.mk({
      title: 'The production build failed',
      detail: `${ctx.build.command} exited ${ctx.build.code}`,
      evidence: quoted.length > 0
        ? quoted.map((line) => text(line))
        : [text(`${ctx.build.command} exited ${ctx.build.code} with no output`)],
      fix: 'Fix the build, then run the gate again. Nothing below this line was checked against a build that works.',
    })]
  },
})

const dirFound = check({
  id: 'build.dir-found',
  title: 'No usable build output directory',
  catches: 'an output directory that is missing, or that holds no root index.html for a host to serve',
  run(ctx) {
    if (ctx.buildDirNote !== null) throw new SkipCheck(ctx.buildDirNote)
    if (ctx.buildDir === null) {
      return [this.mk({
        title: 'No build output directory',
        detail: `none of ${BUILD_DIR_ORDER.join(', ')} is a build directory in ${ctx.dir}`,
        evidence: [text(`looked for ${BUILD_DIR_ORDER.join(', ')} (public only counts when it holds an index.html)`)],
        fix: 'Run the production build, or name the output directory with --build-dir.',
      })]
    }
    if (!ctx.fileSet.has('index.html')) {
      return [this.mk({
        title: 'The build directory has no root index.html',
        detail: `${ctx.buildDirName} exists and holds ${ctx.files.length} file${ctx.files.length === 1 ? '' : 's'}, but there is no index.html at its root for a host to serve as the homepage`,
        evidence: [file(`${ctx.buildDirName}/index.html is missing`)],
        fix: 'Check that the build wrote a homepage, and that --build-dir names the directory the host actually serves.',
      })]
    }
    return []
  },
})

export const checks = [succeeds, dirFound]
