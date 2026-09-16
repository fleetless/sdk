// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest'
import { FleetlessError, SDK_ERROR_CODES } from '../src/index.js'

describe('SDK_ERROR_CODES', () => {
  it('lists exactly the codes the SDK produces itself rather than relaying from the server', () => {
    // Deliberately not part of @fleetless/contracts' ERROR_CODES: that's
    // the wire vocabulary, every entry something a server may send. None
    // of these are.
    expect(SDK_ERROR_CODES).toEqual([
      'no_session',
      'no_websocket',
      'unparseable_error',
      'command_timeout',
      'command_outcome_unknown',
      'unexpected_response',
      'invalid_option',
      'untrusted_absolute_url',
      'state_mismatch',
      'no_urdf_synced',
      'aborted',
    ])
  })
})

describe('FleetlessError', () => {
  it('carries a stable code a caller can branch on, separate from the message', () => {
    const error = new FleetlessError('forbidden', 'You do not have access to this datapoint.')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('FleetlessError')
    expect(error.code).toBe('forbidden')
    expect(error.message).toBe('You do not have access to this datapoint.')
    expect(error.details).toBeUndefined()
    expect(error.status).toBeUndefined()
  })

  it('carries validation details and the originating http status when given', () => {
    const error = new FleetlessError('validation_error', 'Invalid request.', {
      details: { field: 'email', rule: 'format' },
      status: 400,
    })
    expect(error.details).toEqual({ field: 'email', rule: 'format' })
    expect(error.status).toBe(400)
  })
})
