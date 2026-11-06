// SPDX-License-Identifier: MIT
import { FleetlessError } from './errors.js'

/**
 * A collection filter as JSON text: what `collections.list` puts in its query
 * and what `collections.subscribe` copies its filter from.
 *
 * A filter is JSON by contract, so it is written as JSON. That also reads a
 * Proxy, which is what a Vue `reactive`, a Svelte `$state` or a MobX observable
 * hands over and `structuredClone` refuses with a `DataCloneError`. What JSON
 * cannot hold is refused here with the cause named, instead of being dropped
 * or sent as `null` (a number that is not finite) or failing with a bare
 * `TypeError` (a BigInt, a cycle): `invalid_option`, before anything is sent.
 */
export function filterJson(filter: Record<string, unknown>): string {
  try {
    const text = JSON.stringify(filter, (_key, value: unknown) => {
      const kind = typeof value
      if (kind === 'function' || kind === 'symbol' || kind === 'bigint') throw new TypeError(`a ${kind} is not JSON`)
      if (kind === 'number' && !Number.isFinite(value)) throw new TypeError(`${String(value)} is not JSON`)
      return value
    }) as string | undefined
    if (text === undefined) throw new TypeError('it has no JSON form')
    return text
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    throw new FleetlessError('invalid_option', `The filter of a collection call has to be plain JSON, and this one is not: ${why}.`)
  }
}

/** A copy of the filter that nothing the caller does to its own object later can reach. */
export function copyFilter(filter: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(filterJson(filter)) as Record<string, unknown>
}
