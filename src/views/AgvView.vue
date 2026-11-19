<script setup>
// 移动底盘：遥测展示 + 任务控制。
// 遥测由 composables/useTelemetry.js 统一负责（快照 + 轮询 + WebSocket 升级），
// 命令按钮的 target/action 映射在 api/devices.js，页面只传语义命令名。
import { computed, reactive } from 'vue'
import {
  Aim, Bell, CaretRight, Close, Coin, Lightning, Moon, Open, Refresh, Sunrise, SwitchButton, VideoPause
} from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import AsyncSection from '@/components/AsyncSection.vue'
import MetricCard from '@/components/MetricCard.vue'
import { ROBOT_COMMANDS, TASK_MODES, needsConfirmation, robotCommandLabel, sendRobotCommand } from '@/api/devices'
import { useTelemetry } from '@/composables/useTelemetry'
import { useAsyncTask } from '@/composables/useAsyncTask'
import { useRefreshFeedback } from '@/composables/useRefreshFeedback'
import { displayNumber, formatTime, percentStatus } from '@/utils/format'

// 命令按钮图标：仅用于视觉区分，不影响命令语义。
const COMMAND_ICONS = {
  clearFault: Bell,
  startTask: CaretRight,
  stopTask: Close,
  pause: VideoPause,
  resume: Open,
  chargeTask: Coin,
  charge: Lightning,
  lightOn: Sunrise,
  lightOff: Moon,
  relocate: Aim,
  clearAlarm: Bell,
  gotoStation: SwitchButton
}

const { state: rawState, telemetry, loading, error, updatedAt, refresh } = useTelemetry()
const { pendingKey, run } = useAsyncTask()
const { refresh: refreshWithFeedback } = useRefreshFeedback()

// 手动刷新走统一反馈：成功有提示，失败给出具体原因，而不是"点了没反应"。
async function refreshTelemetry() {
  await refreshWithFeedback(() => refresh(), {
    success: '遥测数据已刷新',
    failure: '遥测读取失败',
    isError: () => error.value
  })
}

const controls = reactive({ task: '', station: '', mode: '0' })

//: 底盘页关心的设备。motion / lift 现在仍是模拟器，直接列出数据源比藏起来更诚实。
const AGV_DEVICE_IDS = ['motion', 'lift', 'battery']

const deviceMap = computed(() => rawState.value?.devices || {})

const agvDevices = computed(() => AGV_DEVICE_IDS
  .filter((id) => deviceMap.value[id])
  .map((id) => {
    const item = deviceMap.value[id] || {}
    return {
      deviceId: item.deviceId || id,
      health: String(item.health || ''),
      source: String(item.source || ''),
      sampledAt: item.sampledAt || ''
    }
  }))

const simulatedDevices = computed(() => agvDevices.value
  .filter((item) => item.source === 'simulator')
  .map((item) => item.deviceId))

const liftHint = computed(() => (
  deviceMap.value.lift?.source === 'simulator' ? '模拟驱动，数值不随真机变化' : ''
))

const state = computed(() => telemetry.value || {})
const statusType = computed(() => (/error|fail/i.test(String(state.value.status)) ? 'danger' : /charging|running/i.test(String(state.value.status)) ? 'success' : 'info'))
const updatedText = computed(() => (updatedAt.value ? formatTime(updatedAt.value) : ''))

async function execute(command) {
  if (needsConfirmation(command)) {
    const extra = command === 'startTask' && controls.task ? `（任务 ${controls.task}）` : ''
    try {
      await ElMessageBox.confirm(
        `「${robotCommandLabel(command)}」会操作真实机器人${extra}，确认下发？`,
        '操作确认',
        { type: 'warning', confirmButtonText: '确认下发', cancelButtonText: '取消' }
      )
    } catch {
      return
    }
  }
  const payload = {
    task: controls.task,
    mode: controls.mode,
    station: controls.station
  }
  const result = await run(command, () => sendRobotCommand(command, payload), {
    success: `${robotCommandLabel(command)}指令已下发`
  })
  if (result !== undefined) refresh()
}

function quickStop() {
  ElMessageBox.confirm('结束任务会立即停止机器人当前巡检路线，确认执行？', '结束任务', {
    type: 'warning',
    confirmButtonText: '结束任务',
    cancelButtonText: '取消'
  }).then(() => execute('stopTask')).catch(() => {})
}
</script>

<template>
  <div class="view">
    <PageHeader
      title="移动底盘"
      :description="`${state.name || '巡检机器人'} · ${state.robotId || '未知设备'}`"
      :status-text="state.status || '等待数据'"
      :status-type="statusType"
      :updated-at="updatedText"
    >
      <template #extra>
        <el-button :icon="Refresh" :loading="loading" @click="refreshTelemetry">刷新遥测</el-button>
        <el-button type="danger" :icon="Close" @click="quickStop">结束任务</el-button>
      </template>
    </PageHeader>

    <!-- 骨架屏只在首次读取（尚未失败过）时出现；一旦出错就保持页面框架 + 顶部错误条 -->
    <AsyncSection :loading="loading && !updatedAt && !error" :error="error" loading-text="正在读取机器人状态…" @retry="refresh">
      <div class="metric-grid">
        <!-- 卡片只放后端真实上报的读数：电量来自 BMS、温湿度/光照/风速来自环境串口。
             原来这里的「当前任务 / 当前站点」取自 robot-core 并不上报的 task 字段，
             永远是横杠；已删除，任务进度请看「任务管理」的运行记录。 -->
        <MetricCard label="剩余电量" :value="displayNumber(state.battery)" unit="%" :type="percentStatus(state.battery)" />
        <MetricCard label="舍内温度" :value="displayNumber(state.temperature)" unit="℃" :hint="`湿度 ${displayNumber(state.humidity, { unit: '%' })}`" />
        <MetricCard label="环境光照" :value="displayNumber(state.light)" unit="lx" :hint="`风速 ${displayNumber(state.wind, { unit: ' m/s' })}`" />
        <MetricCard label="升降高度" :value="displayNumber(state.lift)" unit="mm" :hint="liftHint" />
      </div>

      <!-- 驱动层事实：motion / lift 目前仍是模拟器，位置、姿态、任务字段不会有真实值。
           与其画一堆横杠，不如直接说明"这一页现在能看什么、不能看什么"。 -->
      <el-alert
        v-if="simulatedDevices.length"
        class="agv-alert"
        type="warning"
        :closable="false"
        show-icon
        :title="`${simulatedDevices.join('、')} 为模拟驱动（simulator）`"
        description="这些设备的位置 / 姿态 / 运动状态不会随真机变化，指令回执也不代表设备已动作。真实可用的只有电量与环境读数。"
      />

      <section class="view-panel agv-position">
        <div class="view-panel__head">
          <h2>设备状态</h2>
          <small>数据来自 robot-core 自检 · 数据源含 simulator 才是模拟</small>
        </div>
        <el-table :data="agvDevices" size="small" border>
          <template #empty>
            <el-empty description="robot-core 未上报底盘设备" :image-size="60" />
          </template>
          <el-table-column prop="deviceId" label="设备" width="120" />
          <el-table-column label="健康" width="100">
            <template #default="{ row }">
              <el-tag size="small" effect="light" :type="row.health === 'ok' ? 'success' : 'warning'">
                {{ row.health === 'ok' ? '正常' : row.health || '未知' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="数据源" min-width="160">
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

      <section class="view-panel">
        <div class="view-panel__head">
          <h2>任务参数</h2>
          <small>开始任务 / 前往站点会使用这里的参数</small>
        </div>
        <el-form label-width="90px" class="agv-form">
          <el-row :gutter="20">
            <el-col :xs="24" :sm="12" :md="8">
              <el-form-item label="任务 ID">
                <el-input v-model="controls.task" placeholder="例如 110" clearable />
              </el-form-item>
            </el-col>
            <el-col :xs="24" :sm="12" :md="8">
              <el-form-item label="目标站点">
                <el-input v-model="controls.station" placeholder="例如 603" clearable />
              </el-form-item>
            </el-col>
            <el-col :xs="24" :sm="12" :md="8">
              <el-form-item label="任务模式">
                <el-select v-model="controls.mode" class="agv-select">
                  <el-option v-for="item in TASK_MODES" :key="item.value" :label="item.label" :value="item.value" />
                </el-select>
              </el-form-item>
            </el-col>
          </el-row>
        </el-form>
      </section>

      <section class="view-panel">
        <div class="view-panel__head">
          <h2>底盘控制</h2>
          <small>红色按钮会操作真实设备，需要二次确认</small>
        </div>
        <div class="command-grid">
          <el-button
            v-for="command in ROBOT_COMMANDS"
            :key="command.id"
            :type="command.type"
            :icon="COMMAND_ICONS[command.id]"
            :plain="!needsConfirmation(command.id)"
            :loading="pendingKey === command.id"
            :disabled="Boolean(pendingKey)"
            class="command-button"
            @click="execute(command.id)"
          >
            {{ command.label }}
          </el-button>
        </div>
      </section>
    </AsyncSection>
  </div>
</template>

<style scoped>
.agv-form :deep(.el-input),
.agv-select {
  width: 100%;
}

.command-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: var(--app-gap-inner);
}

.command-button {
  width: 100%;
  margin-left: 0 !important;
}

.agv-alert {
  margin-bottom: var(--app-gap);
}

/* 数据源等宽显示：一眼区分 ttyS0@9600 与 simulator */
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.sim-tag {
  margin-left: 6px;
}
</style>
