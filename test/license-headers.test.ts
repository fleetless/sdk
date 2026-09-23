// SPDX-License-Identifier: MIT
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every source file here carries the SPDX header as its first line —
 * published under MIT, so a missing header leaves the licence for a
 * downstream reader to guess.
 *
 * What makes this test fail: delete the header from any one file under any
 * source directory. Verified by doing exactly that — the run named the file.
 * What ALSO makes it fail, and is the harder half: the sweep finding fewer
 * files than the repository has — a guard silently walking an empty
 * directory is the costliest failure mode here, so the count is checked
 * twice: against a floor, and against the real listing.
 *
 * **The file set comes from `git ls-files`, not from a list of directories.**
 * A named list (`src`, `scripts`, `test`) is a set-requirement guarded by
 * three examples: a `bin/`, a `tools/`, or a root `.ts` is invisible to it,
 * carrying whatever header got copied. `tsup.config.ts` and
 * `vitest.config.ts` are exactly that case — swept only because the set
 * comes from the index.
 *
 * Walking the filesystem instead is the obvious repair, wrong the other
 * way — it sweeps whatever is lying in the working directory.
 * `@fleetless/contracts`'s guard was written that way first and CI failed on
 * `dist-tag.env`, a file the pipeline writes into the checkout before the
 * suite runs: a guard about the repository, answering about a job's scratch
 * directory. Git's index is the repository's own answer to what counts as a
 * file, so that's what is asked.
 *
 * The published half isn't here. `dist/` is what a consumer receives — a
 * `tsup` bundle, not a file-per-module emit — so
 * `scripts/verify-published-types.mjs` asserts the header over the tarball's
 * own bytes, the only place that can.
 */

const HEADER = '// SPDX-License-Identifier: MIT'
const ROOT = new URL('..', import.meta.url).pathname

/**
 * `.github/release/` is the shared release library (`release.mjs`,
 * `release.test.mjs`): identical, byte for byte, in every repository with a
 * Release button, and pinned there by sha256 rather than by the package's
 * own licence. It is published under Apache-2.0 everywhere it lives, this
 * copy included, so its header names that — not MIT. Nothing else is
 * exempt: a file outside this one directory still needs the header the
 * package is actually published under.
 */
const LIBRARY_DIR = '.github/release/'
const LIBRARY_HEADER = '// SPDX-License-Identifier: Apache-2.0'
const expectedHeader = (f: string) => (f.startsWith(LIBRARY_DIR) ? LIBRARY_HEADER : HEADER)

/** Generated. `dist/` is emitted by `tsup` and stamped by its banner. */
const GENERATED = ['dist/']

/** Extensions that carry `//` comments and therefore must carry the header. */
const SOURCE = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']

/**
 * Extensions and names that are NOT source. Kept as literal lists, not a
 * catch-all: an unclassified file type lands in `unclassified` below and
 * fails — the moment somebody asks whether it should have been source
 * instead.
 */
const NOT_SOURCE_EXT = ['.md', '.json', '.yaml', '.yml', '.txt']
const NOT_SOURCE_NAME = new Set(['LICENSE', 'NOTICE', '.gitignore'])

/**
 * `-z` and a NUL split: git escapes a path with a space or quote in its
 * default output, and a naive newline split would mangle it — silently
 * dropping exactly the file whose name was unusual.
 */
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)

const all = tracked.filter((f) => !GENERATED.some((d) => f.startsWith(d)))
const sources = all.filter((f) => SOURCE.some((ext) => f.endsWith(ext)))

describe('SPDX headers', () => {
  it('classifies every tracked file — no file is silently skipped', () => {
    // The set assertion, not an example: every entry found is either source
    // (header-checked below) or exempt by name. A `.py`, `.tsx`, or `.yaml`
    // dropped into `src/` fails here instead of passing unnoticed because the
    // extension list didn't know it.
    const unclassified = all.filter(
      (f) =>
        !sources.includes(f) &&
        !NOT_SOURCE_EXT.some((ext) => f.endsWith(ext)) &&
        !NOT_SOURCE_NAME.has(f.split('/').pop()!),
    )
    expect(unclassified).toEqual([])
  })

  it("finds the repository's source files, not an empty listing", () => {
    // Anti-vacuity: `src/` alone has 18 files, `test/` 18. A listing
    // returning 3, or 0 — a failed `git ls-files`, a wrong `cwd` — has
    // stopped measuring what this test is named for, and every assertion
    // below it becomes free.
    expect(tracked.length).toBeGreaterThan(45)
    expect(sources.length).toBeGreaterThan(35)
    for (const dir of ['src', 'scripts', 'test']) {
      expect(
        sources.filter((f) => f.startsWith(`${dir}/`)).length,
        `no source files found under ${dir}/`,
      ).toBeGreaterThan(0)
    }
  })

  it('sweeps the whole repository, not three named directories', () => {
    // The point of taking the set from git: a source file OUTSIDE src/,
    // scripts/ and test/ is swept without anybody editing this file. Asserted
    // against the two that exist, not in the abstract — a rule with no
    // instance is a rule nobody can tell is working.
    const outside = sources.filter((f) => !/^(src|scripts|test)\//.test(f))
    expect(outside).toContain('tsup.config.ts')
    expect(outside).toContain('vitest.config.ts')
    for (const f of outside) expect(sources).toContain(f)
  })

  it('every source file opens with the SPDX header', () => {
    // Collected, not asserted one by one: the failure message then names
    // every offender at once, not just the first — what somebody adding six
    // files needs to read.
    //
    // A `#!` line — and ONLY a `#!` line — may precede the header: a shebang
    // must be byte zero or the kernel won't see it. Deliberately narrow — any
    // other first line is a violation, not a general "somewhere near the top"
    // rule a stray comment could satisfy.
    const missing = sources.filter((f) => {
      const lines = readFileSync(join(ROOT, f), 'utf8').split('\n')
      const at = lines[0].startsWith('#!') ? 1 : 0
      return lines[at] !== expectedHeader(f)
    })
    expect(missing).toEqual([])
  })

  it('only a shebang may precede the header — not an arbitrary first line', () => {
    // The exemption above is a hole if unbounded. This asserts the bound
    // directly: every file whose header is on line 2 has a shebang on line 1
    // — without it the rule reads as "line 1 or line 2" and a comment could
    // sit above the licence.
    const offset = sources
      .map((f) => [f, readFileSync(join(ROOT, f), 'utf8').split('\n')] as const)
      .filter(([f, lines]) => lines[0] !== expectedHeader(f))
    for (const [f, lines] of offset) {
      expect(lines[0].startsWith('#!'), `${f}: line 1 is neither the header nor a shebang`).toBe(true)
    }
    // And that the exemption is exercised: `scripts/verify-live.mjs` is
    // executable and carries a shebang, so this branch isn't dead code
    // asserting nothing.
    expect(offset.map(([f]) => f)).toContain('scripts/verify-live.mjs')
  })

  it('the header names the licence the package is actually published under', () => {
    // A guard that asserts a constant against itself proves nothing. The
    // licence a consumer sees is `package.json`'s, so that's what the header
    // is checked against — copying this file from an Apache-2.0 repo and
    // forgetting to update the identifier fails here rather than silently
    // mislabelling every file in the tree.
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(HEADER).toBe(`// SPDX-License-Identifier: ${manifest.license}`)
  })
})
