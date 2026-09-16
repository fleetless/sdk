#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * The commit messages in a range carry nothing internal.
 *
 * This history is treated as public from the moment it is pushed — there is
 * no sweep afterwards, and the public repository created from it later
 * carries forward whatever this one enforced. The constraint has been
 * written down for a while; the enforcement had not,
 * and a message written *under* it already carried a sibling repository's file
 * path and a CI pipeline number.
 *
 * The patterns are `scripts/internal-markers.mjs`, the same ones the published
 * bytes are held to. A second copy would be a second policy, and the weaker one
 * always wins.
 *
 * **What a commit message is allowed to say that a source file is not.** A
 * message describes the repository it lands in, so the stance classes are its
 * own voice and are left alone — the set is named in `COMMIT_EXTRA_STANCE`. A
 * path into a sibling repository is not its own voice, and neither is anything
 * in the MARKER half.
 *
 * Usage:
 *   node scripts/verify-commit-messages.mjs                 # origin/main..HEAD
 *   node scripts/verify-commit-messages.mjs <range>         # any git range
 * In CI the range comes from `CI_COMMIT_BEFORE_SHA..CI_COMMIT_SHA`, and a
 * first push (all-zeros before-sha) falls back to the default branch.
 *
 * **What makes this fail**: put a hostname, a wave label, a pipeline number or
 * a sibling-repository path into a commit message in the range. Verified by
 * doing exactly that.
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { COMMIT_EXTRA_STANCE, detectors, hitsIn } from './internal-markers.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ZERO = '0000000000000000000000000000000000000000'

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trimEnd()

/**
 * The range this run is about, and the honest answer when there is no range.
 *
 * **A tag pipeline has no pushed range**, and an earlier shape of this
 * function pretended otherwise: it fell back to the runner's `origin/main`,
 * which in a CI checkout is whatever that shallow clone happened to fetch. On
 * the first tag it ran on, that was twenty commits of history written long
 * before the constraint existed, and the job failed on all of them. The check
 * was right about every line it printed and wrong about what it had been
 * asked.
 *
 * So each case is named rather than approximated:
 *
 * | situation | range |
 * |---|---|
 * | an argument was given | that argument |
 * | a branch push (`CI_COMMIT_BEFORE_SHA` is a real sha) | exactly what was pushed |
 * | a tag pipeline | the tagged commit alone — a tag names a commit, not a range |
 * | a first push (`CI_COMMIT_BEFORE_SHA` is all zeros) | the new commit alone, for the same reason |
 * | a before-sha or `head~1` that does not resolve (history was reset) | every commit this checkout has |
 * | locally | `origin/main..HEAD`, which is what a developer is about to push |
 *
 * **A real before-sha is not proof the range resolves.** A force-push that
 * replaces a branch's history wholesale still leaves GitHub reporting the old
 * tip as `CI_COMMIT_BEFORE_SHA` — reachable from nothing a fresh checkout
 * fetches, so `before..head` dies with `fatal: Invalid revision range` rather
 * than reporting cleanly. The same gap sits under the tag/first-push
 * fallback: a root commit's `head~1` does not resolve either. Both are
 * checked before use; failing that, this falls back to every commit the
 * checkout actually has (`git rev-list head`, no `..`), which is exactly the
 * one commit a reset history leaves behind.
 *
 * **The residual, stated rather than closed**: this governs messages written
 * from here on. It says nothing about the history behind the range it is
 * given, and it is not the thing that makes that history safe to publish.
 */
function defaultRange() {
  if (process.argv[2]) return process.argv[2]
  const before = process.env.CI_COMMIT_BEFORE_SHA
  const head = process.env.CI_COMMIT_SHA
  // `rev-parse --verify` alone accepts a full-length hex string on syntax and
  // never touches the object database — `^{commit}` forces the lookup that
  // actually distinguishes a resolvable sha from a plausible-looking one.
  const resolves = (rev) => {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { cwd: ROOT })
      return true
    } catch {
      return false
    }
  }
  if (head && before && before !== ZERO && !/^0+$/.test(before) && resolves(before)) return `${before}..${head}`
  if (head && resolves(`${head}~1`)) return `${head}~1..${head}`
  if (head) return head
  return 'origin/main..HEAD'
}

const range = defaultRange()
const shas = git('rev-list', range).split('\n').filter(Boolean)

console.log(`== commit messages in ${range} (${shas.length}) ==`)

// **An empty range is not a clean range, and must not print like one.** On a
// tag pipeline the tag usually sits on the tip of the default branch, so
// `origin/main..HEAD` is empty and every assertion below would be free while
// the summary line said the messages were checked. Say which of the two
// happened; the exit code is still 0, because a range with no commits in it is
// not a failure.
if (shas.length === 0) {
  console.log(`  no commits in ${range} — nothing was checked, and nothing is claimed about the history`)
  process.exit(0)
}

const active = detectors('sdk').filter((d) => !d.stance || COMMIT_EXTRA_STANCE.has(d.name))
// Anti-vacuity for the detector set: a filter that matched nothing would report
// zero hits over zero patterns and print the same line as a clean range.
if (active.length < 12) {
  console.error(`✗ only ${active.length} detector(s) are active; the filter has stopped matching`)
  process.exit(1)
}

const hits = []
for (const sha of shas) {
  const message = git('log', '-1', '--format=%B', sha)
  for (const d of active) hits.push(...hitsIn(d, `${sha.slice(0, 9)} [${d.name}]`, message))
}

if (hits.length > 0) {
  console.error(`✗ ${hits.length} internal reference(s) in the commit messages of ${range}:`)
  for (const h of hits) console.error(`    ${h}`)
  console.error('')
  console.error('  A commit message is treated as public the moment it is pushed.')
  console.error('  Reword the message (git rebase -i / git commit --amend) before pushing.')
  process.exit(1)
}

console.log(`  ${shas.length} message(s) clean against ${active.length} detectors`)
