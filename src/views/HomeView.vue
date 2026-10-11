<script setup>
// 运行总览：只读地汇总平台、机器人、任务和告警概况，并提供功能模块入口。
// 数据全部来自 api/dashboard.js 的聚合快照，页面不拼装任何请求路径。
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import {
  Bell, Camera, DataLine, Document, MapLocation, Monitor, Odometer, Operation,
  Refresh, Setting, Van, VideoCamera
} from '@element-plus/icons-vue'
import PageHeader from '@/components/PageHeader.vue'
import AsyncSection from '@/components/AsyncSection.vue'
import MetricCard from '@/components/MetricCard.vue'
import { DASHBOARD_MODULES, loadDashboard } from '@/api/dashboard'
import { alertLevelMeta } from '@/api/alerts'
import { useAsyncData } from '@/composables/useAsyncData'
import { displayNumber, formatTime, percentStatus } from '@/utils/format'

const router = useRouter()

// 模块图标按 key 映射，键与 DASHBOARD_MODULES 一致。
const MODULE_ICONS = {
  detect: Odometer,
  tasks: Document,
  cam: VideoCamera,
  lift: Operation,
  agv: Van,
  map: MapLocation,
  params: Setting,
  runs: DataLine,
  alerts: Bell,
  'task-tmpl': Document
}

const { data, loading, error, load } = useAsyncData(() => loadDashboard(), { initialData: null })

const telemetry = computed(() => data.value?.telemetry || {})
const platform = computed(() => data.value?.platform || {})
const alerts = computed(() => data.value?.alerts || { total: 0, open: 0, recent: [] })
const tasks = computed(() => data.value?.tasks || { total: 0, enabled: 0 })
const online = computed(() => data.value?.health?.online === true)

const platformStatus = computed(() => {
  if (!data.value) return { text: '', type: 'info' }
  return online.value
    ? { text: '系统在线', type: 'success' }
    : { text: '系统离线', type: 'danger' }
})

const robotHint = computed(() => {
  const parts = [platform.value.mode && `模式 ${platform.value.mode}`, platform.value.apiVersion && `API ${platform.value.apiVersion}`]
  return parts.filter(Boolean).join(' · ') || '等待后端上报'
})

const taskProgressText = computed(() => `${tasks.value.enabled} / ${tasks.value.total} 个任务已启用`)

onMounted(load)

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
    >
      <template #extra>
        <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
        <el-button type="primary" :icon="Monitor" @click="openModule('/detect')">进入智能检测</el-button>
      </template>
    </PageHeader>

    <!-- 骨架屏只在首次汇总（尚未失败过）时出现；一旦出错就保持页面框架 + 顶部错误条 -->
    <AsyncSection :loading="loading && !data && !error" :error="error" loading-text="正在汇总平台状态…" @retry="load">
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
          :hint="'检测台当前高度'"
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
            <el-icon class="module-card__icon" :size="22">
              <component :is="MODULE_ICONS[module.key] || Document" />
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
        <el-descriptions :column="4" border size="small">
          <el-descriptions-item label="机器人">{{ platform.robotId || '—' }}</el-descriptions-item>
          <el-descriptions-item label="固件版本">{{ telemetry.firmware || '—' }}</el-descriptions-item>
          <el-descriptions-item label="SDK">{{ telemetry.sdk || '—' }}</el-descriptions-item>
          <el-descriptions-item label="接口版本">{{ platform.apiVersion || '—' }}</el-descriptions-item>
          <el-descriptions-item label="CPU">{{ displayNumber(telemetry.cpu, { unit: '%' }) }}</el-descriptions-item>
          <el-descriptions-item label="磁盘">{{ displayNumber(telemetry.disk, { unit: '%' }) }}</el-descriptions-item>
          <el-descriptions-item label="位置">
            x {{ displayNumber(telemetry.x) }} / y {{ displayNumber(telemetry.y) }} / yaw {{ displayNumber(telemetry.yaw, { unit: '°' }) }}
          </el-descriptions-item>
          <el-descriptions-item label="任务">
            {{ telemetry.task ?? '—' }} · {{ telemetry.paused ? '已暂停' : '运行中' }}
          </el-descriptions-item>
        </el-descriptions>
      </section>
    </AsyncSection>
  </div>
</template>

<style scoped>
.home-errors {
  margin-bottom: 12px;
}

.home-modules {
  margin: 16px 0;
}

.module-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 12px;
}

.module-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  text-align: left;
  background: var(--el-fill-color-blank);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s, transform 0.2s;
}

.module-card:hover {
  border-color: var(--el-color-primary-light-5);
  box-shadow: 0 4px 14px rgb(64 158 255 / 12%);
  transform: translateY(-1px);
}

.module-card__icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  border-radius: 8px;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.module-card__copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.module-card__copy strong {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.module-card__copy small {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.view-panel + .view-panel {
  margin-top: 16px;
}
</style>
