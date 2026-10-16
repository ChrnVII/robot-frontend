<script setup>
// 球形摄像头：实时画面、分段录像、云台控制、预置点管理和抓图。
//
// 实时画面走低延迟链路（WebSocket + WebCodecs 硬解，见 composables/useCameraStream.js）：
// 服务端解封装透传 Annex-B，浏览器解码，不额外转码。
// 浏览器不是安全上下文（非 HTTPS/localhost）、不支持 WebCodecs，或后端未配置 RTSP 地址
// 时自动回退到 /api/v1/cam/stream 的已鉴权 JPEG 轮询。
//
// 录像由后端把同一份码流原样 remux 成 MKV（不解码、不重编码），只在此页开关与查看。
// 云台 / 预置点 / 抓图 / 重启仍经 api/safety.js 下发（robot-core 的 ISAPI 驱动），
// 与画面链路互不影响。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Aim, Camera, Delete, Plus, Refresh, RefreshRight, SwitchButton, VideoCamera, Warning
} from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import {
  cameraSnapshot, deleteCameraPreset, gotoCameraPreset, listCameraPresets,
  ptzContinuous, rebootCamera, saveCameraPreset
} from '@/api/safety'
import {
  controlRecording, deleteRecording, listRecordings, downloadRecording, getCameraStreamStatus, getCameraPreviewFrame
} from '@/api/cameraStream'
import { unwrap, unwrapRows } from '@/api/envelope'
import { useAsyncData } from '@/composables/useAsyncData'
import { useAsyncTask } from '@/composables/useAsyncTask'
import { useCameraStream } from '@/composables/useCameraStream'
import { formatTime } from '@/utils/format'

const FRAME_INTERVAL = 1000

// 云台方向：direct 值对应设备协议，speed 由滑块给出。
const PTZ_DIRECTIONS = [
  { direct: 'up', label: '上', icon: '↑' },
  { direct: 'left', label: '左', icon: '←' },
  { direct: 'stop', label: '停止', icon: '■', danger: true },
  { direct: 'right', label: '右', icon: '→' },
  { direct: 'down', label: '下', icon: '↓' }
]

const presets = ref([])
const currentPresetId = ref(null)
const speed = ref(1)
const frameSrc = ref('')
let framePending = false
let pageDisposed = false
const lastAction = ref('待命')
const snapshotAsset = ref(null)
const newPresetId = ref('')

const recordings = ref([])
const recordingState = ref(null)
const recordingsError = ref('')
const recordingsLoading = ref(false)

const videoCanvas = ref(null)
const stream = useCameraStream()

const { pendingKey, run } = useAsyncTask()
const { loading, error, load } = useAsyncData(async () => {
  const rows = await listCameraPresets()
  presets.value = rows
  if (!presets.value.some((item) => item.presetId === currentPresetId.value)) {
    currentPresetId.value = presets.value[0]?.presetId ?? null
  }
  return rows
})

let timer = null
let statusTimer = null
let statusPending = false
const fallbackLoaded = ref(false)
const fallbackError = ref(false)

const currentPreset = computed(() => presets.value.find((item) => item.presetId === currentPresetId.value) || null)
const usingFallback = computed(() => stream.mode.value === 'fallback')

// 降级时明确显示快照状态，避免将单帧标成实时视频。
const feedStatusText = computed(() => (
  usingFallback.value ? (fallbackError.value ? '快照读取失败' : fallbackLoaded.value ? '快照预览 · 约 1 帧/秒' : '正在读取快照…') : stream.statusText.value
))
const feedStatusType = computed(() => (
  usingFallback.value ? (fallbackError.value ? 'danger' : 'warning') : stream.statusType.value
))
const feedLabel = computed(() => {
  if (usingFallback.value) return 'SNAPSHOT'
  return stream.phase.value === 'live' ? 'LIVE' : 'CONNECTING'
})

const isRecording = computed(() => Boolean(recordingState.value?.recording))

const recordingStatusText = computed(() => {
  const state = recordingState.value
  if (!state) return '正在读取录像状态…'
  if (state.error) return `录像异常 · ${state.error}`
  if (state.recording) {
    return state.currentFile ? `录像中 · ${state.currentFile}` : '录像中 · 等待关键帧开段'
  }
  return `已停止 · 共 ${state.segments || 0} 段`
})

const streamMetrics = computed(() => {
  const metrics = stream.metrics
  return [
    { label: '延迟', value: metrics.latencyMs === null ? '—' : `${metrics.latencyMs} ms` },
    { label: '帧率', value: metrics.fps ? `${metrics.fps.toFixed(1)} fps` : '—' },
    { label: '解码队列', value: String(metrics.decodeQueue) },
    { label: '丢帧', value: String(metrics.droppedFrames) },
    { label: '已解码', value: String(metrics.decodedFrames) }
  ]
})

const resolutionText = computed(() => (
  stream.resolution.width && stream.resolution.height
    ? `${stream.resolution.width}×${stream.resolution.height}`
    : '—'
))

const snapshotText = computed(() => {
  if (!snapshotAsset.value) return '尚未抓图'
  const asset = snapshotAsset.value
  return `${asset.assetId || asset.uri || '已保存'} · ${formatTime(asset.capturedAt)}`
})

async function loadStreamStatus() {
  if (statusPending) return
  statusPending = true
  try {
    const state = unwrap(await getCameraStreamStatus(), {})
    recordingState.value = state.recording || null
  } catch (reason) {
    recordingsError.value = reason?.message || '录像状态读取失败'
  } finally { statusPending = false }
}

async function download(row) {
  await run(`download-${row.name}`, () => downloadRecording(row.name))
}

async function loadRecordings() {
  recordingsLoading.value = true
  recordingsError.value = ''
  try {
    recordings.value = unwrapRows(await listRecordings(), [])
  } catch (reason) {
    recordingsError.value = reason?.message || '录像列表读取失败'
  } finally {
    recordingsLoading.value = false
  }
}

async function toggleRecording() {
  const action = isRecording.value ? 'stop' : 'start'
  const result = await run(`record-${action}`, () => controlRecording(action), {
    success: action === 'start' ? '已开始录像' : '已停止录像'
  })
  if (result === undefined) return
  recordingState.value = unwrap(result, recordingState.value)
  lastAction.value = action === 'start' ? '开始录像' : '停止录像'
  await loadRecordings()
}

async function removeRecording(row) {
  try {
    await ElMessageBox.confirm(
      `删除录像「${row.name}」？该操作不可恢复。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const result = await run(`deleteRecording-${row.name}`, () => deleteRecording(row.name), {
    success: '录像已删除'
  })
  if (result === undefined) return
  await loadRecordings()
}

async function tickFrame() {
  if (!usingFallback.value || framePending || pageDisposed) return
  framePending = true
  try {
    const result = await getCameraPreviewFrame()
    if (pageDisposed) return
    const previous = frameSrc.value
    frameSrc.value = URL.createObjectURL(result.data)
    if (previous) URL.revokeObjectURL(previous)
  } catch {
    if (!pageDisposed) onFrameError()
  } finally { framePending = false }
}
watch(usingFallback, (fallback) => { if (fallback) tickFrame() })

onMounted(() => {
  load()
  loadRecordings()
  loadStreamStatus()
  statusTimer = window.setInterval(loadStreamStatus, 3000)
  timer = window.setInterval(tickFrame, FRAME_INTERVAL)
})

// 画面独立于预置点加载；canvas 出现后绑定，attach 可重复调用。
watch(
  videoCanvas,
  (canvas) => {
    if (canvas) stream.attach(canvas)
  },
  { flush: 'post' }
)

// WebSocket 推送即时刷新；状态轮询也覆盖快照降级及消息丢失。
stream.onMessage((message) => {
  if (message.t === 'record') {
    recordingState.value = message
    if (!message.currentFile) loadRecordings()
  }
})

onBeforeUnmount(() => {
  pageDisposed = true
  if (frameSrc.value) URL.revokeObjectURL(frameSrc.value)
  if (timer) window.clearInterval(timer)
  if (statusTimer) window.clearInterval(statusTimer)
})

async function ptz(direction) {
  const result = await run(`ptz-${direction}`, () => ptzContinuous(direction, speed.value), {
    success: `云台${direction === 'stop' ? '停止' : '转动'}指令已下发`
  })
  if (result !== undefined) lastAction.value = direction === 'stop' ? '云台停止' : `云台向${direction}`
}

async function goPreset() {
  if (!currentPresetId.value) {
    ElMessage.warning('请先选择预置点')
    return
  }
  const result = await run('goto', () => gotoCameraPreset(currentPresetId.value), { success: '已下发转到预置点' })
  if (result !== undefined) lastAction.value = `转到 ${currentPreset.value?.name || currentPresetId.value}`
}

async function snapshot() {
  const result = await run('snapshot', () => cameraSnapshot(currentPresetId.value), { success: '抓图完成' })
  if (result === undefined) return
  snapshotAsset.value = unwrap(result, null)
  lastAction.value = '抓图'
}

async function addPreset() {
  const id = Number(newPresetId.value)
  if (!Number.isFinite(id) || id <= 0) {
    ElMessage.warning('请输入有效的预置点 ID')
    return
  }
  const result = await run('savePreset', () => saveCameraPreset(id), { success: `预置点 ${id} 已保存` })
  if (result === undefined) return
  newPresetId.value = ''
  currentPresetId.value = id
  await load()
}

async function removePreset() {
  if (!currentPresetId.value) return
  const target = currentPreset.value
  try {
    await ElMessageBox.confirm(`删除预置点「${target?.name || currentPresetId.value}」？该操作会写入摄像头配置。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  const result = await run('deletePreset', () => deleteCameraPreset(currentPresetId.value), { success: '预置点已删除' })
  if (result === undefined) return
  currentPresetId.value = null
  await load()
}

async function reboot() {
  try {
    await ElMessageBox.confirm('重启摄像头会中断实时画面 1–2 分钟，确认执行？', '重启确认', {
      type: 'warning',
      confirmButtonText: '确认重启',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  const result = await run('reboot', () => rebootCamera(currentPresetId.value), { success: '摄像头重启指令已下发' })
  if (result !== undefined) lastAction.value = '摄像头重启中'
}

async function refresh() {
  await load()
  await loadRecordings()
  stream.reconnect()
  if (!error.value) ElMessage.success('预置点已刷新')
}

function onFrameError() {
  fallbackError.value = true
  fallbackLoaded.value = false
  lastAction.value = '画面读取失败'
}
</script>

<template>
  <div class="view">
    <PageHeader
      title="球形摄像"
      :description="`当前预置点 ${currentPreset?.name || '未选择'} · ${lastAction}`"
      :status-text="feedStatusText"
      :status-type="feedStatusType"
    >
      <template #extra>
        <el-button :icon="Refresh" :loading="loading" @click="refresh">刷新预置点</el-button>
        <el-button type="danger" plain :icon="RefreshRight" :loading="pendingKey === 'reboot'" @click="reboot">重启摄像头</el-button>
      </template>
    </PageHeader>

    <el-alert v-if="error" type="warning" :title="error" :closable="false" />
    <div>
      <div class="camera-layout">
        <section class="view-panel camera-stage">
          <div class="camera-stage__head">
            <span class="camera-live"><i />{{ feedLabel }}</span>
            <span class="text-muted">CH 01 · {{ currentPreset?.name || '手动' }} · {{ resolutionText }}</span>
          </div>
          <div class="camera-stage__frame">
            <!-- 低延迟链路：WebCodecs 解码结果画到 canvas -->
            <canvas
              v-show="!usingFallback"
              ref="videoCanvas"
              class="camera-stage__canvas"
            />
            <!-- 降级链路：保留原有的 JPEG 轮询 -->
            <img
              v-if="usingFallback && frameSrc"
              :src="frameSrc"
              alt="摄像头实时画面"
              @error="onFrameError"
              @load="fallbackLoaded = true; fallbackError = false"
            />
            <div v-if="usingFallback ? !fallbackLoaded : stream.phase.value !== 'live'" class="camera-stage__placeholder">
              <VideoCamera /><strong>{{ feedStatusText }}</strong>
              <el-button size="small" @click="stream.reconnect()">重新连接</el-button>
            </div>
            <span class="camera-stage__meta">{{ isRecording ? '● 录制中' : '实时预览' }}</span>
          </div>

          <dl v-if="!usingFallback" class="camera-metrics">
            <div v-for="item in streamMetrics" :key="item.label" class="camera-metrics__item">
              <dt>{{ item.label }}</dt>
              <dd>{{ item.value }}</dd>
            </div>
          </dl>
          <el-alert
            v-else
            class="camera-tip"
            type="warning"
            :closable="false"
            show-icon
            title="当前使用 JPEG 轮询（约 1 帧/秒）"
            :description="stream.blockReason.value || '低延迟画面需要 HTTPS 或 localhost 访问，且浏览器支持 WebCodecs。'"
          />

          <div class="camera-stage__actions">
            <el-button :type="isRecording ? 'danger' : 'primary'" :icon="VideoCamera"
              :loading="pendingKey === 'record-start' || pendingKey === 'record-stop'"
              :disabled="!recordingState || Boolean(pendingKey)" @click="toggleRecording">
              {{ isRecording ? '停止录像' : '开始录像' }}
            </el-button>
            <el-button type="primary" :icon="Camera" :loading="pendingKey === 'snapshot'" @click="snapshot">抓图</el-button>
            <span class="text-muted">最近抓图：{{ snapshotText }}</span>
          </div>
        </section>

        <section class="view-panel camera-controls">
          <div class="view-panel__head">
            <h2>预置点</h2>
            <small>预置点由摄像头端保存</small>
          </div>
          <el-select v-model="currentPresetId" class="full-control" placeholder="选择预置点">
            <el-option v-for="item in presets" :key="item.presetId" :label="`${item.name}（ID ${item.presetId}）`" :value="item.presetId" />
          </el-select>
          <div class="camera-controls__row">
            <el-button type="primary" :icon="Aim" :loading="pendingKey === 'goto'" :disabled="!currentPresetId" @click="goPreset">转到预置点</el-button>
            <el-button type="danger" plain :icon="Delete" :loading="pendingKey === 'deletePreset'" :disabled="!currentPresetId" @click="removePreset">删除</el-button>
          </div>

          <el-divider content-position="left">新增 / 修改预置点</el-divider>
          <div class="camera-controls__row">
            <el-input-number v-model="newPresetId" :min="1" :max="255" :controls="false" placeholder="预置点 ID" class="preset-input" />
            <el-button type="success" :icon="Plus" :loading="pendingKey === 'savePreset'" @click="addPreset">保存为预置点</el-button>
          </div>
          <p class="text-muted preset-hint">同 ID 再次保存即覆盖该预置点的当前位置。</p>
        </section>

        <section class="view-panel camera-controls">
          <div class="view-panel__head">
            <h2>云台控制</h2>
            <small>速度范围 1–120</small>
          </div>
          <el-slider v-model="speed" :min="1" :max="120" show-input :show-input-controls="false" />

          <div class="ptz-pad">
            <el-button
              v-for="item in PTZ_DIRECTIONS"
              :key="item.direct"
              :type="item.danger ? 'danger' : 'default'"
              :loading="pendingKey === `ptz-${item.direct}`"
              :disabled="Boolean(pendingKey)"
              class="ptz-button"
              @click="ptz(item.direct)"
            >
              {{ item.icon }} {{ item.label }}
            </el-button>
          </div>

          <el-alert
            class="camera-tip"
            type="info"
            :closable="false"
            show-icon
            :title="`方向值按设备协议下发（direct=${PTZ_DIRECTIONS.map((item) => item.direct).join(' / ')}），速度 ${speed}。`"
          />
        </section>
      </div>

      <section class="view-panel">
        <div class="view-panel__head">
          <h2>预置点清单</h2>
          <small>共 {{ presets.length }} 个预置点</small>
        </div>
        <el-table :data="presets" border stripe size="small">
          <template #empty>
            <el-empty description="摄像头未返回预置点" :image-size="64" />
          </template>
          <el-table-column prop="presetId" label="预置点 ID" width="120" />
          <el-table-column prop="name" label="名称" min-width="180" />
          <el-table-column label="操作" width="220">
            <template #default="{ row }">
              <el-button
                text
                type="primary"
                size="small"
                :icon="SwitchButton"
                :loading="pendingKey === 'goto'"
                @click="currentPresetId = row.presetId; goPreset()"
              >
                转到此预置点
              </el-button>
              <el-button text type="warning" size="small" :icon="Warning" @click="currentPresetId = row.presetId; snapshot()">
                抓图
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </section>

      <section class="view-panel camera-recordings">
        <div class="view-panel__head">
          <h2>录像</h2>
          <small>共 {{ recordings.length }} 段 · 录像保存在服务端，停止后可下载</small>
        </div>

        <div class="camera-recordings__bar">
          <el-button
            :type="isRecording ? 'danger' : 'primary'"
            :icon="VideoCamera"
            :loading="pendingKey === 'record-start' || pendingKey === 'record-stop'"
            :disabled="!recordingState || Boolean(pendingKey)"
            @click="toggleRecording"
          >
            {{ isRecording ? '停止录像' : '开始录像' }}
          </el-button>
          <span class="camera-recordings__state">
            <i :class="['camera-recordings__dot', { 'is-on': isRecording }]" />
            {{ recordingStatusText }}
          </span>
          <el-button text :icon="Refresh" :loading="recordingsLoading" @click="loadRecordings">刷新列表</el-button>
        </div>

        <el-alert
          v-if="recordingsError"
          class="camera-tip"
          type="warning"
          :closable="false"
          show-icon
          :title="recordingsError"
        />

        <el-table :data="recordings" border stripe size="small">
          <template #empty>
            <el-empty description="暂无录像分段" :image-size="64" />
          </template>
          <el-table-column prop="name" label="文件名" min-width="240" />
          <el-table-column prop="sizeText" label="大小" width="110" />
          <el-table-column label="时间" width="180">
            <template #default="{ row }">{{ formatTime(row.modifiedAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="170">
            <template #default="{ row }">
              <el-button text type="primary" :disabled="row.active" :loading="pendingKey === `download-${row.name}`" @click="download(row)">下载</el-button>
              <el-button
                text
                type="danger"
                size="small"
                :icon="Delete"
                :loading="pendingKey === `deleteRecording-${row.name}`"
                :disabled="row.active"
                @click="removeRecording(row)"
              >
                删除
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </div>
  </div>
</template>

<style scoped>
.camera-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 320px);
  gap: 16px;
  margin-bottom: 16px;
}

@media (max-width: 1200px) {
  .camera-layout {
    grid-template-columns: 1fr 1fr;
  }
}

@media (max-width: 820px) {
  .camera-layout {
    grid-template-columns: 1fr;
  }
}

.camera-stage { grid-row: span 2; }
.camera-stage__placeholder {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 16px;
  color: #c4ccd8; background: rgb(15 20 25 / 85%); text-align: center; padding: 20px;
}
.camera-stage__placeholder svg { width: 42px; height: 42px; }

.camera-stage__head,
.camera-stage__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.camera-live {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 1px;
  color: var(--el-color-danger);
}

.camera-live i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentcolor;
}

.camera-stage__frame {
  position: relative;
  margin: 12px 0;
  border-radius: 8px;
  overflow: hidden;
  background: #0f1419;
  aspect-ratio: 16 / 9;
}

.camera-stage__frame img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

/* 画面层：canvas 的像素尺寸由解码帧决定，等比缩放铺满舞台。 */
.camera-stage__canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.camera-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(84px, 1fr));
  gap: 8px;
  margin: 0 0 12px;
}

.camera-metrics__item {
  padding: 6px 8px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-fill-color-lighter);
}

.camera-metrics__item dt {
  margin: 0;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.camera-metrics__item dd {
  margin: 2px 0 0;
  font-size: 13px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-primary);
}

.camera-stage__meta {
  position: absolute;
  left: 10px;
  bottom: 8px;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgb(0 0 0 / 55%);
  color: #fff;
  font-size: 11px;
}

.full-control,
.preset-input {
  width: 100%;
}

.camera-controls__row {
  display: flex;
  gap: 10px;
  margin-top: 12px;
  flex-wrap: wrap;
}

.preset-hint {
  margin: 10px 0 0;
  font-size: 12px;
}

.ptz-pad {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-top: 12px;
}

.ptz-button {
  width: 100%;
  margin-left: 0 !important;
}

.camera-tip {
  margin-top: 14px;
}

/* ------------------------------- 录像 ------------------------------- */

.camera-recordings {
  margin-top: 16px;
}

.camera-recordings__bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.camera-recordings__state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 auto;
  min-width: 200px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.camera-recordings__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--el-text-color-placeholder);
}

.camera-recordings__dot.is-on {
  background: var(--el-color-danger);
}

.camera-recordings__link {
  margin-right: 12px;
  font-size: 12px;
}
</style>
