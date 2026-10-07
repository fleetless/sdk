// SPDX-License-Identifier: MIT
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * `scripts/verify-version-tag.mjs` decides the dist-tag a release is
 * published under, and `publish` hands its answer straight to
 * `npm publish --tag`. A final release goes out under `staging`, never
 * `latest`: `latest` moves only when the release is promoted to production
 * (fleetless/fleetless promote.yml). Nothing but this file would notice the
 * script answering `latest` again.
 */

const SCRIPT = new URL('../scripts/verify-version-tag.mjs', import.meta.url).pathname

interface Run {
  status: number
  stdout: string
  stderr: string
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function run(tag: string | null, pkgVersion: string): Run {
  const dir = mkdtempSync(join(tmpdir(), 'verify-version-tag-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'scripts'))
  copyFileSync(SCRIPT, join(dir, 'scripts', 'verify-version-tag.mjs'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@fleetless/sdk', version: pkgVersion, type: 'module' }))

  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.CI_COMMIT_TAG
  const child = spawnSync(process.execPath, [join(dir, 'scripts', 'verify-version-tag.mjs'), ...(tag === null ? [] : [tag])], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { status: child.status ?? -1, stdout: child.stdout, stderr: child.stderr }
}

describe('verify-version-tag picks the dist-tag of a release', () => {
  it('a final release goes out under `staging`', () => {
    const r = run('v6.4.0', '6.4.0')

    expect(r.status).toBe(0)
    expect(r.stdout).toBe('DIST_TAG=staging\n')
  })

  it('a final release below a higher published version still goes out under `staging`: a release never touches `latest`', () => {
    const r = run('v1.0.1', '1.0.1')

    expect(r.status).toBe(0)
    expect(r.stdout).toBe('DIST_TAG=staging\n')
  })

  it('a pre-release tag goes out under `next`', () => {
    const r = run('v6.4.0-next.1', '6.4.0-next.1')

    expect(r.status).toBe(0)
    expect(r.stdout).toBe('DIST_TAG=next\n')
  })

  it('no output ever names `latest` as the dist-tag', () => {
    expect(run('v6.4.0', '6.4.0').stdout).not.toContain('latest')
    expect(run('v6.4.0-next.1', '6.4.0-next.1').stdout).not.toContain('latest')
  })
})

describe('verify-version-tag refuses a tag that does not match the tree', () => {
  it('a tag naming another version than package.json exits 1', () => {
    const r = run('v6.4.0', '6.3.0')

    expect(r.status).toBe(1)
    expect(r.stderr).toContain('verify-version-tag: tag v6.4.0 names 6.4.0 but package.json says 6.3.0')
    expect(r.stdout).toBe('')
  })

  it('a tag that is not vX.Y.Z or vX.Y.Z-<pre> exits 1', () => {
    const r = run('6.4.0', '6.4.0')

    expect(r.status).toBe(1)
    expect(r.stderr).toContain('is not vX.Y.Z or vX.Y.Z-<pre>')
    expect(r.stdout).toBe('')
  })

  it('no tag at all exits 2: a caller bug, not a wrong tag', () => {
    const r = run(null, '6.4.0')

    expect(r.status).toBe(2)
    expect(r.stdout).toBe('')
  })
})
