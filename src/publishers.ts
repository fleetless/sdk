// SPDX-License-Identifier: MIT
import type { CommandTransport, SendCommandOptions } from './commands.js'

/**
 * One-way messages to a robot's publishers, reachable as
 * `client.publishers` — a velocity command, a goal pose, anything the
 * developer exposed as a publisher.
 */
export interface PublishersApi {
  /**
   * Publishes one message to a publisher.
   *
   * A plain method call — deliberately no deadman switch, rate governor or
   * "takt" helper. The bridge's own `timeout_ms` failsafe is the platform's
   * safety primitive: when messages stop arriving, crash included, the
   * bridge publishes its configured failsafe message. That does **not**
   * cover a caller who stops calling `publish` on purpose without stopping
   * cleanly (e.g. no repeated call at a safe rate) — how often and when to
   * publish is the app's pattern, not the SDK's. See the Publishers
   * section of the SDK reference before building a
   * publisher-driven control loop.
   *
   * Rejects `publisher_busy` while a different user is publishing and has
   * not been quiet for its configured quiet timeout yet — whoever publishes
   * holds the publisher implicitly exclusive.
   */
  publish(robotId: string, slug: string, message: Record<string, unknown>, options?: SendCommandOptions): Promise<void>
}

export function createPublishersApi(transport: CommandTransport): PublishersApi {
  return {
    async publish(robotId, slug, message, options) {
      await transport.publish(robotId, slug, message, options)
    },
  }
}
