// 平台状态：健康检查、设备信息与待处理告警数的真实轮询。
//
// 改造前 App.vue 只在 onMounted 查一次 /healthz，侧栏的绿点从此再不更新：
// 后端跑挂了，界面依然显示「系统在线」。这里改成固定间隔轮询，
// 并且真正把「检测中 / 在线 / 离线」三态映射到指示灯上。
import { computed, onBeforeUnmount, reactive, ref } from 'vue'
import { getHealth, getPlatformInfo } from '@/api/system'
import { fetchAlertsPage } from '@/api/alerts'
import { unwrap } from '@/api/envelope'
import { useAlertNotifier } from './useAlertNotifier'

//: 健康检查间隔：比遥测（10s）慢，比人工刷新快，足以在 30s 内发现后端异常。
const HEALTH_INTERVAL = 30000
//: 告警数间隔：角标要"及时但不打扰"，20s 是折中值。
const ALERT_INTERVAL = 20000

export function usePlatformStatus() {
  const notifier = useAlertNotifier()

  const online = ref(false)
  const checked = ref(false) // 是否完成过一次检查（决定显示「检测中」还是「离线」）
  const robotId = ref('')
  const robotName = ref('')
  const openAlerts = ref(0)
  const checkedAt = ref('')
  const error = ref('')
  const latencyMs = ref(null)

  let healthTimer = null
  let alertTimer = null
  let alertBaselineReady = false
  let disposed = false
  let healthPending = false
  let alertsPending = false

  const status = computed(() => {
    if (!checked.value) return 'checking'
    return online.value ? 'online' : 'offline'
  })

  const statusText = computed(() => {
    if (status.value === 'checking') return '正在检测后端'
    return online.value ? '系统在线' : '后端离线'
  })

  const statusHint = computed(() => {
    if (error.value) return error.value
    if (status.value === 'checking') return '首次健康检查进行中'
    if (!online.value) return '健康检查未通过，请检查后端服务'
    return latencyMs.value === null ? '后端连接正常' : `后端连接正常 · ${latencyMs.value} ms`
  })

  async function checkHealth() {
    if (healthPending || disposed) return
    healthPending = true
    const startedAt = performance.now()
    try {
      const [healthResult, platformResult] = await Promise.allSettled([
        getHealth(),
        getPlatformInfo()
      ])
      if (disposed) return

      const health = healthResult.status === 'fulfilled' ? unwrap(healthResult.value, null) : null
      const info = platformResult.status === 'fulfilled' ? unwrap(platformResult.value, {}) : {}

      online.value = Boolean(health)
      latencyMs.value = Math.round(performance.now() - startedAt)
      robotId.value = info?.robotId || health?.robotId || robotId.value
      robotName.value = info?.name || health?.name || robotName.value

      const failures = []
      if (healthResult.status === 'rejected') {
        failures.push(`健康检查：${healthResult.reason?.message || '失败'}`)
      }
      if (platformResult.status === 'rejected') {
        failures.push(`平台信息：${platformResult.reason?.message || '失败'}`)
      }
      error.value = failures.join('；')
      checkedAt.value = new Date().toISOString()
    } finally {
      // 即使两个接口都失败也要落 checked，否则界面会一直停在「检测中」。
      checked.value = true
      healthPending = false
    }
  }

  async function checkAlerts() {
    if (alertsPending || disposed) return
    alertsPending = true
    try {
      // 只取一条：用 total 拿数量，用首条内容做通知正文，
      // 不把整张告警表拉到浏览器再数。
      const { rows, total } = await fetchAlertsPage({ status: 'open', page: 1, pageSize: 1 })
      if (disposed) return
      const previous = openAlerts.value
      openAlerts.value = total
      // 首次拿到数字只作为基线，避免刚打开页面就把历史告警全弹一遍。
      if (alertBaselineReady && total > previous) {
        const latest = rows[0] || {}
        notifier.notifyNewAlerts(total - previous, latest.content || latest.message || '')
      }
      alertBaselineReady = true
    } catch {
      /* 告警数读取失败不影响主状态灯，下一轮自动重试 */
    } finally {
      alertsPending = false
    }
  }

  /** 立即刷新一次待处理告警数（告警页处理完一条后调用，角标马上跟着变）。 */
  function refreshAlertsNow() {
    return checkAlerts()
  }

  // 告警页增删改之后广播事件：不用等 20s 轮询，侧栏角标立刻更新。
  function handleAlertsChanged() {
    refreshAlertsNow()
  }

  function startTimers() {
    stopTimers()
    if (disposed) return
    healthTimer = window.setInterval(checkHealth, HEALTH_INTERVAL)
    alertTimer = window.setInterval(checkAlerts, ALERT_INTERVAL)
  }

  function stopTimers() {
    if (healthTimer) {
      window.clearInterval(healthTimer)
      healthTimer = null
    }
    if (alertTimer) {
      window.clearInterval(alertTimer)
      alertTimer = null
    }
  }

  // 页面不可见时暂停轮询：后台标签页没有用户在看，继续打接口只是浪费。
  // 恢复可见时立刻补一次，保证回到页面时看到的是最新状态。
  function handleVisibility() {
    if (document.hidden) {
      stopTimers()
      return
    }
    checkHealth()
    checkAlerts()
    startTimers()
  }

  function start() {
    disposed = false
    checkHealth()
    checkAlerts()
    startTimers()
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('alerts:changed', handleAlertsChanged)
  }

  function stop() {
    disposed = true
    stopTimers()
    document.removeEventListener('visibilitychange', handleVisibility)
    window.removeEventListener('alerts:changed', handleAlertsChanged)
  }

  onBeforeUnmount(stop)

  // 用 reactive 包一层：调用方（App.vue）是整体使用这个对象而不是解构，
  // 普通对象里嵌 ref 的话，模板中的 platform.status 拿到的是 ref 本身而不是字符串，
  // 会导致 :status="platform.status" 传进一个对象、离线横幅永远不出现。
  return reactive({
    online,
    checked,
    status,
    statusText,
    statusHint,
    robotId,
    robotName,
    openAlerts,
    checkedAt,
    error,
    latencyMs,
    start,
    stop,
    refresh: checkHealth,
    refreshAlertsNow
  })
}
