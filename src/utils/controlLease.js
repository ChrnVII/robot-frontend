export function createControlLeaseCache({
  acquire,
  release,
  now = () => Date.now(),
  defaultTtlMs = 3000
}) {
  let current = null
  let pending = null

  async function replace(mode, reason) {
    const previous = current
    current = null

    // 先取新租约再释放旧的：服务端对同 holder 的重复申请是「续期」，
    // 会沿用同一个 lease_id。若先释放再申请，续期会把并发方刚拿到的租约顶掉；
    // 若申请回来的 id 与旧的一模一样，这里就绝不能再释放（那是刚续上的租约）。
    const lease = await acquire(mode)
    const id = lease?.leaseId || lease?.id || ''
    if (!id) throw new Error('后端未返回控制租约 leaseId，无法下发设备命令')
    if (previous && previous.id !== id) {
      try {
        await release(previous.id, reason)
      } catch {
        // A rejected or expired lease may already have been removed server-side.
      }
    }

    const acquiredAt = now()
    const expiresAt = Date.parse(lease?.expiresAt || lease?.expires_at || '')
    const ttlMs = Number.isFinite(expiresAt)
      ? Math.max(0, expiresAt - acquiredAt)
      : defaultTtlMs
    current = { id, mode, acquiredAt, ttlMs }
    return id
  }

  async function ensure(mode = 'manual_local') {
    if (current?.mode === mode && now() - current.acquiredAt < current.ttlMs * (2 / 3)) {
      return current.id
    }
    if (pending) {
      try {
        await pending.promise
      } catch {
        // A waiting caller gets its own acquisition attempt after the failed one.
      }
      return ensure(mode)
    }

    const reason = current ? (current.mode === mode ? 'lease_refresh' : 'mode_changed') : 'lease_missing'
    const promise = replace(mode, reason)
    pending = { promise }
    try {
      return await promise
    } finally {
      if (pending?.promise === promise) pending = null
    }
  }

  async function invalidate(id, reason = 'command_rejected') {
    if (!current || current.id !== id) return false
    const previous = current
    current = null
    try {
      await release(previous.id, reason)
    } catch {
      // Acquisition below still determines whether the server accepted the release.
    }
    return true
  }

  async function clear(reason = 'released') {
    const previous = current
    current = null
    if (!previous) return null
    return release(previous.id, reason)
  }

  return { ensure, invalidate, release: clear }
}
