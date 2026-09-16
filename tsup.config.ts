// SPDX-License-Identifier: MIT
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  // **Keep `dts.resolve`. The reason is not that contracts is private — it is
  // public on npm now — it is that contracts is a DEVDEPENDENCY here.** It is
  // therefore absent from the published tarball's `dependencies`, so an SDK
  // consumer has no `@fleetless/contracts` in `node_modules` unless they
  // installed it themselves. A `dist/index.d.ts` that imports from it fails
  // every such consumer's `tsc` with TS2307, while the emitted JS keeps working
  // (type-only imports are erased) — which is what makes the breakage invisible
  // until somebody typechecks. Inlining the types is what closes that, and
  // `scripts/verify-published-types.mjs` is what proves it still holds.
  dts: { resolve: [/^@fleetless\/contracts/, /^\.\//] },
  clean: true,
})
