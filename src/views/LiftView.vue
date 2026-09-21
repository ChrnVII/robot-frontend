<script setup>
// 升降控制：参数写入、绝对定位、连续升降和急停。
// 所有指令都经 api/safety.js 下发（携带控制租约），页面只维护按钮状态和表单值。
import { computed, onBeforeUnmount, onMounted, reactive } from 'vue'
import { ArrowDown, ArrowUp, CaretBottom, Refresh, RefreshLeft, VideoPause, Warning } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import AsyncSection from '@/components/AsyncSection.vue'
import MetricCard from '@/components/MetricCard.vue'
import { unwrap } from '@/api/envelope'
import {
  clearLiftFault, enableLift, getLiftState, homeLift, moveLift, moveLiftTo, setLiftParams, stopLift
} from '@/api/safety'
import { useAsyncData } from '@/composables/useAsyncData'
import { useAsyncTask } from '@/composables/useAsyncTask'
import { displayNumber } from '@/utils/format'

const STATE_POLL_INTERVAL = 5000
const ABSOLUTE_PRESETS = [-100, 200, 900]
const RELATIVE_PRESETS = [-100, -5, 5, 100]

const MOTION_LABELS = {
  idle: '待命',
  homing: '回原点中',
  positioning: '定位中',
  moving_up: '上升中',
  moving_down: '下降中',
  stopped: '已停止',
  offline: '离线'
}

const config = reactive({ speed: 4096, accel: 100, downLimit: -20, upLimit: 1140 })
const target = reactive({ height: 0 })
const state = reactive({ height: 0, faultCode: 0, enabled: false, motion: 'idle' })

const { pendingKey, run } = useAsyncTask()
const { loading, error, load } = useAsyncData(() => getLiftState(), { initialData: null, onSuccess: applyState })

let pollTimer = null

const motionLabel = computed(() => MOTION_LABELS[state.motion] || state.motion || '未知')
const heightRange = computed(() => [Number(config.downLimit) || 0, Number(config.upLimit) || 0])
const busy = computed(() => Boolean(pendingKey.value))

function applyState(response) {
  const next = unwrap(response, null)
  if (!next || typeof next !== 'object') return
  ;['height', 'faultCode', 'enabled', 'motion'].forEach((key) => {
    if (next[key] !== undefined && next[key] !== null) state[key] = next[key]
  })
  ;['speed', 'accel', 'downLimit', 'upLimit'].forEach((key) => {
    if (next[key] !== undefined && next[key] !== null) config[key] = next[key]
  })
  target.height = Number(state.height) || 0
}

/** 下发指令后回读一次状态，让页面上的高度/状态跟随设备变化。 */
async function syncState(silent = true) {
  try {
    applyState(await getLiftState())
  } catch (reason) {
    if (!silent) ElMessage.error('升降状态读取失败')
  }
}

/** 下发一次升降指令：统一 loading、提示和状态回读。 */
async function send(key, task, successText) {
  const result = await run(key, task, { success: successText })
  if (result === undefined) return
  syncState()
}

async function confirmThen(action, message, onConfirm) {
  try {
    await ElMessageBox.confirm(message, '操作确认', { type: 'warning', confirmButtonText: '确认执行', cancelButtonText: '取消' })
  } catch {
    return
  }
  await onConfirm()
}

function saveParams() {
  if (Number(config.upLimit) <= Number(config.downLimit)) {
    ElMessage.warning('上限位必须大于下限位')
    return
  }
  return send('setParams', () => setLiftParams({ ...config }), '升降参数已写入')
}

function gotoHeight(height) {
  const value = Number(height)
  if (!Number.isFinite(value)) {
    ElMessage.warning('请输入有效高度')
    return
  }
  const [low, high] = heightRange.value
  if (value < low || value > high) {
    ElMessage.warning(`目标高度需在 ${low} ~ ${high} 之间`)
    return
  }
  target.height = value
  return send('moveTo', () => moveLiftTo(value), `已下发定位到 ${value} mm`)
}

function nudge(offset) {
  const [low, high] = heightRange.value
  const next = Math.max(low, Math.min(high, Number(target.height || state.height) + offset))
  return gotoHeight(next)
}

function toggleEnable() {
  const next = !state.enabled
  return send('enable', () => enableLift(next), next ? '升降已使能' : '升降已取消使能')
}

onMounted(async () => {
  await load()
  pollTimer = window.setInterval(() => syncState(), STATE_POLL_INTERVAL)
})

onBeforeUnmount(() => {
  if (pollTimer) window.clearInterval(pollTimer)
})
</script>

<template>
  <div class="view">
    <PageHeader
      title="升降控制"
      :description="`当前高度 ${displayNumber(state.height, { unit: ' mm' })} · ${motionLabel}`"
      :status-text="state.enabled ? '已使能' : '未使能'"
      :status-type="state.enabled ? 'success' : 'info'"
    >
      <template #extra>
        <el-button :icon="Refresh" :loading="loading" @click="syncState(false)">刷新状态</el-button>
        <el-button
          type="danger"
          :icon="VideoPause"
          :loading="pendingKey === 'stop'"
          @click="confirmThen('stop', '急停会同时停止底盘运动与升降设备，确认执行？', () => send('stop', () => stopLift(), '急停指令已下发'))"
        >
          急停
        </el-button>
      </template>
    </PageHeader>

    <AsyncSection :loading="loading" :error="error" loading-text="正在读取升降状态…" @retry="load">
      <div class="metric-grid lift-metrics">
        <MetricCard label="当前位置" :value="displayNumber(state.height)" unit="mm" type="primary" />
        <MetricCard label="升降状态" :value="motionLabel" :hint="state.enabled ? '驱动器已使能' : '等待使能'" />
        <MetricCard
          label="故障码"
          :value="state.faultCode"
          :hint="state.faultCode ? '存在故障，建议先清除' : '无故障'"
          :type="state.faultCode ? 'danger' : 'success'"
        />
        <MetricCard label="行程范围" :value="`${heightRange[0]} ~ ${heightRange[1]}`" unit="mm" hint="下限位 / 上限位" />
      </div>

      <section class="view-panel">
        <div class="view-panel__head">
          <h2>升降轴参数</h2>
          <small>写入后立即生效，请确认限位值正确</small>
        </div>
        <el-form label-width="100px" class="lift-form">
          <el-row :gutter="20">
            <el-col :xs="24" :sm="12" :md="6">
              <el-form-item label="速度">
                <el-input-number v-model="config.speed" :min="1" :max="65535" controls-position="right" />
              </el-form-item>
            </el-col>
            <el-col :xs="24" :sm="12" :md="6">
              <el-form-item label="加减速">
                <el-input-number v-model="config.accel" :min="1" :max="65535" controls-position="right" />
              </el-form-item>
            </el-col>
            <el-col :xs="24" :sm="12" :md="6">
              <el-form-item label="下限位">
                <el-input-number v-model="config.downLimit" :min="-32768" :max="32767" controls-position="right" />
              </el-form-item>
            </el-col>
            <el-col :xs="24" :sm="12" :md="6">
              <el-form-item label="上限位">
                <el-input-number v-model="config.upLimit" :min="-32768" :max="32767" controls-position="right" />
              </el-form-item>
            </el-col>
          </el-row>
          <el-button type="primary" :loading="pendingKey === 'setParams'" :disabled="busy" @click="saveParams">
            设置参数
          </el-button>
        </el-form>
      </section>

      <section class="view-panel">
        <div class="view-panel__head">
          <h2>定位与控制</h2>
          <small>绝对高度需要落在限位范围内</small>
        </div>

        <div class="lift-target">
          <el-input-number v-model="target.height" :step="5" :min="heightRange[0]" :max="heightRange[1]" controls-position="right" />
          <el-button type="primary" :loading="pendingKey === 'moveTo'" :disabled="busy" @click="gotoHeight(target.height)">
            定位到该高度
          </el-button>
        </div>

        <el-divider content-position="left">快捷绝对高度</el-divider>
        <div class="lift-presets">
          <el-button v-for="value in ABSOLUTE_PRESETS" :key="`abs-${value}`" :disabled="busy" @click="gotoHeight(value)">
            {{ value }} mm
          </el-button>
        </div>

        <el-divider content-position="left">相对调整</el-divider>
        <div class="lift-presets">
          <el-button
            v-for="value in RELATIVE_PRESETS"
            :key="`rel-${value}`"
            :type="value > 0 ? 'success' : 'warning'"
            plain
            :disabled="busy"
            @click="nudge(value)"
          >
            {{ value > 0 ? `+${value}` : value }} mm
          </el-button>
        </div>

        <el-divider content-position="left">设备动作</el-divider>
        <div class="lift-presets">
          <el-button :icon="ArrowUp" :loading="pendingKey === 'up'" :disabled="busy" @click="send('up', () => moveLift('up'), '连续上升已下发')">
            连续上升
          </el-button>
          <el-button :icon="ArrowDown" :loading="pendingKey === 'down'" :disabled="busy" @click="send('down', () => moveLift('down'), '连续下降已下发')">
            连续下降
          </el-button>
          <el-button :icon="RefreshLeft" :loading="pendingKey === 'home'" :disabled="busy" @click="send('home', () => homeLift(), '回原点已下发')">
            回原点
          </el-button>
          <el-button :icon="CaretBottom" :disabled="busy" @click="nudge(-1)">回 -1</el-button>
          <el-button :icon="Warning" :loading="pendingKey === 'clearFault'" :disabled="busy" @click="send('clearFault', () => clearLiftFault(), '故障清除指令已下发')">
            故障清除
          </el-button>
          <el-button
            :type="state.enabled ? 'info' : 'success'"
            :loading="pendingKey === 'enable'"
            :disabled="busy"
            @click="toggleEnable"
          >
            {{ state.enabled ? '取消使能' : '使能' }}
          </el-button>
        </div>

        <el-alert
          class="lift-tip"
          type="info"
          :closable="false"
          show-icon
          title="急停、回原点和连续升降会操作真实设备，请确认现场无人后执行。"
        />
      </section>
    </AsyncSection>
  </div>
</template>

<style scoped>
.lift-metrics {
  margin-bottom: 16px;
}

.lift-form {
  max-width: 100%;
}

.lift-form :deep(.el-input-number) {
  width: 100%;
}

.lift-target {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.lift-target :deep(.el-input-number) {
  width: 200px;
}

.lift-presets {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.lift-tip {
  margin-top: 16px;
}
</style>
