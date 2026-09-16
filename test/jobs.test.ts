// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from 'vitest'
import type { Job } from '@fleetless/contracts'
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
