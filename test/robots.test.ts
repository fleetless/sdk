// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from 'vitest'
import type { ClientRobotListResponse, McpRobotDatasheet } from '@fleetless/contracts'
import { HttpClient, noCredentials } from '../src/http.js'
import { createRobotsApi } from '../src/robots.js'
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
  return createRobotsApi(http)
}

const LIST: ClientRobotListResponse = {
  robots: [
    { id: 'robot1', name: 'alpha', created_at: '2026-09-17T08:00:00.000Z', bridge_state: { online: true, latency_ms: 12, low_bandwidth: true }, published_version: 3 },
    { id: 'robot2', name: 'bravo', created_at: '2026-09-17T08:00:00.000Z', bridge_state: { online: false, latency_ms: null, low_bandwidth: false }, published_version: null },
  ],
}

const SHEET: McpRobotDatasheet = {
  robot_id: 'robot1',
  robot_name: 'alpha',
  capabilities: { action_history: true, assets: false },
  exposures: [
    { slug: 'battery_percentage', kind: 'datapoint', description: null, unit: '%', decimals: 1, input_schema: null },
    { slug: 'drive_to', kind: 'action', description: 'Drive somewhere.', unit: null, decimals: null, input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  ],
}

describe('robots.list', () => {
  it('reads the client robot list with a plain GET and unwraps `robots`', async () => {
    const fetchImpl = fakeFetch(async (input, init) => {
      expect(String(input)).toBe('https://api.fleetless.dev/api/client/robots')
      expect(init?.method ?? 'GET').toBe('GET')
      expect(init?.body).toBeUndefined()
      return jsonResponse(LIST)
    })
    await expect(client(fetchImpl as unknown as typeof fetch).list()).resolves.toEqual(LIST.robots)
  })

  it("passes bridge_state.low_bandwidth through untouched, bridge-reported same as online and latency_ms", async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse(LIST))
    const robots = await client(fetchImpl as unknown as typeof fetch).list()
    expect(robots[0]?.bridge_state.low_bandwidth).toBe(true)
    expect(robots[1]?.bridge_state.low_bandwidth).toBe(false)
  })

  it('resolves an empty array for a caller who reaches nothing — "nothing" is not "we did not look"', async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse({ robots: [] } satisfies ClientRobotListResponse))
    await expect(client(fetchImpl as unknown as typeof fetch).list()).resolves.toEqual([])
  })

  it('rejects with a FleetlessError on a refusal', async () => {
    const fetchImpl = fakeFetch(async () => errorResponse('unauthorized', 'Authentication is required.', 401))
    const promise = client(fetchImpl as unknown as typeof fetch).list()
    await expect(promise).rejects.toBeInstanceOf(FleetlessError)
    await expect(promise).rejects.toMatchObject({ code: 'unauthorized' })
  })
})

describe('robots.describe', () => {
  it('reads one robot\'s datasheet by id', async () => {
    const fetchImpl = fakeFetch(async (input) => {
      expect(String(input)).toBe('https://api.fleetless.dev/api/robots/robot1/datasheet')
      return jsonResponse(SHEET)
    })
    await expect(client(fetchImpl as unknown as typeof fetch).describe('robot1')).resolves.toEqual(SHEET)
  })

  // `pathSegment()` is proved against a real server in http.test.ts; this
  // confirms the route calls it for robotId.
  it('encodes a robotId shaped like a traversal attempt rather than sending it as a literal path segment', async () => {
    const fetchImpl = fakeFetch(async (input) => {
      expect(String(input)).toBe('https://api.fleetless.dev/api/robots/..%2F..%2Fadmin/datasheet')
      return jsonResponse(SHEET)
    })
    await client(fetchImpl as unknown as typeof fetch).describe('../../admin')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rejects not_found the same way any other robot-scoped read does', async () => {
    const fetchImpl = fakeFetch(async () => errorResponse('not_found', 'No robot with id robot1.', 404))
    await expect(client(fetchImpl as unknown as typeof fetch).describe('robot1')).rejects.toMatchObject({ code: 'not_found', status: 404 })
  })
})
