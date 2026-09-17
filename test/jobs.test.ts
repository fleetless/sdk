// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from 'vitest'
import type { Job, JobRunListResponse } from '@fleetless/contracts'
import { HttpClient, noCredentials } from '../src/http.js'
import { createJobsApi } from '../src/jobs.js'
import { FleetlessError } from '../src/errors.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function errorResponse(code: string, message: string, status = 403): Response {
  return jsonResponse({ code, message }, status)
}

function fakeFetch(impl: (input: string | URL | RequestInfo, init?: RequestInit) => Promise<Response>) {
  return vi.fn(impl)
}

function client(fetchImpl: typeof fetch) {
  const http = new HttpClient({ baseUrl: 'https://api.fleetless.dev', fetch: fetchImpl, credentials: noCredentials })
  return createJobsApi(http)
}

const RUNNING_JOB: Job = {
  id: 'job1',
  robot_id: 'robot1',
  slug: 'dock',
  state: 'running',
  started_at: '2026-08-12T10:00:00.000Z',
  updated_at: '2026-08-12T10:00:00.000Z',
  seq: 1,
  result: null,
  error: null,
}

describe('jobs.list', () => {
  it('reads the robot-wide job list with a plain GET and no body', async () => {
    const fetchImpl = fakeFetch(async (input, init) => {
      expect(String(input)).toBe('https://api.fleetless.dev/api/robots/robot1/jobs')
      expect(init?.method ?? 'GET').toBe('GET')
      expect(init?.body).toBeUndefined()
      return jsonResponse({ jobs: [RUNNING_JOB] })
    })

    await expect(client(fetchImpl as unknown as typeof fetch).list('robot1')).resolves.toEqual([RUNNING_JOB])
  })

  it('resolves an empty array for a robot doing nothing — "nothing running" is not "we did not look"', async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse({ jobs: [] }))

    await expect(client(fetchImpl as unknown as typeof fetch).list('robot1')).resolves.toEqual([])
  })

  // `pathSegment()` is proved against a real server in http.test.ts; this
  // confirms the route calls it for robotId.
  it('encodes a robotId shaped like a traversal attempt rather than sending it as a literal path segment', async () => {
    const fetchImpl = fakeFetch(async (input) => {
      expect(String(input)).toBe('https://api.fleetless.dev/api/robots/..%2F..%2Fadmin/jobs')
      return jsonResponse({ jobs: [] })
    })

    await client(fetchImpl as unknown as typeof fetch).list('../../admin')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('passes through every entry unfiltered — the cloud already filters by grant, this method does not re-filter', async () => {
    const secondJob: Job = { ...RUNNING_JOB, id: 'job2', slug: 'wave', state: 'succeeded', seq: 2, result: { ok: true } }
    const fetchImpl = fakeFetch(async () => jsonResponse({ jobs: [RUNNING_JOB, secondJob] }))

    await expect(client(fetchImpl as unknown as typeof fetch).list('robot1')).resolves.toEqual([RUNNING_JOB, secondJob])
  })

  it('rejects with a FleetlessError for a real refusal (e.g. the robot does not exist)', async () => {
    const fetchImpl = fakeFetch(async () => errorResponse('not_found', 'No robot with id robot1.', 404))

    await expect(client(fetchImpl as unknown as typeof fetch).list('robot1')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('rejects a forbidden read the same way any other command-surface route does', async () => {
    const fetchImpl = fakeFetch(async () => errorResponse('forbidden', 'not granted', 403))

    const promise = client(fetchImpl as unknown as typeof fetch).list('robot1')
    await expect(promise).rejects.toBeInstanceOf(FleetlessError)
    await expect(promise).rejects.toMatchObject({ code: 'forbidden' })
  })
})

const RUN_PAGE: JobRunListResponse = {
  runs: [{
    id: 'run1', robot_id: 'robot1', slug: 'dock', kind: 'action', state: 'succeeded',
    started_at: '2026-09-17T08:00:00.000Z', ended_at: '2026-09-17T08:00:04.000Z', duration_ms: 4000,
    result: { ok: true }, error: null,
    actor: { kind: 'app_user', id: 'user1', label: 'sam@example.com' },
    seq: 41, progress: null, feedback: null,
  }],
  next_cursor: 41,
}

describe('jobs.history', () => {
  it('reads the run history with a plain GET and no query when no option is set', async () => {
    const fetchImpl = fakeFetch(async (input, init) => {
      expect(String(input)).toBe('https://api.fleetless.dev/api/robots/robot1/jobs/history')
      expect(init?.method ?? 'GET').toBe('GET')
      return jsonResponse(RUN_PAGE)
    })
    await expect(client(fetchImpl as unknown as typeof fetch).history('robot1')).resolves.toEqual(RUN_PAGE)
  })

  it('sends every set option under its wire name and omits every unset one', async () => {
    const fetchImpl = fakeFetch(async (input) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/api/robots/robot1/jobs/history')
      expect([...url.searchParams.keys()].sort()).toEqual(['before_seq', 'from_ms', 'kind', 'limit', 'slug', 'state', 'to_ms'])
      expect(url.searchParams.get('before_seq')).toBe('41')
      expect(url.searchParams.get('limit')).toBe('50')
      expect(url.searchParams.get('from_ms')).toBe('1700000000000')
      return jsonResponse({ runs: [], next_cursor: null } satisfies JobRunListResponse)
    })
    await client(fetchImpl as unknown as typeof fetch).history('robot1', {
      slug: 'dock', state: 'succeeded', kind: 'action', limit: 50, beforeSeq: 41, fromMs: 1700000000000, toMs: 1700000030000,
    })
  })

  it('sends only `slug` when only slug is set', async () => {
    const fetchImpl = fakeFetch(async (input) => {
      const url = new URL(String(input))
      expect([...url.searchParams.keys()]).toEqual(['slug'])
      return jsonResponse({ runs: [], next_cursor: null } satisfies JobRunListResponse)
    })
    await client(fetchImpl as unknown as typeof fetch).history('robot1', { slug: 'dock' })
  })

  it('rejects capability_required as a FleetlessError, naming the switch to flip', async () => {
    const fetchImpl = fakeFetch(async () => errorResponse('capability_required', 'The role lacks action_history.', 403))
    await expect(client(fetchImpl as unknown as typeof fetch).history('robot1')).rejects.toMatchObject({ code: 'capability_required' })
  })
})
