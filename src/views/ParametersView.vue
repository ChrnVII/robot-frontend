<script setup>
// 运行环境：只读展示后端实际生效的配置与设备清单。
//
// 这里以前是「参数设置」表单（robot_id / client_id / servUrl / servKey …），
// 但那批字段在 ui_config 表里没有任何消费方——保存成功只是一句提示，改完什么都不会变。
// 现在改为展示 /config?configType=inspection 的真值（运行模式、模型、路径），
// 以及 robot-core 自检上报的设备清单（数据源能直接看出真机还是模拟）。
import { computed, onMounted } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import PageHeader from '@/components/PageHeader.vue'
import AsyncSection from '@/components/AsyncSection.vue'
import { MODE_LABELS, fetchRuntimeConfig } from '@/api/config'
import { getPlatformInfo, getVersion } from '@/api/system'
import { getRobotState } from '@/api/telemetry'
import { unwrap } from '@/api/envelope'
import { useAsyncData } from '@/composables/useAsyncData'
import { useRefreshFeedback } from '@/composables/useRefreshFeedback'
import { formatTime } from '@/utils/format'

const { refresh: refreshWithFeedback } = useRefreshFeedback()

const { data, loading, error, load } = useAsyncData(async () => {
  // 四路独立失败：某一路挂了不该让整页空白，失败项汇总到 failures 里提示。
  const [configResult, platformResult, versionResult, stateResult] = await Promise.allSettled([
    fetchRuntimeConfig(),
    getPlatformInfo(),
    getVersion(),
    getRobotState()
  ])
  const failures = []
  const read = (result, label) => {
    if (result.status === 'rejected') {
      failures.push(label)
      return null
    }
    return unwrap(result.value, null)
  }
  const state = read(stateResult, '设备状态') || {}
  return {
    config: read(configResult, '运行配置') || {},
    platform: read(platformResult, '平台信息') || {},
    version: read(versionResult, '接口版本') || {},
    devices: state.devices || {},
    failures
  }
}, { initialData: null })

const config = computed(() => data.value?.config || {})
const platform = computed(() => data.value?.platform || {})
const version = computed(() => data.value?.version || {})
const failures = computed(() => data.value?.failures || [])

const modeText = computed(() => MODE_LABELS[config.value.environment] || config.value.environment || '—')

// 运行配置：全部来自后端实际加载的值，不在这里编默认值。
const runtimeRows = computed(() => [
  { label: '运行模式', value: modeText.value, mono: false },
  { label: '模型状态', value: config.value.modelEnabled ? '已启用' : '未启用', mono: false },
  { label: '推理设备', value: config.value.modelDevice || '—', mono: true },
  { label: '配置文件', value: config.value.configPath || '—', mono: true },
  { label: '模型路径', value: config.value.modelPath || '—', mono: true },
  { label: '结果目录', value: config.value.resultPath || '—', mono: true }
])

// 设备清单：deviceId / 健康 / 数据源 / 最近采样。source=simulator 即未接真机。
const deviceRows = computed(() => Object.entries(data.value?.devices || {})
  .map(([key, item]) => ({
    key,
    deviceId: item?.deviceId || key,
    health: String(item?.health || 'unknown'),
    source: String(item?.source || ''),
    sampledAt: item?.sampledAt || ''
  }))
  // 异常排前面：排障时第一眼要看的是谁不正常。
  .sort((a, b) => Number(a.health === 'ok') - Number(b.health === 'ok') || a.deviceId.localeCompare(b.deviceId)))

const simulatedCount = computed(() => deviceRows.value.filter((item) => item.source === 'simulator').length)

const HEALTH_META = {
  ok: { label: '正常', tag: 'success' },
  degraded: { label: '降级', tag: 'warning' },
  unavailable: { label: '未就绪', tag: 'info' },
  fault: { label: '故障', tag: 'danger' }
}

function healthMeta(value) {
  return HEALTH_META[value] || { label: value || '未知', tag: 'info' }
}

onMounted(load)

async function refresh() {
  await refreshWithFeedback(async () => {
    await load()
    return !error.value
  }, { success: '运行环境已刷新', isError: () => error.value })
}
</script>

<template>
  <div class="view">
    <PageHeader
      title="运行环境"
      :description="`机器人 ${platform.robotId || '—'} · 接口 ${version.apiVersion || '—'} · 版本 ${version.version || '—'}`"
      :status-text="modeText"
      :status-type="config.environment === 'hardware' ? 'success' : 'info'"
    >
      <template #extra>
        <el-button :icon="Refresh" :loading="loading" @click="refresh">刷新</el-button>
      </template>
    </PageHeader>

    <AsyncSection :loading="loading" :error="error" loading-text="正在读取运行环境…" @retry="load">
      <el-alert
        v-if="failures.length"
        class="env-alert"
        type="warning"
        :closable="false"
        show-icon
        :title="`部分信息读取失败：${failures.join('、')}`"
      />

      <!-- 明确说明"为什么不能改"，避免被当成页面故障或权限不足 -->
      <el-alert
        class="env-alert"
        type="info"
        :closable="false"
        show-icon
        title="本页为只读"
        description="当前版本没有可在网页修改的参数。运行模式、模型与路径来自启动配置（configs/*.yaml、robot.env），改动后需重启 backend / robot-core 才会生效。"
      />

      <section class="view-panel">
        <div class="view-panel__head">
          <h2>运行配置</h2>
          <small>来自后端实际加载的配置，不是默认值兜底</small>
        </div>
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item v-for="row in runtimeRows" :key="row.label" :label="row.label">
            <span :class="{ mono: row.mono }">{{ row.value }}</span>
          </el-descriptions-item>
        </el-descriptions>
      </section>

      <section class="view-panel">
        <div class="view-panel__head">
          <h2>设备清单</h2>
          <small>
            robot-core 自检 · 共 {{ deviceRows.length }} 个设备<span v-if="simulatedCount"> · 其中 {{ simulatedCount }} 个模拟</span>
          </small>
        </div>
        <el-table :data="deviceRows" size="small" border>
          <template #empty>
            <el-empty description="robot-core 未上报设备状态" :image-size="60" />
          </template>
          <el-table-column prop="deviceId" label="设备" width="130" />
          <el-table-column label="健康" width="110">
            <template #default="{ row }">
              <el-tag size="small" effect="light" :type="healthMeta(row.health).tag">
                {{ healthMeta(row.health).label }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="数据源" min-width="200">
            <template #default="{ row }">
              <span class="mono">{{ row.source || '—' }}</span>
              <el-tag v-if="row.source === 'simulator'" size="small" type="info" effect="plain" class="sim-tag">模拟</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="最近采样" width="180">
            <template #default="{ row }">{{ row.sampledAt ? formatTime(row.sampledAt) : '—' }}</template>
          </el-table-column>
        </el-table>
      </section>
    </AsyncSection>
  </div>
</template>

<style scoped>
.env-alert {
  margin-bottom: var(--app-gap);
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.sim-tag {
  margin-left: 6px;
}
</style>
