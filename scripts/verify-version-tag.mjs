#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * The one place the version rule lives. verify.yml's release call passes it
 * `v$VERSION` as argv[2] — the version the release PR already wrote into
 * package.json — and it fails unless the two agree, printing the npm
 * dist-tag the publish job must use: `latest` for X.Y.Z, `next` for a
 * pre-release (X.Y.Z-beta.1 and the like; a `-next.N` pre-release from the
 * `prerelease` input never reaches this script — its version exists only in
 * the job's package.json). Output is one line, `DIST_TAG=<latest|next>`, so
 * a shell can `eval` it. CI_COMMIT_TAG is the same argument for anyone
 * running this by hand against an actual tag.
 *
 * Exit codes are distinct on purpose: 2 means "nothing to check" (no
 * version was handed over at all, which is a caller bug), 1 means "the
 * version is wrong".
 */
import { readFileSync } from 'node:fs'

const tag = process.argv[2] ?? process.env.CI_COMMIT_TAG
if (!tag) { console.error('verify-version-tag: no tag (argv[2] or CI_COMMIT_TAG)'); process.exit(2) }
const m = /^v(\d+\.\d+\.\d+)(-([0-9A-Za-z.]+))?$/.exec(tag)
if (!m) { console.error(`verify-version-tag: "${tag}" is not vX.Y.Z or vX.Y.Z-<pre>`); process.exit(1) }
const version = m[1] + (m[2] ?? '')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
if (pkg.version !== version) { console.error(`verify-version-tag: tag ${tag} names ${version} but package.json says ${pkg.version}`); process.exit(1) }
console.log(`DIST_TAG=${m[3] ? 'next' : 'latest'}`)
