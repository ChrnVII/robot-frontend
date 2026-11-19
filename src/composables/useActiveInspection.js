// 当前正在跑的检测/采集任务：巡检域只有一个任务槽位，全局共用这份状态。
//
// 为什么需要：inspection-worker 里 `_thread` 非空就拒绝第二个 start（后端已映射成
// 409 TASK_BUSY）。前端如果不显示"正在跑什么"，用户在检测页跑着的时候去点采集，
// 只会看到一个失败提示，误以为系统坏了。状态在 worker 进程里，刷新页面不会丢。
import { computed, onBeforeUnmount, ref } from 'vue'
import { getActiveInspection } from '@/api/inspection'
import { unwrap } from '@/api/envelope'
import { getErrorMessage } from '@/utils/request'

const POLL_INTERVAL = 5000

export function useActiveInspection() {
  const task = ref(null)          // null / { taskRunId, state, taskName, outputDir, startedAt, ... }
  const error = ref('')
  const loading = ref(false)

  let timer = null
  let pending = false
  let disposed = false

  const taskRunId = computed(() => String(task.value?.taskRunId || ''))
  // starting / running / stopping 都算"占用槽位"：stopping 期间也不能再起一个。
  const state = computed(() => String(task.value?.state || 'idle'))
  const busy = computed(() => ['starting', 'running', 'stopping'].includes(state.value))

  /** 已用秒数：后端给 startedAt（ISO 或 epoch 秒），前端只做展示。 */
  const elapsedSeconds = computed(() => {
    const raw = task.value?.startedAt
    if (!raw) return null
    const started = typeof raw === 'number' ? raw * 1000 : Date.parse(String(raw))
    if (!Number.isFinite(started)) return null
    return Math.max(0, Math.round((Date.now() - started) / 1000))
  })

  async function refresh() {
    if (pending || disposed) return null
    pending = true
    loading.value = true
    try {
      const value = unwrap(await getActiveInspection(), {}) || {}
      // idle 也返回对象（{state:'idle'}），统一收敛成 null 更好用。
      task.value = value.state && value.state !== 'idle' && value.taskRunId ? value : null
      error.value = ''
      return task.value
    } catch (reason) {
      // 读不到就保留上一次结论：一次网络抖动不该把"正在采集"的提示抹掉。
      error.value = getErrorMessage(reason, '读取当前任务失败')
      return task.value
    } finally {
      pending = false
      loading.value = false
    }
  }

  function start(interval = POLL_INTERVAL) {
    stop()
    disposed = false
    refresh()
    timer = window.setInterval(() => {
      if (!document.hidden) refresh()
    }, interval)
  }

  function stop() {
    if (timer) window.clearInterval(timer)
    timer = null
  }

  function dispose() {
    disposed = true
    stop()
  }

  onBeforeUnmount(dispose)

  return { task, taskRunId, state, busy, elapsedSeconds, error, loading, refresh, start, stop }
}
