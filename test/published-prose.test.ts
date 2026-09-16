// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DETECTOR_FLOOR,
  STANCE,
  detectors,
  hitsIn,
  normalise,
  publicFileSet,
  scopeOf,
} from '../scripts/internal-markers.mjs'

/**
 * Nothing internal reaches the bytes this package publishes, or the tree a
 * public mirror gets.
 *
 * `@fleetless/sdk@3.0.0` on npm carries German paragraphs, internal defect ids
 * and — 48 times across `index.js` and `index.cjs` — an internal GitLab
 * hostname, none of which is written down in the source it was built from. They
 * arrive through the **bundle**: `tsup` inlines `@fleetless/contracts` with its
 * doc comments intact, and stamps each inlined module's path as a comment —
 * at the time a `git+ssh://…@<internal host>` dependency specifier. A
 * source-only guard is green about all of it.
 *
 * The patterns, the scopes and the file set live in
 * `scripts/internal-markers.mjs`, because the commit-message check needs the
 * same answers and a second copy of them would be a second policy.
 *
 * **What makes this fail**: put one German sentence, one internal id, one
 * developer path, one wave label or one internal hostname into any file the
 * package publishes or mirrors. Verified by doing exactly that, per detector,
 * through the fixture table in the module.
 *
 * **What makes it fail the harder way**: scanning nothing. `dist/` is
 * generated, so an unbuilt tree would make every assertion here free. The three
 * sets are floored against their real sizes, a control string that must be
 * present is asserted, and the detector list itself has a floor — deleting a
 * detector is the cheapest way to make a sweep look finished.
 */

const ROOT = new URL('..', import.meta.url).pathname
const SELF = 'sdk'
const DETECTORS = detectors(SELF)

/**
 * The one file that must contain the strings the detectors look for.
 *
 * An exemption list is a hole, so this one is bounded four ways below: it is
 * asserted to be exactly this name, the file must be in the scanned set, it
 * must exist, and **it must actually still contain a hit**. That last
 * assertion has already paid: `scripts/verify-published-types.mjs` was on this
 * list because it refuses a `repository` field pointing at a host only a
 * maintainer can reach, and was held to need that host's name to do it — and
 * the assertion went red, correctly. The name was there, inside a regular
 * expression of its own, where an escaped dot kept every detector off it and a
 * `git grep` over the public mirror would have found it in a second. It imports
 * the shape now and names nothing; it needed no exemption either way — and an
 * exemption hiding nothing is one file fewer this guard actually reads.
 */
const EXEMPT = new Map([
  ['scripts/internal-markers.mjs', 'the detectors and their fixtures are spelt out here'],
])

/** A string that MUST be in the scanned bytes; its absence means we read nothing. */
const CONTROL = 'Fleetless'

const SET = publicFileSet(ROOT)
const scanned = SET.readable.filter((f) => !EXEMPT.has(f))
const contents = new Map(scanned.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]))
const totalBytes = [...contents.values()].reduce((n, s) => n + s.length, 0)

describe('the set of bytes that become public', () => {
  it('asks npm, git and the build for the set rather than naming directories', () => {
    // Three questions, three tools, and each answer floored against its real
    // size. A named list of directories is what let ten tracked files —
    // `.gitlab-ci.yml` and `package.json` among them, the two that had actually
    // carried the internal host — sit outside every sweep.
    expect(SET.packed.length, 'npm pack listed almost nothing').toBeGreaterThanOrEqual(8)
    expect(SET.tracked.length, 'git ls-files returned almost nothing').toBeGreaterThanOrEqual(45)
    expect(SET.built.length, 'dist/ was not walked — run `pnpm build`').toBeGreaterThanOrEqual(4)

    // The published set is inside the scanned set by construction, but say so:
    // a `files` entry that npm resolves differently from the walk would
    // otherwise be a silent gap.
    const union = new Set(SET.union)
    for (const f of SET.packed) expect(union.has(f), `${f} is packed but not scanned`).toBe(true)

    // Both emits and both declaration files. `tsup` writes ESM and CJS
    // independently and a `.d.ts`/`.d.cts` pair beside them; a tree with only
    // one of the four is a half-run build — and the missing half is exactly
    // what this guard stays silent on.
    for (const f of ['dist/index.js', 'dist/index.cjs', 'dist/index.d.ts', 'dist/index.d.cts']) {
      expect(SET.union, `${f} is missing — the build did not finish`).toContain(f)
    }

    // Nothing was silently dropped for being unreadable, and nothing the three
    // tools named has gone missing from disk.
    expect(SET.binary, 'a binary file is in the published set').toEqual([])
    expect(SET.missing, 'a listed file does not exist').toEqual([])
  })

  it('gives every scanned file a scope, and reads its bytes', () => {
    // `scopeOf` throws on an extension it does not know, so a new kind of file
    // is a decision rather than a file that stops being scanned. Asserted over
    // the real set rather than trusted.
    for (const f of scanned) expect(['code', 'document']).toContain(scopeOf(f))

    // The control. A walk returning paths whose contents are empty strings
    // would satisfy every "does not match" assertion below; this is the one
    // assertion that goes the other way.
    expect(totalBytes).toBeGreaterThan(1_000_000)
    const withControl = [...contents].filter(([, text]) => text.includes(CONTROL))
    expect(withControl.length, `not one scanned file contains ${CONTROL}`).toBeGreaterThan(0)

    // The bundle is ~500 KB per emit. A `dist/` whose four files are stubs
    // would satisfy every name check above and carry none of the inlined prose.
    const distBytes = scanned
      .filter((f) => f.startsWith('dist/'))
      .reduce((n, f) => n + (contents.get(f)?.length ?? 0), 0)
    expect(distBytes, 'dist/ is present but far too small to be the bundle').toBeGreaterThan(500_000)
  })

  it('exempts exactly the one file that must name what the detectors look for', () => {
    expect([...EXEMPT.keys()].sort()).toEqual(['scripts/internal-markers.mjs'])
    for (const f of EXEMPT.keys()) {
      expect(SET.union, `${f} is exempt but is outside the scanned set`).toContain(f)
      const text = readFileSync(join(ROOT, f), 'utf8')
      const hit = DETECTORS.some((d) => d.pattern.test(normalise(text, d.name)))
      expect(hit, `${f} is exempt but no longer contains anything the detectors catch — drop the exemption`).toBe(true)
    }
  })
})

describe('the published bytes carry nothing internal', () => {
  it.each(DETECTORS.map((d) => [d.name, d] as const))('no published file contains %s', (_name, d) => {
    // Collected across every file and reported together: somebody who
    // reintroduced a paragraph needs to see all of it, not its first line.
    //
    // The stance classes are not run over documents. A README, a changelog or a
    // CI file legitimately describes the package it ships with — reddening on
    // that would demand the document stop addressing its own reader. The
    // marker classes run everywhere, because an internal hostname in a README
    // link is exactly the leak this exists for.
    const hits: string[] = []
    for (const [file, text] of contents) {
      if (d.stance && scopeOf(file) !== 'code') continue
      hits.push(...hitsIn(d, file, text))
    }
    expect(hits, `${hits.length} hit(s) for ${d.name}`).toEqual([])
  })
})

describe('the detectors themselves', () => {
  it('keeps every detector, and every detector keeps its fixtures', () => {
    // The anti-vacuity floor. Deleting a detector, or adding one without the
    // two fixtures that prove it can fire and will not fire on its near-miss,
    // is red here. Seven of the fifteen patterns this replaces had neither, and
    // two of them could be deleted outright with the whole suite green.
    expect(DETECTORS.length).toBeGreaterThanOrEqual(DETECTOR_FLOOR)
    expect(new Set(DETECTORS.map((d) => d.name)).size).toBe(DETECTORS.length)
    for (const d of DETECTORS) {
      expect(d.mustMatch.length, `${d.name} has no MUST_MATCH fixture`).toBeGreaterThan(0)
      expect(d.mustNotMatch.length, `${d.name} has no MUST_NOT_MATCH fixture`).toBeGreaterThan(0)
      expect(typeof d.stance, `${d.name} does not say whether it is a stance class`).toBe('boolean')
    }
    // Stance classes are the ones the documents are exempt from, so the split
    // is a named set cross-checked against each detector's own flag rather than
    // an ordering: `@fleetless/contracts` once took it as `MARKERS.slice(-5)`,
    // and one marker appended would have made a different five "the stance
    // classes", silently, with the documents exempt from the wrong ones.
    expect(STANCE.size).toBe(5)
    const names = new Set(DETECTORS.map((d) => d.name))
    for (const n of STANCE) expect(names.has(n), `${n} is a stance class but not a detector`).toBe(true)
    for (const d of DETECTORS) expect(d.stance, `${d.name} disagrees with STANCE`).toBe(STANCE.has(d.name))
  })

  it.each(DETECTORS.flatMap((d) => d.mustMatch.map((t) => [d.name, t, d] as const)))(
    '%s catches: %s',
    (_name, text, d) => {
      expect(d.pattern.test(normalise(text, d.name))).toBe(true)
    },
  )

  it.each(DETECTORS.flatMap((d) => d.mustNotMatch.map((t) => [d.name, t, d] as const)))(
    '%s leaves alone: %s',
    (_name, text, d) => {
      expect(d.pattern.test(normalise(text, d.name))).toBe(false)
    },
  )
})
