<script setup>
// 运行总览：只读地汇总平台、机器人、任务和告警概况，并提供功能模块入口。
// 数据全部来自 api/dashboard.js 的聚合快照，页面不拼装任何请求路径。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Bell, Monitor, Refresh, Timer } from '@element-plus/icons-vue'
import PageHeader from '@/components/PageHeader.vue'
import AsyncSection from '@/components/AsyncSection.vue'
import MetricCard from '@/components/MetricCard.vue'
import { DASHBOARD_MODULES, loadDashboard } from '@/api/dashboard'
import { alertLevelMeta } from '@/api/alerts'
import { useAsyncData } from '@/composables/useAsyncData'
import { useRefreshFeedback } from '@/composables/useRefreshFeedback'
import { useBreakpoint } from '@/composables/useBreakpoint'
import { moduleIcon } from '@/composables/useModuleMeta'
import { displayNumber, formatTime, percentStatus } from '@/utils/format'

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

const taskProgressText = computed(() => `${tasks.value.enabled} / ${tasks.value.total} 个任务已启用`)

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
          <div class="home-skeleton__grid">
            <div v-for="index in 6" :key="index" class="home-skeleton__card">
              <el-skeleton :rows="2" animated />
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

      <div class="metric-grid">
        <MetricCard
          label="剩余电量"
          :value="displayNumber(telemetry.battery, { fallback: '—' })"
          unit="%"
          :hint="`状态 ${telemetry.status || '未知'}`"
          :type="percentStatus(telemetry.battery)"
        />
        <MetricCard
          label="舍内温度"
          :value="displayNumber(telemetry.temperature)"
          unit="℃"
          :hint="`湿度 ${displayNumber(telemetry.humidity, { unit: '%' })}`"
        />
        <MetricCard
          label="启用任务"
          :value="tasks.enabled"
          unit="个"
          :hint="taskProgressText"
          type="primary"
        />
        <MetricCard
          label="待处理告警"
          :value="alerts.open"
          unit="条"
          :hint="`累计 ${alerts.total} 条告警`"
          :type="alerts.open > 0 ? 'danger' : 'success'"
        />
        <MetricCard
          label="运行状态"
          :value="telemetry.status || '未知'"
          :hint="`站点 ${telemetry.station ?? '—'}`"
          type="info"
        />
        <MetricCard
          label="升降高度"
          :value="displayNumber(telemetry.lift)"
          unit="mm"
          hint="检测台当前高度"
        />
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

/* 骨架：与真实布局同构（6 张指标卡 + 一块面板），避免加载完成时高度突变 */
.home-skeleton__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  gap: var(--app-gap-inner);
}

.home-skeleton__card {
  padding: 14px 16px;
  background: var(--app-surface);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
}

.home-skeleton__panel {
  margin-top: var(--app-gap);
  padding: 18px;
  background: var(--app-surface);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
}

@media (max-width: 900px) {
  .module-grid {
    grid-template-columns: 1fr;
  }
}
</style>
