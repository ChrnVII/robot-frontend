import assert from 'node:assert/strict'
import test from 'node:test'
import { createControlLeaseCache } from '../src/utils/controlLease.js'

test('refreshes a lease after two thirds of its lifetime and releases the old lease', async () => {
  let now = 1000
  let nextId = 1
  const acquired = []
  const released = []
  const cache = createControlLeaseCache({
    now: () => now,
    acquire: async (mode) => {
      const leaseId = `lease-${nextId++}`
      acquired.push({ leaseId, mode })
      return { leaseId, expiresAt: new Date(now + 3000).toISOString() }
    },
    release: async (leaseId, reason) => released.push({ leaseId, reason })
  })

  assert.equal(await cache.ensure(), 'lease-1')
  now += 1999
  assert.equal(await cache.ensure(), 'lease-1')
  assert.equal(acquired.length, 1)

  now += 1
  assert.equal(await cache.ensure(), 'lease-2')
  assert.deepEqual(released, [{ leaseId: 'lease-1', reason: 'lease_refresh' }])
})

test('invalidating a rejected lease releases it before the next acquisition', async () => {
  let nextId = 1
  const released = []
  const cache = createControlLeaseCache({
    acquire: async () => ({ leaseId: `lease-${nextId++}` }),
    release: async (leaseId, reason) => released.push({ leaseId, reason })
  })

  const first = await cache.ensure()
  assert.equal(await cache.invalidate(first), true)
  assert.equal(await cache.invalidate(first), false)
  assert.equal(await cache.ensure(), 'lease-2')
  assert.deepEqual(released, [{ leaseId: 'lease-1', reason: 'command_rejected' }])
})

test('does not release a lease the server renewed in place', async () => {
  // 服务端对同 holder 的重复申请是「续期」，lease_id 不变：
  // 此时若把 previous 释放掉，就等于把刚续上的租约删了。
  let now = 1000
  const released = []
  const cache = createControlLeaseCache({
    now: () => now,
    acquire: async () => ({ leaseId: 'lease-same', expiresAt: new Date(now + 3000).toISOString() }),
    release: async (leaseId, reason) => released.push({ leaseId, reason })
  })

  assert.equal(await cache.ensure(), 'lease-same')
  now += 2001
  assert.equal(await cache.ensure(), 'lease-same')
  assert.deepEqual(released, [])
})

test('concurrent lease requests share one acquisition', async () => {
  let acquisitions = 0
  const cache = createControlLeaseCache({
    acquire: async () => {
      acquisitions += 1
      await Promise.resolve()
      return { leaseId: 'lease-1' }
    },
    release: async () => {}
  })

  assert.deepEqual(await Promise.all([cache.ensure(), cache.ensure()]), ['lease-1', 'lease-1'])
  assert.equal(acquisitions, 1)
})
