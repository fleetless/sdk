// SPDX-License-Identifier: MIT
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * This package is about to be public, where a pull request is a stranger's
 * code. `verify.yml` and `release.yml` run on `ubuntu-latest` — hosted,
 * disposable — precisely so that code never reaches a machine on the office
 * network. Nothing asserted that before this file: a one-word edit, or a job
 * block copied from a repository that legitimately runs on
 * `[self-hosted, build]`, would put a fork's code on that network and the
 * suite would stay green.
 *
 * No YAML parser here on purpose — this package ships to npm and a parser
 * dependency does not earn its place for two workflow files. Text matching
 * on `runs-on:` lines is also the *stricter* check: it sees a line a YAML
 * parse would normalise away, such as `runs-on: "ubuntu-latest"`, exactly as
 * the plain string it is on disk.
 *
 * `dist/`-only concerns (published prose, SPDX headers) all warn: a scan
 * finding nothing has stopped measuring what it is named for. Here that
 * means the workflow directory must exist and must not be empty.
 */

const WORKFLOWS_DIR = new URL('../.github/workflows', import.meta.url).pathname

interface RunsOnEntry {
  file: string
  job: string
  runner: string
}

/**
 * Every `runs-on:` line, with the job it belongs to. Jobs are two-space
 * indented under a top-level `jobs:` key; a job's own keys (`runs-on:`
 * among them) are indented further. A job that calls a reusable workflow
 * (`uses: ./.github/workflows/verify.yml`) sets no `runs-on` of its own —
 * it is skipped here, not missed: the called file is walked too, and its
 * jobs are checked directly.
 */
function runsOnByJob(file: string): RunsOnEntry[] {
  const lines = readFileSync(join(WORKFLOWS_DIR, file), 'utf8').split('\n')
  const entries: RunsOnEntry[] = []
  let inJobs = false
  let currentJob: string | null = null
  let jobUsesReusableWorkflow = false
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true
      continue
    }
    if (inJobs && /^\S/.test(line)) {
      inJobs = false
    }
    if (!inJobs) continue
    const jobHeader = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
    if (jobHeader) {
      currentJob = jobHeader[1]
      jobUsesReusableWorkflow = false
      continue
    }
    if (currentJob && /^\s*uses:\s*\.\/\.github\/workflows\//.test(line)) {
      jobUsesReusableWorkflow = true
    }
    const runsOn = line.match(/^\s*runs-on:\s*(.+?)\s*$/)
    if (runsOn && currentJob && !jobUsesReusableWorkflow) {
      entries.push({ file, job: currentJob, runner: runsOn[1].replace(/^['"]|['"]$/g, '') })
    }
  }
  return entries
}

interface SelfHostedOffender {
  file: string
  line: number
  reason: string
  text: string
}

/**
 * `self-hosted`, classified per line rather than as a flat substring over
 * the whole file.
 *
 * A flat search is the obvious belt to the runner check above's braces —
 * it would catch `runs-on: ${{ matrix.os }}`, `self-hosted` passed as an
 * input to a reusable-workflow call (a job `runsOnByJob` skips, since it
 * carries `uses` rather than `runs-on`), and a commented-out block
 * somebody is about to uncomment. It is also wrong here: this package's own
 * `release.yml` carries a load-bearing prose comment explaining that npm's
 * trusted publishing needs a cloud-hosted runner ("self-hosted is not
 * supported"), and a flat search fails on that sentence — inviting its
 * deletion instead of a better check. Collapsing this back to a flat
 * substring search is tempting and wrong for exactly that reason.
 *
 * - no `#` before the match on that line -> live configuration. Fails.
 * - a `#` before the match, and the comment itself looks like a
 *   commented-out `runs-on:` line -> one keystroke from live. Fails —
 *   this is the case the flat search existed for.
 * - a `#` before the match, anything else -> prose. Allowed.
 */
function selfHostedOffenders(file: string): SelfHostedOffender[] {
  const lines = readFileSync(join(WORKFLOWS_DIR, file), 'utf8').split('\n')
  const offenders: SelfHostedOffender[] = []
  lines.forEach((line, index) => {
    const selfHostedAt = line.indexOf('self-hosted')
    if (selfHostedAt === -1) return
    const hashAt = line.indexOf('#')
    const isComment = hashAt !== -1 && hashAt < selfHostedAt
    if (!isComment) {
      offenders.push({ file, line: index + 1, reason: 'live configuration', text: line.trim() })
      return
    }
    if (/^\s*runs-on\b/.test(line.slice(hashAt + 1))) {
      offenders.push({ file, line: index + 1, reason: 'commented-out runs-on, one keystroke from live', text: line.trim() })
    }
  })
  return offenders
}

const workflowFiles = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
const runsOnEntries = workflowFiles.flatMap((f) => runsOnByJob(f))

describe('CI runs on hosted runners only', () => {
  it('finds workflow files to check, not an empty directory', () => {
    // A glob matching nothing passes every assertion below it vacuously —
    // the classic way a test like this rots unnoticed.
    expect(workflowFiles.length).toBeGreaterThan(0)
    expect(runsOnEntries.length).toBeGreaterThanOrEqual(2)
  })

  it('every job runs on ubuntu-latest', () => {
    // Collected, not asserted one by one: the failure names every offending
    // file and job at once, which is what someone who just broke this needs
    // to read.
    const offenders = runsOnEntries
      .filter((e) => e.runner !== 'ubuntu-latest')
      .map((e) => `${e.file}:${e.job} runs on ${JSON.stringify(e.runner)}, not ubuntu-latest`)
    expect(offenders).toEqual([])
  })

  it('self-hosted appears nowhere as live or commented-out config', () => {
    const offenders = workflowFiles.flatMap((f) => selfHostedOffenders(f))
    const messages = offenders.map((o) => `${o.file}:${o.line} (${o.reason}): ${o.text}`)
    expect(messages).toEqual([])
  })
})
