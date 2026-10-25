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
  Aim, Delete, FolderOpened, Plus, Refresh, RefreshRight, SwitchButton, VideoCamera
} from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import {
  deleteCameraPreset, gotoCameraPreset, listCameraPresets,
  ptzContinuous, rebootCamera, saveCameraPreset
} from '@/api/safety'
import {
  controlRecording, listRecordings, getCameraStreamStatus, getCameraPreviewFrame,
  openRecordingsFolder
} from '@/api/cameraStream'
import { unwrap, unwrapRows } from '@/api/envelope'
import { useAsyncData } from '@/composables/useAsyncData'
import { useAsyncTask } from '@/composables/useAsyncTask'
import { useCameraStream } from '@/composables/useCameraStream'
import { useRefreshFeedback } from '@/composables/useRefreshFeedback'
import { formatTime } from '@/utils/format'
import { ptzSpeedRatio } from '@/utils/cameraControl'
import { getErrorMessage } from '@/utils/request'
import { configuredRecordingsDir, openLocalFolder } from '@/utils/localFolder'

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
const speed = ref(30)
const frameSrc = ref('')
let framePending = false
let pageDisposed = false
const lastAction = ref('待命')
const newPresetId = ref('')

const recordings = ref([])
// 后端配置的录像目录绝对路径（默认 data/dome-cam/recordings），只读展示，不可修改。
const recordingsDir = ref('')
const recordingState = ref(null)
const recordingsError = ref('')
const recordingsLoading = ref(false)

const videoCanvas = ref(null)
const stream = useCameraStream()

const { pendingKey, run } = useAsyncTask()
const { refresh: refreshWithFeedback } = useRefreshFeedback()
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

async function loadRecordings() {
  recordingsLoading.value = true
  recordingsError.value = ''
  try {
    const response = await listRecordings()
    recordings.value = unwrapRows(response, [])
    recordingsDir.value = String(unwrap(response, {})?.dir || '')
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

function pauseFramePolling() {
  if (timer) {
    window.clearInterval(timer)
    timer = null
  }
}

function resumeFramePolling() {
  if (timer || pageDisposed) return
  timer = window.setInterval(tickFrame, FRAME_INTERVAL)
  if (usingFallback.value) tickFrame()
}

// 页面不可见时同时停掉云台与截图轮询：后台标签页没有必要每秒拉一张 JPEG。
function handleVisibility() {
  if (document.hidden) {
    releasePtz()
    pauseFramePolling()
    return
  }
  resumeFramePolling()
}

onMounted(() => {
  load()
  loadRecordings()
  loadStreamStatus()
  statusTimer = window.setInterval(loadStreamStatus, 3000)
  resumeFramePolling()
  window.addEventListener('mouseup', releasePtz)
  window.addEventListener('blur', releasePtz)
  document.addEventListener('visibilitychange', handleVisibility)
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
  // 卸载前先停转：按着方向键切走页面时，相机不能继续转。
  if (ptzActive.value) ptzContinuous('stop', 0).catch(() => {})
  if (frameSrc.value) URL.revokeObjectURL(frameSrc.value)
  if (timer) window.clearInterval(timer)
  if (statusTimer) window.clearInterval(statusTimer)
  window.removeEventListener('mouseup', releasePtz)
  window.removeEventListener('blur', releasePtz)
  document.removeEventListener('visibilitychange', handleVisibility)
})

// -------------------------------- 云台 -------------------------------------
// 按住转动：按下即开始连续转动，松开 / 移出按钮 / 窗口失焦 / 切换标签页立刻停止。
// 改造前是「点一下开始转，必须再点一次停止」——鼠标移开画面相机仍在转，
// 对一台能拍到整舍的球机来说这是明确的误操作风险。
const ptzActive = ref('')
let ptzStartPromise = null

function ptzDirectionLabel(direct) {
  return PTZ_DIRECTIONS.find((item) => item.direct === direct)?.label || direct
}

async function ptzStart(direct) {
  if (direct === 'stop') {
    await ptzStop()
    return
  }
  if (ptzActive.value) return
  let speedRatio
  try {
    speedRatio = ptzSpeedRatio(speed.value)
  } catch (reason) {
    ElMessage.error(getErrorMessage(reason, '云台速度参数无效'))
    return
  }
  ptzActive.value = direct
  lastAction.value = `云台向${ptzDirectionLabel(direct)}`
  ptzStartPromise = ptzContinuous(direct, speedRatio).catch((reason) => {
    ElMessage.error(getErrorMessage(reason, '云台指令下发失败'))
    if (ptzActive.value === direct) ptzActive.value = ''
  })
  await ptzStartPromise
}

async function ptzStop() {
  if (!ptzActive.value) return
  ptzActive.value = ''
  lastAction.value = '云台停止'
  // 必须等启动请求落地再发停止：并发下发时若停止先到、启动后到，
  // 相机就会停在「一直在转」的状态。
  try {
    await ptzStartPromise
  } catch {
    /* 启动失败已在 ptzStart 内提示 */
  }
  ptzStartPromise = null
  try {
    await ptzContinuous('stop', 0)
  } catch (reason) {
    ElMessage.error(getErrorMessage(reason, '云台停止指令下发失败'))
  }
}

// 松开位置可能在按钮之外（拖出去、右键、触屏），所以监听 document 级事件兜底。
function releasePtz() {
  if (ptzActive.value) ptzStop()
}

function handlePtzVisibility() {
  if (document.hidden) releasePtz()
}

async function goPreset() {
  if (!currentPresetId.value) {
    ElMessage.warning('请先选择预置点')
    return
  }
  const result = await run('goto', () => gotoCameraPreset(currentPresetId.value), { success: '已下发转到预置点' })
  if (result !== undefined) lastAction.value = `转到 ${currentPreset.value?.name || currentPresetId.value}`
}

// 录像目录由后端配置决定（默认 data/dome-cam/recordings），页面不提供修改入口。
// 主路径是请后端在**它所在的主机**上拉起资源管理器——浏览器不允许 http 页面
// 跳 file://，所以只有服务端能真正打开。服务端没有桌面会话时退回本机尝试 +
// 复制路径，保证按钮不会"点了没反应"。
async function openFolder() {
  try {
    const result = unwrap(await openRecordingsFolder(), {})
    if (result.opened) {
      ElMessage.success({
        message: `已打开录像目录：${result.dir || recordingsDir.value}`,
        duration: 4000
      })
      return
    }
    await openFolderOnThisMachine(result.dir || recordingsDir.value)
  } catch (reason) {
    // 旧后端没有该接口（404）或服务不可用：走本机兜底
    await openFolderOnThisMachine(recordingsDir.value || configuredRecordingsDir(), reason)
  }
}

/** 降级：尝试用浏览器打开本机同名路径，并始终把路径复制给用户。 */
async function openFolderOnThisMachine(dir, reason) {
  const target = String(dir || '').trim()
  if (!target) {
    ElMessage.warning(getErrorMessage(reason, '后端未返回录像目录，暂时无法打开'))
    return
  }
  const { opened, copied } = await openLocalFolder(target)
  if (opened) {
    ElMessage.success({
      message: copied
        ? `已请求打开录像目录：${target}；若浏览器拦截了本地路径，路径已复制`
        : `已请求打开录像目录：${target}`,
      duration: 8000
    })
  } else if (copied) {
    ElMessage.warning({
      message: `浏览器禁止网页直接打开本地文件夹，目录路径已复制，请粘贴到资源管理器地址栏：${target}`,
      duration: 8000
    })
  } else {
    ElMessage.warning(`录像目录：${target}`)
  }
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
  await refreshWithFeedback(async () => {
    await load()
    await loadRecordings()
    stream.reconnect()
    return !error.value && !recordingsError.value
  }, {
    success: '预置点与录像已刷新',
    failure: '刷新失败，请检查摄像头服务',
    isError: () => error.value || recordingsError.value
  })
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
          <small>速度范围 1–100%</small>
        </div>
        <el-slider v-model="speed" :min="1" :max="100" :format-tooltip="(value) => `${value}%`" show-input :show-input-controls="false" />

        <!-- 按住转动 / 松开停止：不再需要用户额外记得点「停止」 -->
        <div class="ptz-pad" role="group" aria-label="云台方向控制">
          <el-button
            v-for="item in PTZ_DIRECTIONS"
            :key="item.direct"
            :type="item.danger ? 'danger' : 'default'"
            :class="['ptz-button', { 'is-pressing': ptzActive === item.direct }]"
            :disabled="Boolean(ptzActive) && ptzActive !== item.direct && item.direct !== 'stop'"
            @mousedown.prevent="item.direct === 'stop' ? ptzStop() : ptzStart(item.direct)"
            @touchstart.prevent="item.direct === 'stop' ? ptzStop() : ptzStart(item.direct)"
            @mouseup="ptzStop"
            @mouseleave="ptzStop"
            @touchend.prevent="ptzStop"
            @touchcancel.prevent="ptzStop"
            @keydown.enter.prevent="item.direct === 'stop' ? ptzStop() : ptzStart(item.direct)"
            @keydown.space.prevent="item.direct === 'stop' ? ptzStop() : ptzStart(item.direct)"
            @keyup.enter="ptzStop"
            @keyup.space="ptzStop"
          >
            <span class="ptz-button__icon" aria-hidden="true">{{ item.icon }}</span>
            <span>{{ item.label }}</span>
          </el-button>
        </div>

        <p class="ptz-hint" role="status" aria-live="polite">
          <template v-if="ptzActive">正在向{{ ptzDirectionLabel(ptzActive) }}转动 · 松开即停</template>
          <template v-else>按住方向按钮转动，松开立即停止</template>
        </p>

        <el-alert
          class="camera-tip"
          type="info"
          :closable="false"
          show-icon
          :title="`方向值按设备协议下发（direct=${PTZ_DIRECTIONS.map((item) => item.direct).join(' / ')}），当前速度 ${speed}%。`"
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
        <el-table-column label="操作" width="140">
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
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section class="view-panel camera-recordings">
      <div class="view-panel__head">
        <div class="camera-recordings__title">
          <h2>录像</h2>
          <!-- 目录只读展示：存储位置由后端配置，页面不提供修改入口 -->
          <small :title="recordingsDir || '录像目录由后端配置'">
            {{ recordingsDir || '目录由后端配置' }}
          </small>
        </div>
        <div class="camera-recordings__actions">
          <el-button text :icon="Refresh" :loading="recordingsLoading" @click="loadRecordings">刷新列表</el-button>
          <el-tooltip :content="recordingsDir ? `打开 ${recordingsDir}` : '打开录像存储目录'" placement="top">
            <el-button text :icon="FolderOpened" @click="openFolder">打开目录</el-button>
          </el-tooltip>
        </div>
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
      </el-table>
    </section>
  </div>
</template>

<style scoped>
.camera-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 320px);
  gap: var(--app-gap);
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

/* 画面层：canvas 背板按显示尺寸（DPR 上限 2）分配，不高于源分辨率，再等比铺满舞台。 */
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
  /* 按住拖动时不要触发文本选中或页面滚动 */
  user-select: none;
  touch-action: none;
}

.ptz-button__icon {
  margin-right: 4px;
  font-size: 13px;
}

/* 按住期间的即时反馈：按钮压深 + 内阴影，用户能确认"指令正在生效" */
.ptz-button.is-pressing {
  transform: translateY(1px);
  box-shadow: inset 0 2px 6px rgb(0 0 0 / 18%);
  filter: brightness(0.94);
}

.ptz-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--app-text-muted);
  text-align: center;
}

.camera-tip {
  margin-top: 14px;
}

/* ------------------------------- 录像 ------------------------------- */

.camera-recordings__title {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.camera-recordings__title small {
  overflow: hidden;
  max-width: 420px;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--app-font-mono);
}

.camera-recordings__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

@media (max-width: 900px) {
  .camera-recordings__title small {
    max-width: 100%;
  }
}
</style>
