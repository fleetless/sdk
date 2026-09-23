// SPDX-License-Identifier: MIT
/**
 * `npm publish` from a working tree is refused. RELEASING.md says "`npm
 * publish` by hand is retired" — this is the mechanism behind that sentence,
 * which was previously a rule with nothing enforcing it. Mirrors the sibling
 * `contracts` package's equivalent script.
 *
 * What it prevents: a version reaching npm having passed no typecheck, no
 * suite and no `test:pack`, from a tree that may be dirty. npm refuses to
 * republish a version, so that is not a mistake anybody can take back.
 *
 * **It does not stand in the workflow's way, and the reason is a detail of
 * npm's lifecycle rather than a check on `CI`.** `prepublishOnly` runs when
 * npm publishes a DIRECTORY. The `publish` job publishes the tarball that
 * `verify` already packed (`npm publish fleetless-sdk-*.tgz`), and npm runs
 * no prepare/prepack lifecycle for a tarball argument — verified by running
 * both forms with `--dry-run`.
 *
 * So this refuses unconditionally rather than reading an environment
 * variable. A guard whose bypass is `CI=1` is a guard with a documented
 * bypass.
 *
 * What makes it fail: `npm publish` in this directory. What makes it stay
 * out of the way: `npm publish <tarball>`, which is what the `publish` job
 * does.
 */
console.error(`
  Refusing to publish @fleetless/sdk from a working tree.

  Releases are made by the GitHub \`release\` workflow's \`publish\` job, from
  the tarball its \`verify\` job packed after the typecheck, the suite and
  \`pnpm run test:pack\`. See "Releasing" in RELEASING.md.

    Actions tab -> release -> Run workflow, on main. The release PR rotates
    CHANGELOG.md and bumps package.json for you and merges itself once
    \`verify\` passes; tick \`prerelease\` to ship X.Y.Z-next.N under \`next\`
    from any branch instead, with no PR and no changelog entry.

  If you are the workflow and you are seeing this, you are publishing a
  directory rather than the packed tarball, and the tarball is what the checks
  were run against.
`)
process.exit(1)
