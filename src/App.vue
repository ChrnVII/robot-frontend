<script setup>
// 应用外壳：左侧固定导航 + 右侧页面内容。
// 导航项与 api/dashboard.js 的模块定义同源，新增页面只需改一处；
// 侧栏的在线状态由 usePlatformStatus 轮询得到，不再是"挂载时查一次"的假灯。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterView } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import AppSidebar from '@/components/AppSidebar.vue'
import { usePlatformStatus } from '@/composables/usePlatformStatus'
import { useActiveInspection } from '@/composables/useActiveInspection'
import { getRobotState } from '@/api/telemetry'
import { emergencyStop, resetEmergency } from '@/api/safety'
import { unwrap } from '@/api/envelope'

const platform = usePlatformStatus()

// 巡检域只有一个任务槽位：外壳层持续感知"正在跑什么"，侧栏常驻提示。
// 放在这里而不是各页面各查一次，避免检测页/采集页各写一套而状态不一致。
const activeInspection = useActiveInspection()
const activeTask = computed(() => activeInspection.task.value)

/* ------------------------------ 全局急停 ------------------------------ */
// 急停是锁存语义：触发后 robot-core 会一直拒绝升降/底盘/任务命令，必须显式复位。
// 所以外壳层要持续知道它是否处于锁存态——否则用户在检测页按了急停，
// 走到别的页面看不出机器人已经停住、也找不到复位入口。
const emergency = ref(false)
const estopBusy = ref(false)
let estopTimer = null
let estopPending = false

async function loadEmergency() {
  if (estopPending) return
  estopPending = true
  try {
    const state = unwrap(await getRobotState(), {}) || {}
    const value = String(state.state || state.status || '')
    emergency.value = /emergency/i.test(value)
  } catch {
    /* 读不到就沿用上一次的结论：不能因为一次失败就把锁存提示清掉 */
  } finally {
    estopPending = false
  }
}

function startEstopPolling() {
  loadEmergency()
  estopTimer = window.setInterval(() => {
    if (!document.hidden) loadEmergency()
  }, 8000)
}

async function handleEstop() {
  try {
    await ElMessageBox.confirm(
      '急停会立即停止底盘运动与升降，并进入锁存状态（需复位后才能重新动作）。确认执行？',
      '确认急停',
      { type: 'warning', confirmButtonText: '立即急停', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  estopBusy.value = true
  try {
    await emergencyStop('operator_pressed_global_stop')
    emergency.value = true
    ElMessage.error('已急停：底盘与升降已停止，请排除问题后点击「急停复位」')
  } catch (reason) {
    ElMessage.error(reason?.message || '急停下发失败，请就近按下物理急停')
  } finally {
    estopBusy.value = false
  }
}

async function handleEstopReset() {
  try {
    await ElMessageBox.confirm(
      '复位会解除急停锁，升降与底盘将重新接受指令。确认现场已安全？',
      '解除急停',
      { type: 'warning', confirmButtonText: '确认复位', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  estopBusy.value = true
  try {
    await resetEmergency('operator_reset_global')
    emergency.value = false
    ElMessage.success('急停已复位')
  } catch (reason) {
    ElMessage.error(reason?.message || '急停复位失败')
  } finally {
    estopBusy.value = false
  }
}

// 健康检查与平台信息失败时原因通常相同（都在连同一个后端），
// 横幅只取第一条，完整信息挂在 title 上，避免条带占两行把内容往下推。
const shortError = computed(() => String(platform.error || '健康检查未通过').split('；')[0])

// 横幅分两级：
//   offline  —— 后端进程本身连不上（断网 / 服务挂了），整站数据都不可信；
//   degraded —— 后端在，但 robot-core 未就绪（串口崩、核心进程挂了），
//              设备数据与命令会失败，但页面框架、历史数据仍可用。
// 急停锁存态优先级最高，盖过在线状态横幅
const banner = computed(() => {
  if (emergency.value) {
    return {
      tone: 'danger',
      text: '急停已触发并锁存：底盘、升降与任务指令全部被拒绝，排除现场问题后点击「急停复位」。'
    }
  }
  if (platform.status === 'offline') {
    return { tone: 'danger', text: `后端连接中断：${shortError.value}。页面数据可能不是最新的。` }
  }
  if (platform.status === 'degraded') {
    return {
      tone: 'warning',
      text: `机器人核心未就绪（robot-core: ${platform.coreStatus || 'unavailable'}）：设备读数与指令暂时不可用，任务与相机页会报错。`
    }
  }
  return null
})

onMounted(() => {
  platform.start()
  startEstopPolling()
  activeInspection.start()
})

onBeforeUnmount(() => {
  if (estopTimer) window.clearInterval(estopTimer)
  estopTimer = null
})

async function retry() {
  await platform.refresh()
  // platform 是 reactive 对象，属性已解包，直接读布尔值
  ElMessage[platform.online ? 'success' : 'warning'](
    platform.online
      ? '后端已恢复连接'
      : platform.reachable
        ? '后端在线，但机器人核心仍未就绪'
        : '仍然无法连接后端，请检查服务'
  )
}
</script>

<template>
  <div class="app-shell">
    <AppSidebar
      :status="platform.status"
      :status-text="platform.statusText"
      :status-hint="platform.statusHint"
      :robot-id="platform.robotId"
      :open-alerts="platform.openAlerts"
      :checked-at="platform.checkedAt"
      :emergency="emergency"
      :estop-busy="estopBusy"
      :active-task="activeTask"
      @estop="handleEstop"
      @estop-reset="handleEstopReset"
    />

    <section class="app-main">
      <div v-if="banner" class="offline-banner" :class="`offline-banner--${banner.tone}`" role="alert">
        <span class="offline-banner__dot" aria-hidden="true" />
        <span class="offline-banner__text" :title="platform.error || banner.text">
          {{ banner.text }}
        </span>
        <el-button
          v-if="emergency"
          size="small"
          type="danger"
          :loading="estopBusy"
          @click="handleEstopReset"
        >急停复位</el-button>
        <el-button v-else size="small" type="primary" plain :icon="Refresh" @click="retry">重新检测</el-button>
      </div>

      <main class="page-content">
        <RouterView v-slot="{ Component, route }">
          <transition name="route-fade" mode="out-in">
            <component :is="Component" :key="route.path" />
          </transition>
        </RouterView>
      </main>
    </section>
  </div>
</template>

<style scoped>
.app-shell {
  height: 100%;
  display: flex;
  overflow: hidden;
  background: var(--app-bg);
}

.app-main {
  min-width: 0;
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  /* 内容自身的横向滚动交给表格内部处理，外层不再整体横移 */
  overflow-x: hidden;
  overflow-y: auto;
}

.page-content {
  padding: 24px var(--app-page-gutter) 36px;
  flex: 1;
  min-width: 0;
  max-width: 100%;
}

/* 离线条常驻在内容顶部：比只在侧栏点一个小红点更容易被注意到 */
.offline-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 16px;
  border-bottom: 1px solid transparent;
  font-size: 13px;
}

/* 后端断开：红色，最严重 */
.offline-banner--danger {
  background: rgb(214 69 69 / 8%);
  border-bottom-color: rgb(214 69 69 / 22%);
  color: var(--app-danger);
}

/* 核心未就绪：琥珀色，页面能用但设备层不可信 */
.offline-banner--warning {
  background: rgb(214 145 47 / 10%);
  border-bottom-color: rgb(214 145 47 / 26%);
  color: #a96a12;
}

/* 深色背景下 8% 的红色几乎看不见，提高不透明度 */
:global(html.dark) .offline-banner--danger {
  background: rgb(240 115 111 / 14%);
  border-bottom-color: rgb(240 115 111 / 32%);
  color: #ffa8a4;
}

:global(html.dark) .offline-banner--warning {
  background: rgb(230 162 60 / 16%);
  border-bottom-color: rgb(230 162 60 / 34%);
  color: #f0c179;
}

.offline-banner__dot {
  width: 8px;
  height: 8px;
  flex: 0 0 8px;
  border-radius: 50%;
  background: currentColor;
}

.offline-banner__text {
  flex: 1;
  min-width: 0;
  /* 单行省略：不换行时按钮才有位置留在一行内；完整信息在 title 里 */
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

@media (max-width: 900px) {
  .page-content {
    padding: 16px var(--app-page-gutter) 28px;
  }

  .offline-banner {
    font-size: 12px;
    gap: 8px;
  }

  /* 窄屏文案截一半就够了，按钮必须完整可见 */
  .offline-banner__text {
    flex: 1 1 120px;
  }
}
</style>
