// SPDX-License-Identifier: MIT
/**
 * Types for `internal-markers.mjs`.
 *
 * The module is `.mjs` rather than `.ts` because `scripts/` is run by plain
 * `node` in CI and is outside `tsconfig.json`'s `include`; the declarations
 * exist so the suite can import it without `allowJs`.
 */
export interface Detector {
  readonly name: string
  readonly stance: boolean
  readonly pattern: RegExp
  readonly mustMatch: readonly string[]
  readonly mustNotMatch: readonly string[]
}
export interface PublicFileSet {
  readonly packed: string[]
  readonly tracked: string[]
  readonly built: string[]
  readonly union: string[]
  readonly readable: string[]
  readonly binary: string[]
  readonly missing: string[]
}
export declare const INTERNAL_HOST: RegExp
export declare const SIBLING_REPOS: string[]
export declare const DETECTOR_FLOOR: number
export declare const STANCE: ReadonlySet<string>
export declare const COMMIT_EXTRA_STANCE: ReadonlySet<string>
export declare function detectors(self: string): Detector[]
export declare function scopeOf(file: string): 'code' | 'document'
export declare function normalise(line: string, detectorName: string): string
export declare function hitsIn(detector: Detector, label: string, text: string): string[]
export declare function packedFiles(root: string): string[]
export declare function builtFiles(root: string): string[]
export declare function trackedFiles(root: string): string[]
export declare function publicFileSet(root: string): PublicFileSet
