// SPDX-License-Identifier: MIT
import { vi } from 'vitest'
import type { WebSocketLike } from '../src/realtime.js'

/** Anything the fake WebSocket sent, decoded, in send order. */
export interface SentFrame {
  type: string
  [key: string]: unknown
}

/**
 * A minimal, controllable stand-in for `WebSocket`, tracked in
 * `FakeWebSocket.instances` so a test can reach the *current* socket after a
 * reconnect swaps it for a new one.
 */
export class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = []
  static reset(): void {
    FakeWebSocket.instances = []
  }

  readyState = 0 // CONNECTING
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  readonly sent: SentFrame[] = []
  readonly closeSpy = vi.fn()

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  /** Simulates the transport connecting — call explicitly, tests control timing. */
  simulateOpen(): void {
    this.readyState = 1 // OPEN
    this.onopen?.({})
  }

  simulateMessage(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  simulateClose(code = 1006, reason = 'abnormal'): void {
    this.readyState = 3 // CLOSED
    this.onclose?.({ code, reason })
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as SentFrame)
  }

  close(code?: number, reason?: string): void {
    this.closeSpy(code, reason)
    this.readyState = 3
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '' })
  }
}
