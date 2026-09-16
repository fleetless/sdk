// SPDX-License-Identifier: MIT
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * No doc comment or error message in `src/` sends a developer to a README
 * section any more.
 *
 * The README is a lobby: what Fleetless is, what this package is, one
 * snippet, and the links. Everything a method's doc comment used to point at
 * — the Actions, Cameras, Publishers and Errors sections — lives in the SDK
 * reference at docs.fleetless.dev now, and the code points there. Before
 * this, 3.0.1 shipped four pointers into sections the README did not have,
 * one of them inside a runtime error message; a pointer into a file this
 * repository no longer keeps sections in would be that bug again, with no
 * heading to ever resolve it.
 *
 * **What makes this fail**: write `the README's X section` (quoted or bare)
 * anywhere under `src/`. The pattern is the same one the old resolver used,
 * so a pointer that would have been checked then is refused now.
 */

const ROOT = new URL('..', import.meta.url).pathname

const POINTER = /README'?s? (?:"([^"]+)"|([A-Z][A-Za-z0-9 ,'`-]*?)) section/g

const sources = execFileSync('git', ['ls-files', '-z', 'src'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)

/**
 * Comment prefixes come off and the file is read as one run of text, because
 * a pointer wraps across lines — `the README's` ends one, `Cameras section`
 * starts the next. A per-line scan missed three of four such pointers once.
 */
function flatten(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:\/\/+|\*|\/\*\*?)\s?/, ''))
    .join(' ')
}

describe('the code does not point a developer at README sections', () => {
  it('scanned the sources at all', () => {
    // Anti-vacuity: an empty file list would report zero pointers in zero
    // files, the same green tick as a clean tree.
    expect(sources.length, 'no source files were listed').toBeGreaterThan(15)
  })

  it('names no README section anywhere under src/', () => {
    const found: string[] = []
    for (const file of sources) {
      for (const m of flatten(readFileSync(join(ROOT, file), 'utf8')).matchAll(POINTER)) {
        found.push(`${file}: "${(m[1] ?? m[2]).trim()}" — the README has no sections; point at the SDK reference`)
      }
    }
    expect(found, `${found.length} pointer(s) into README.md`).toEqual([])
  })

  it('the pattern still matches the shape it refuses', () => {
    // A regex that quietly stopped matching would pass the test above
    // forever. Both shapes the code used to write must trip it.
    expect([...flatten("see the README's Errors section").matchAll(POINTER)]).toHaveLength(1)
    expect([...flatten('see the README\'s\n   * "Publishers, and no teleop helpers" section').matchAll(POINTER)]).toHaveLength(1)
  })
})
