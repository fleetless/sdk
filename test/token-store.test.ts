// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest'
import { InMemoryTokenStore } from '../src/index.js'

describe('InMemoryTokenStore', () => {
  it('starts empty', () => {
    expect(new InMemoryTokenStore().load()).toBeNull()
  })

  it('round-trips a saved session', () => {
    const store = new InMemoryTokenStore()
    const session = { access_token: 'a', refresh_token: 'r', expires_in: 900 }
    store.save(session)
    expect(store.load()).toEqual(session)
  })

  it('clears on save(null)', () => {
    const store = new InMemoryTokenStore()
    store.save({ access_token: 'a', refresh_token: 'r', expires_in: 900 })
    store.save(null)
    expect(store.load()).toBeNull()
  })

  it('keeps two instances independent', () => {
    const a = new InMemoryTokenStore()
    const b = new InMemoryTokenStore()
    a.save({ access_token: 'a', refresh_token: 'r', expires_in: 900 })
    expect(b.load()).toBeNull()
  })
})
