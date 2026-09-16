#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Puts the SPDX header on every file `tsup` emits.
 *
 * `tsup`'s own `banner` option reaches the JS emits only; the two declaration
 * files are written by a separate pass that it does not apply to. So a
 * `banner:` in `tsup.config.ts` would stamp two of the four files and look
 * complete — which is why this is a script over the whole directory and why
 * `scripts/verify-published-types.mjs` asserts the result over the TARBALL's
 * bytes rather than over these ones. A check that reads the `dist/` this script
 * just wrote cannot tell a stamped build from a stamped publish.
 *
 * Idempotent: a file that already opens with the header is left alone and
 * counted separately, so the summary distinguishes "stamped it" from "it was
 * already there" instead of reporting the same number either way.
 *
 * **It also removes the SPDX identifiers the bundle inherits.** `tsup` inlines
 * `@fleetless/contracts`, which is Apache-2.0 and carries a per-file SPDX
 * header, and the declaration pass copies those headers into `index.d.ts` and
 * `index.d.cts` — six of them, below the MIT one this script puts on line 1.
 * The result is a file that claims two licences, in a package whose manifest
 * and LICENSE say MIT only. Nobody's obligation is breached (the same company
 * owns both), but a consumer's licence scan — ScanCode, FOSSA, `reuse lint`,
 * licensee, all of which read file-level SPDX tags — reports Apache-2.0
 * obligations for a package that ships no Apache text, and no reader of the
 * tarball can tell which identifier governs the file.
 *
 * So each emitted file ends up with exactly one identifier: the package's own.
 * The count of removed lines is reported, because "removed six" and "removed
 * none because the pattern stopped matching" must not print the same.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HEADER = '// SPDX-License-Identifier: MIT'
/**
 * Any file-level SPDX identifier line, whatever the licence. Anchored to the
 * start of a line so an identifier quoted inside a string or a doc comment on
 * the same line as other text is left alone.
 */
const ANY_SPDX = /^\/\/ SPDX-License-Identifier: .*\r?\n/gm
const DIST = new URL('../dist', import.meta.url).pathname

const files = readdirSync(DIST).filter((f) => /\.(js|cjs|mjs|d\.ts|d\.cts)$/.test(f))

// Anti-vacuity. An empty or half-built `dist/` would let this script report
// success having stamped nothing, and the pack guard downstream would then be
// asserting the header over files that do not exist.
if (files.length < 4) {
  console.error(`stamp-dist: dist/ holds ${files.length} emitted file(s); expected at least 4. Run \`tsup\` first.`)
  process.exit(1)
}

let stamped = 0
let already = 0
let stripped = 0
for (const f of files) {
  const path = join(DIST, f)
  const original = readFileSync(path, 'utf8')
  // Strip every identifier first, including this script's own from a previous
  // run, then put exactly one back. Stripping and re-adding rather than
  // "strip all but the first" is what makes the result independent of where
  // the inherited ones happen to sit.
  const body = original.replace(ANY_SPDX, '')
  const removed = (original.match(ANY_SPDX) ?? []).length
  const text = `${HEADER}\n${body}`
  if (original.startsWith(HEADER) && removed === 1) already++
  else stamped++
  stripped += Math.max(0, removed - (original.startsWith(HEADER) ? 1 : 0))
  if (text !== original) writeFileSync(path, text)
}
console.log(
  `stamp-dist: ${stamped} stamped, ${already} already carried exactly one, ` +
    `${stripped} inherited identifier(s) removed, ${files.length} total`,
)
