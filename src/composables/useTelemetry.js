// 遥测数据统一出口：先读快照，再按固定间隔轮询，并在 WebSocket 可用时升级为推送。
// 页面只拿到 { state, environment, telemetry, loading, error, updatedAt, refresh }。
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import {
  getEnvironmentState, getRobotState, normalizeEnvironment, normalizeTelemetry,
  openEnvironmentStream, openStateStream, robotStateToTelemetry
} from '@/api/telemetry'
import { getErrorMessage } from '@/utils/request'

const POLL_INTERVAL = 10000
const MAX_RECONNECT_DELAY = 15000

export function useTelemetry(options = {}) {
  const { interval = POLL_INTERVAL, realtime = true, immediate = true } = options

  const state = shallowRef(null)
  const environment = shallowRef(null)
  const telemetry = shallowRef({})
  const loading = ref(false)
  const error = ref('')
  const updatedAt = ref('')

  let pollTimer = null
  let reconnectTimer = null
  let reconnectAttempts = 0
  let disposed = false
  let closing = []

  function apply(nextState, nextEnvironment) {
    if (nextState) state.value = nextState
    if (nextEnvironment) environment.value = nextEnvironment
    telemetry.value = robotStateToTelemetry(nextState || {}, nextEnvironment || {}, telemetry.value)
    updatedAt.value = new Date().toISOString()
  }

  async function refresh() {
    if (disposed) return
    loading.value = true
    try {
      // 状态是主数据；环境接口可独立失败，不应拖垮整页。
      const [stateResult, environmentResult] = await Promise.allSettled([
        getRobotState(),
        getEnvironmentState()
      ])
      if (disposed) return
      if (stateResult.status === 'rejected') throw stateResult.reason
      const nextState = normalizeTelemetry(stateResult.value)
      const nextEnvironment = environmentResult.status === 'fulfilled'
        ? normalizeEnvironment(environmentResult.value)
        : null
      apply(nextState, nextEnvironment)
      error.value = environmentResult.status === 'rejected'
        ? `环境数据读取失败：${getErrorMessage(environmentResult.reason)}`
        : ''
    } catch (reason) {
      if (disposed) return
      error.value = getErrorMessage(reason)
    } finally {
      if (!disposed) loading.value = false
    }
  }

  function startPolling() {
    stopPolling()
    pollTimer = window.setInterval(refresh, interval)
  }

  function stopPolling() {
    if (pollTimer) {
      window.clearInterval(pollTimer)
      pollTimer = null
    }
  }

  function scheduleReconnect() {
    if (disposed || !realtime || reconnectTimer) return
    const delay = Math.min(1000 * (2 ** reconnectAttempts), MAX_RECONNECT_DELAY)
    reconnectAttempts += 1
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      if (!disposed && realtime) connectRealtime()
    }, delay)
  }

  // WebSocket 只是低延迟补充：连不上或断开时轮询继续工作，并指数退避重连。
  function connectRealtime() {
    if (!realtime || disposed || typeof WebSocket === 'undefined') return
    closeRealtime()
    const handlers = {
      onOpen: () => { reconnectAttempts = 0 },
      onClose: scheduleReconnect,
      onError: () => {}
    }
    const sockets = [
      openStateStream((payload) => apply(normalizeTelemetry(payload), null), handlers),
      openEnvironmentStream((payload) => apply(null, normalizeEnvironment(payload)), handlers)
    ].filter(Boolean)
    closing = sockets.map((socket) => () => {
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      socket.close()
    })
  }

  function closeRealtime() {
    closing.forEach((close) => {
      try {
        close()
      } catch (reason) {
        console.warn('实时通道关闭失败', reason)
      }
    })
    closing = []
  }

  function start() {
    if (disposed) return
    refresh()
    startPolling()
    connectRealtime()
  }

  function stop() {
    disposed = true
    stopPolling()
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    closeRealtime()
  }

  if (immediate) start()
  onBeforeUnmount(stop)

  return {
    state,
    environment,
    telemetry,
    loading: computed(() => loading.value),
    error: computed(() => error.value),
    updatedAt: computed(() => updatedAt.value),
    refresh,
    start,
    stop
  }
}