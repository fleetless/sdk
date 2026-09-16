// SPDX-License-Identifier: MIT
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Pinned, not defaulted. Vitest's default `include` is `**/*.test.ts`
    // across the whole tree, and its default `exclude` covers `node_modules`
    // and `dist` but nothing else — so any directory that appears inside this
    // one during a run contributes its test files to this package's suite.
    //
    // That is not hypothetical. A CI run went green having run 1051
    // tests in 51 files instead of 254 in 16: pnpm's store had been pointed
    // inside the project so a cache could archive it, and pnpm leaves the
    // `@fleetless/contracts` git checkout under `<store>/v11/tmp/`. Another
    // repository's suite was deciding this package's exit code, out of a
    // directory that exists only until pnpm cleans it up.
    //
    // The store was moved back out, which removed that particular condition.
    // This removes the whole class: only `test/` is this package's suite.
    include: ['test/**/*.test.ts'],
  },
})
