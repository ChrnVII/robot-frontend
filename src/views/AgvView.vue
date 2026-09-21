<script setup>
// 移动底盘：遥测展示 + 任务控制。
// 遥测由 composables/useTelemetry.js 统一负责（快照 + 轮询 + WebSocket 升级），
// 命令按钮的 target/action 映射在 api/devices.js，页面只传语义命令名。
import { computed, reactive, ref } from 'vue'
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

// 需要额外输入参数的按钮。
const EXTRA_FIELDS = {
  startTask: 'task',
  gotoStation: 'station'
}

const { telemetry, loading, error, updatedAt, refresh } = useTelemetry()
const { pendingKey, run } = useAsyncTask()

const controls = reactive({ task: '', station: '', mode: '0' })
const showDetails = ref(true)

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
        <el-button :icon="Refresh" :loading="loading" @click="refresh">刷新遥测</el-button>
        <el-button type="danger" :icon="Close" @click="quickStop">结束任务</el-button>
      </template>
    </PageHeader>

    <AsyncSection :loading="loading && !updatedAt" :error="error" loading-text="正在读取机器人状态…" @retry="refresh">
      <div class="metric-grid">
        <MetricCard label="剩余电量" :value="displayNumber(state.battery)" unit="%" :type="percentStatus(state.battery)" />
        <MetricCard label="当前任务" :value="state.task ?? '—'" :hint="state.paused ? '任务已暂停' : '任务运行中'" type="primary" />
        <MetricCard label="当前站点" :value="state.station ?? '—'" :hint="`鸡笼 ${state.cage ?? '—'} · 偏移 ${displayNumber(state.offset)}`" />
        <MetricCard label="升降高度" :value="displayNumber(state.lift)" unit="mm" />
        <MetricCard label="舍内温度" :value="displayNumber(state.temperature)" unit="℃" :hint="`湿度 ${displayNumber(state.humidity, { unit: '%' })}`" />
        <MetricCard label="环境光照" :value="displayNumber(state.light)" unit="lx" :hint="`风速 ${displayNumber(state.wind, { unit: ' m/s' })}`" />
      </div>

      <section class="view-panel agv-position">
        <div class="view-panel__head">
          <h2>位姿与主机状态</h2>
          <el-button text type="primary" @click="showDetails = !showDetails">{{ showDetails ? '收起' : '展开' }}</el-button>
        </div>
        <el-descriptions v-if="showDetails" :column="4" border size="small">
          <el-descriptions-item label="X 坐标">{{ displayNumber(state.x) }}</el-descriptions-item>
          <el-descriptions-item label="Y 坐标">{{ displayNumber(state.y) }}</el-descriptions-item>
          <el-descriptions-item label="YAW">{{ displayNumber(state.yaw, { unit: '°' }) }}</el-descriptions-item>
          <el-descriptions-item label="位置">{{ state.position ?? '—' }}</el-descriptions-item>
          <el-descriptions-item label="固件版本">{{ state.firmware || '—' }}</el-descriptions-item>
          <el-descriptions-item label="SDK">{{ state.sdk || '—' }}</el-descriptions-item>
          <el-descriptions-item label="CPU">{{ displayNumber(state.cpu, { unit: '%' }) }}</el-descriptions-item>
          <el-descriptions-item label="磁盘">{{ displayNumber(state.disk, { unit: '%' }) }}</el-descriptions-item>
          <el-descriptions-item label="CO₂">{{ displayNumber(state.co2, { allowNegative: false }) }}</el-descriptions-item>
          <el-descriptions-item label="氨气">{{ displayNumber(state.ammonia, { allowNegative: false }) }}</el-descriptions-item>
          <el-descriptions-item label="站点总数">{{ state.total ?? '—' }}</el-descriptions-item>
          <el-descriptions-item label="暂停状态">{{ state.paused ? '已暂停' : '未暂停' }}</el-descriptions-item>
        </el-descriptions>
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
.agv-position {
  margin: 16px 0;
}

.agv-form :deep(.el-input),
.agv-select {
  width: 100%;
}

.command-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
}

.command-button {
  width: 100%;
  margin-left: 0 !important;
}
</style>
