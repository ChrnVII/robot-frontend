<script setup>
// 运行总览：只读地汇总平台、机器人、任务和告警概况，并提供功能模块入口。
// 数据全部来自 api/dashboard.js 的聚合快照，页面不拼装任何请求路径。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Bell, Monitor, Refresh, Timer } from '@element-plus/icons-vue'
import PageHeader from '@/components/PageHeader.vue'
import AsyncSection from '@/components/AsyncSection.vue'
import InfoGroupCard from '@/components/InfoGroupCard.vue'
import { DASHBOARD_MODULES, loadDashboard } from '@/api/dashboard'
import { alertLevelMeta } from '@/api/alerts'
import { useAsyncData } from '@/composables/useAsyncData'
import { useRefreshFeedback } from '@/composables/useRefreshFeedback'
import { useBreakpoint } from '@/composables/useBreakpoint'
import { moduleIcon } from '@/composables/useModuleMeta'
import { displayNumber, fixedNumber, formatTime } from '@/utils/format'

const router = useRouter()
const { refresh: refreshWithFeedback } = useRefreshFeedback()

// 设备状态表在窄屏从 4 列降到 2 列，否则每格只有几十像素宽。
const isNarrow = useBreakpoint()
const descColumns = computed(() => (isNarrow.value ? 2 : 4))

//: 总览页是看板：默认 8s 自动刷新。页面不可见时暂停，避免后台标签页空转。
const AUTO_REFRESH_MS = 8000
const autoRefresh = ref(readAutoRefresh())
const manualRefreshing = ref(false)
let timer = null

function readAutoRefresh() {
  try {
    return localStorage.getItem('home-auto-refresh') !== 'off'
  } catch {
    return true
  }
}

const { data, loading, error, load } = useAsyncData(() => loadDashboard(), { initialData: null })

const telemetry = computed(() => data.value?.telemetry || {})
const platform = computed(() => data.value?.platform || {})
const alerts = computed(() => data.value?.alerts || { total: 0, open: 0, recent: [] })
const tasks = computed(() => data.value?.tasks || { total: 0, enabled: 0 })
const online = computed(() => data.value?.health?.online === true)

// 首次加载用骨架；后续自动刷新直接替换数据，页面不闪。
const showSkeleton = computed(() => loading.value && !data.value && !error.value)

const platformStatus = computed(() => {
  if (!data.value) return { text: '读取中', type: 'info' }
  return online.value
    ? { text: '系统在线', type: 'success' }
    : { text: '系统离线', type: 'danger' }
})

const robotHint = computed(() => {
  const parts = [
    platform.value.mode && `模式 ${platform.value.mode}`,
    platform.value.apiVersion && `API ${platform.value.apiVersion}`
  ]
  return parts.filter(Boolean).join(' · ') || '等待后端上报'
})

// —— 顶部三张分组卡的数据 ——
// 原则：只展示后端真实上报的字段；读不到的（后端未实现或设备未上报）一律显示横杠，
// 不拿 0 顶替，否则"没有数据"会被误读成"读数是 0"。
const DASH = '—'

function hasReading(value) {
  return value !== null && value !== undefined && value !== ''
}

/** 单条读数行：定点小数 + 单位 + 缺失兜底（缺失时不带单位，避免出现 "— %"）。 */
function readingRow(label, value, { digits = 0, unit = '' } = {}) {
  const text = fixedNumber(value, digits)
  return { label, value: text, unit: text === DASH ? '' : unit, mono: true }
}

// 运行状态来自 robot-core 的 health.state（idle / running / charging / emergency / degraded…）。
const robotStatus = computed(() => {
  const raw = telemetry.value.status
  if (!hasReading(raw)) return { text: DASH, tone: 'muted' }
  const text = String(raw)
  if (/error|fail|emergency|stopped/i.test(text)) return { text, tone: 'danger' }
  if (/running|charging/i.test(text)) return { text, tone: 'active' }
  return { text, tone: 'idle' }
})

// 电量：后端给的是 0–100 的一位小数，展示取整；非数值视为未上报。
const batteryReading = computed(() => {
  const raw = telemetry.value.battery
  if (!hasReading(raw)) return null
  const value = Number(raw)
  if (!Number.isFinite(value)) return null
  return Math.round(Math.min(100, Math.max(0, value)))
})

const robotRows = computed(() => [
  { label: 'robot_id', value: platform.value.robotId || DASH, mono: true },
  { label: '名称', value: platform.value.name || telemetry.value.name || DASH },
  {
    label: '电量',
    value: batteryReading.value === null ? DASH : String(batteryReading.value),
    unit: batteryReading.value === null ? '' : '%',
    tone: 'primary'
  }
])

// 电量条只在有读数时出现；颜色按 60/25 两档阈值语义化，正常区间保持主色。
const batteryProgress = computed(() => {
  if (batteryReading.value === null) return null
  const tone = batteryReading.value >= 60 ? '' : batteryReading.value >= 25 ? 'warning' : 'danger'
  return { value: batteryReading.value, tone }
})

// 任务/告警计数直接读聚合快照；快照还没到（如接口失败）时给横杠而不是 0。
const statusRows = computed(() => {
  const taskStats = data.value?.tasks
  const alertStats = data.value?.alerts
  return [
    {
      label: '启用任务',
      value: taskStats ? String(taskStats.enabled) : DASH,
      unit: taskStats ? '个' : '',
      hint: taskStats ? `· 共 ${taskStats.total}` : ''
    },
    {
      label: '待处理告警',
      value: alertStats ? String(alertStats.open) : DASH,
      unit: alertStats ? '条' : '',
      hint: alertStats ? `· 累计 ${alertStats.total}` : '',
      tone: alertStats && alertStats.open > 0 ? 'danger' : ''
    },
    readingRow('CPU', telemetry.value.cpu, { digits: 0, unit: '%' }),
    readingRow('磁盘', telemetry.value.disk, { digits: 0, unit: '%' })
  ]
})

// 环境四路读数来自 devices.environment.values（温湿度 / 光照 / 风速），与移动底盘页同源。
const environmentRows = computed(() => [
  readingRow('温度', telemetry.value.temperature, { digits: 1, unit: '℃' }),
  readingRow('湿度', telemetry.value.humidity, { digits: 1, unit: '%' }),
  readingRow('光照', telemetry.value.light, { digits: 0, unit: 'lx' }),
  readingRow('风速', telemetry.value.wind, { digits: 1, unit: 'm/s' })
])

// 只有任务存在时才谈"运行中/已暂停"，否则显示占位符而不是误导性的状态。
const taskStateText = computed(() => {
  if (telemetry.value.task === undefined || telemetry.value.task === null || telemetry.value.task === '') {
    return '—'
  }
  return `${telemetry.value.task} · ${telemetry.value.paused ? '已暂停' : '运行中'}`
})

const updatedText = computed(() => (data.value ? formatTime(new Date()) : ''))

onMounted(() => {
  load()
  startTimer()
  document.addEventListener('visibilitychange', handleVisibility)
})

onBeforeUnmount(() => {
  stopTimer()
  document.removeEventListener('visibilitychange', handleVisibility)
})

function startTimer() {
  stopTimer()
  if (!autoRefresh.value) return
  timer = window.setInterval(() => {
    // 正在首次加载或已有请求在飞时不叠加请求
    if (!loading.value) load()
  }, AUTO_REFRESH_MS)
}

function stopTimer() {
  if (timer) {
    window.clearInterval(timer)
    timer = null
  }
}

function handleVisibility() {
  if (document.hidden) {
    stopTimer()
    return
  }
  // 回到页面立刻补一次，然后恢复轮询
  if (autoRefresh.value && !loading.value) load()
  startTimer()
}

function toggleAutoRefresh(value) {
  autoRefresh.value = value
  try {
    localStorage.setItem('home-auto-refresh', value ? 'on' : 'off')
  } catch {
    /* 隐私模式忽略 */
  }
  if (value) startTimer()
  else stopTimer()
}

async function manualRefresh() {
  if (manualRefreshing.value) return
  manualRefreshing.value = true
  try {
    await refreshWithFeedback(async () => (await load()) !== undefined, {
      success: '总览数据已刷新',
      failure: '总览刷新失败'
    })
  } finally {
    manualRefreshing.value = false
  }
}

function openModule(path) {
  router.push(path)
}
</script>

<template>
  <div class="view home-view">
    <PageHeader
      title="运行总览"
      :description="platform.name || platform.robotId ? `当前设备 ${platform.name || ''} ${platform.robotId || ''}`.trim() : '机器人平台概况'"
      :status-text="platformStatus.text"
      :status-type="platformStatus.type"
      :updated-at="updatedText"
    >
      <template #extra>
        <label class="auto-refresh" :title="`开启后每 ${AUTO_REFRESH_MS / 1000} 秒自动刷新；页面切到后台时暂停`">
          <el-switch
            :model-value="autoRefresh"
            size="small"
            @update:model-value="toggleAutoRefresh"
          />
          <span class="auto-refresh__label">
            <el-icon><Timer /></el-icon>
            自动刷新
          </span>
        </label>
        <el-button :icon="Refresh" :loading="manualRefreshing" @click="manualRefresh">刷新</el-button>
        <el-button type="primary" :icon="Monitor" @click="openModule('/detect')">进入智能检测</el-button>
      </template>
    </PageHeader>

    <AsyncSection :loading="showSkeleton" :error="error" loading-text="正在汇总平台状态…" @retry="load">
      <!-- 骨架按真实布局画：指标卡网格 + 两块面板，加载完高度不跳变 -->
      <template #skeleton>
        <div class="home-skeleton" aria-hidden="true">
          <div class="overview-grid">
            <div v-for="index in 3" :key="index" class="home-skeleton__card">
              <el-skeleton :rows="3" animated />
            </div>
          </div>
          <div class="home-skeleton__panel">
            <el-skeleton :rows="5" animated />
          </div>
        </div>
      </template>

      <el-alert
        v-if="data?.errors?.length"
        class="home-errors"
        type="warning"
        :closable="false"
        show-icon
        :title="`部分后端接口读取失败：${data.errors.join('；')}`"
      />

      <!-- 三张分组卡：设备身份 / 运行指标 / 环境读数，各自内部再细分行 -->
      <div class="overview-grid">
        <InfoGroupCard title="机器人" kind="robot" :rows="robotRows" :progress="batteryProgress">
          <template #meta>
            <span class="overview-status" :class="`is-${robotStatus.tone}`">
              <i class="overview-status__dot" />
              {{ robotStatus.text }}
            </span>
          </template>
        </InfoGroupCard>

        <InfoGroupCard title="状态" kind="status" :rows="statusRows" />

        <InfoGroupCard title="环境" kind="env" :rows="environmentRows" />
      </div>

      <section class="view-panel home-modules">
        <div class="view-panel__head">
          <h2>功能模块</h2>
          <small>{{ robotHint }}</small>
        </div>
        <div class="module-grid">
          <button
            v-for="module in DASHBOARD_MODULES"
            :key="module.key"
            type="button"
            class="module-card"
            @click="openModule(module.path)"
          >
            <el-icon class="module-card__icon" :size="20">
              <component :is="moduleIcon(module.key)" />
            </el-icon>
            <span class="module-card__copy">
              <strong>{{ module.label }}</strong>
              <small>{{ module.description }}</small>
            </span>
          </button>
        </div>
      </section>

      <section class="view-panel">
        <div class="view-panel__head">
          <h2>最近告警</h2>
          <el-button text type="primary" :icon="Bell" @click="openModule('/alerts')">查看全部</el-button>
        </div>
        <el-table :data="alerts.recent" size="small" border>
          <template #empty>
            <el-empty description="暂无告警，机器人与任务运行正常" :image-size="64" />
          </template>
          <el-table-column prop="createdAt" label="时间" width="170">
            <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column prop="level" label="等级" width="90">
            <template #default="{ row }">
              <el-tag :type="alertLevelMeta(row.level).tag" size="small" effect="light">
                {{ alertLevelMeta(row.level).label }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="content" label="内容" min-width="240" show-overflow-tooltip />
          <el-table-column prop="station" label="站点" width="90" />
        </el-table>
      </section>

      <section class="view-panel">
        <div class="view-panel__head">
          <h2>设备状态</h2>
          <small>数据来自 /api/v1/robot/state</small>
        </div>
        <el-descriptions :column="descColumns" border size="small">
          <el-descriptions-item label="机器人">{{ platform.robotId || '—' }}</el-descriptions-item>
          <el-descriptions-item label="固件版本">{{ telemetry.firmware || '—' }}</el-descriptions-item>
          <el-descriptions-item label="SDK">{{ telemetry.sdk || '—' }}</el-descriptions-item>
          <el-descriptions-item label="接口版本">{{ platform.apiVersion || '—' }}</el-descriptions-item>
          <el-descriptions-item label="CPU">{{ displayNumber(telemetry.cpu, { unit: '%' }) }}</el-descriptions-item>
          <el-descriptions-item label="磁盘">{{ displayNumber(telemetry.disk, { unit: '%' }) }}</el-descriptions-item>
          <el-descriptions-item label="位置">
            x {{ displayNumber(telemetry.x) }} / y {{ displayNumber(telemetry.y) }} / yaw {{ displayNumber(telemetry.yaw, { unit: '°' }) }}
          </el-descriptions-item>
          <el-descriptions-item label="任务">{{ taskStateText }}</el-descriptions-item>
        </el-descriptions>
      </section>
    </AsyncSection>
  </div>
</template>

<style scoped>
.auto-refresh {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 4px;
  color: var(--app-text-secondary);
  font-size: 13px;
  cursor: pointer;
  user-select: none;
}

.auto-refresh__label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

/* 分组卡：三列等宽；宽度不足时退到两列 / 单列，避免每行被压成一条竖线 */
.overview-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--app-gap-inner);
}

/* 运行状态胶囊：状态值来自 robot-core，颜色只做语义提示，不改变文本 */
.overview-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.6;
  white-space: nowrap;
  background: var(--app-surface-3);
  color: var(--app-text-secondary);
}

.overview-status__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}

.overview-status.is-idle {
  background: #2f9e5f1f;
  color: var(--app-success);
}

.overview-status.is-active {
  background: #1d6fd81f;
  color: var(--app-primary);
}

.overview-status.is-danger {
  background: #d645451f;
  color: var(--app-danger);
}

.overview-status.is-muted {
  background: var(--app-surface-3);
  color: var(--app-text-muted);
}

.module-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(208px, 1fr));
  gap: var(--app-gap-inner);
}

.module-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px 15px;
  text-align: left;
  background: var(--app-surface);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
  cursor: pointer;
  transition: border-color 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease;
}

.module-card:hover {
  border-color: var(--el-color-primary-light-5);
  box-shadow: var(--app-shadow);
  transform: translateY(-1px);
}

.module-card:active {
  transform: translateY(0);
}

.module-card__icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  border-radius: var(--app-radius-sm);
  background: var(--el-color-primary-light-9);
  color: var(--app-primary);
}

.module-card__copy {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.module-card__copy strong {
  font-size: 14px;
  font-weight: 600;
  color: var(--app-text);
}

.module-card__copy small {
  font-size: 12px;
  color: var(--app-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 骨架：与真实布局同构（3 张分组卡 + 一块面板），避免加载完成时高度突变 */
.home-skeleton__card {
  padding: 14px 16px;
  background: var(--app-surface);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-lg);
}

.home-skeleton__panel {
  margin-top: var(--app-gap);
  padding: 18px;
  background: var(--app-surface);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
}

@media (max-width: 1100px) {
  .overview-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 720px) {
  .overview-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 900px) {
  .module-grid {
    grid-template-columns: 1fr;
  }
}
</style>
