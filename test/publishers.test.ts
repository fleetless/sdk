// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientIdentity } from '@fleetless/contracts'
import { createClient, InMemoryTokenStore } from '../src/index.js'
import { FakeWebSocket } from './fake-websocket.js'

const IDENTITY: ClientIdentity = {
  kind: 'app_user',
  developer_id: null,
  app_user_id: 'u1',
  server_key_id: null,
  app_id: 'app1',
  role_id: 'role1',
  email: 'a@b.de',
}

function currentSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1)
  if (!socket) throw new Error('no FakeWebSocket was constructed')
  return socket
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function authenticate(): Promise<void> {
  await flush()
  currentSocket().simulateOpen()
  currentSocket().simulateMessage({ type: 'auth_ok', identity: IDENTITY })
}

beforeEach(() => {
  FakeWebSocket.reset()
})

function loggedInClient() {
  const tokenStore = new InMemoryTokenStore()
  tokenStore.save({ access_token: 'at1', refresh_token: 'rt1', expires_in: 900 })
  return createClient({
    apiUrl: 'https://api.fleetless.dev',
    appIdentifier: 'app_x',
    tokenStore,
    fetch: vi.fn() as unknown as typeof fetch,
    WebSocket: FakeWebSocket as unknown as typeof WebSocket,
  })
}

describe('publishers.publish', () => {
  it('sends publish with a request_id and resolves on ok:true', async () => {
    const client = loggedInClient()
    const promise = client.publishers.publish('robot1', 'cmd-vel', { linear: 0.5, angular: 0 })
    await authenticate()

    const sent = currentSocket().sent.find((f) => f.type === 'publish')
    expect(sent).toMatchObject({ type: 'publish', robot_id: 'robot1', slug: 'cmd-vel', message: { linear: 0.5, angular: 0 } })
    expect(typeof sent?.request_id).toBe('string')

    currentSocket().simulateMessage({ type: 'command_result', request_id: sent?.request_id, ok: true, job: null, code: null, message: null })
    await expect(promise).resolves.toBeUndefined()
  })

  it('rejects publisher_busy while another user holds the publisher', async () => {
    const client = loggedInClient()
    const promise = client.publishers.publish('robot1', 'cmd-vel', { linear: 1, angular: 0 })
    await authenticate()
    const requestId = currentSocket().sent.find((f) => f.type === 'publish')?.request_id

    currentSocket().simulateMessage({
      type: 'command_result',
      request_id: requestId,
      ok: false,
      job: null,
      code: 'publisher_busy',
      message: 'another user is publishing',
    })

    await expect(promise).rejects.toMatchObject({ code: 'publisher_busy' })
  })

  it('rejects robot_offline without ever resolving as though the message reached the robot', async () => {
    const client = loggedInClient()
    const promise = client.publishers.publish('robot1', 'cmd-vel', { linear: 1, angular: 0 })
    await authenticate()
    const requestId = currentSocket().sent.find((f) => f.type === 'publish')?.request_id

    currentSocket().simulateMessage({
      type: 'command_result',
      request_id: requestId,
      ok: false,
      job: null,
      code: 'robot_offline',
      message: 'robot is offline',
    })

    await expect(promise).rejects.toMatchObject({ code: 'robot_offline' })
  })
})
