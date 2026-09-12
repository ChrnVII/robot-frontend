<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  ArrowLeft, ArrowRight, Bottom, FolderOpened, Loading, Microphone, Picture, Refresh, Tools, Top,
  VideoCamera, VideoCameraFilled, VideoPause, VideoPlay
} from '@element-plus/icons-vue'
import { getPlatformInfo } from '@/api/system'
import {
  apiErrorMessage, captureMedia, getDetections, getInspectionConfig, getInspectionImageUrl,
  getInspectionStatus, getInspectionStreamUrl, getRobotState, moveInspectionLift, startInspection,
  stopInspection, stopInspectionLift, unwrap
} from '@/api/inspection'

// 后端巡检模式只接受 1 / 4 / 8 路摄像头，通道数量决定 mode。
const MODE_BY_CAMERA_COUNT = { 1: 'single', 4: 'four', 8: 'eight' }
const MODE_LABELS = { single: '单路', four: '四路', eight: '八路' }
const STATE_LABELS = {
  idle: '等待启动',
  starting: '启动中',
  running: '检测进行中',
  stopping: '停止中',
  completed: '已完成',
  stopped: '已停止',
  failed: '失败'
}
const STATE_TAGS = {
  idle: 'info',
  starting: 'warning',
  running: 'success',
  stopping: 'warning',
  completed: 'primary',
  stopped: 'info',
  failed: 'danger'
}
const TERMINAL_STATES = ['completed', 'stopped', 'failed']
const HEALTH_LABELS = { ok: '正常', healthy: '正常', degraded: '降级', warning: '告警', error: '故障', unavailable: '不可用' }
const QUALITY_LABELS = { valid: '有效', invalid: '无效', uncertain: '不确定', degraded: '降级' }

// 八路巡检通道是机器人固定的设备拓扑，通道状态一律以后端设备接口为准。
const CAMERA_CHANNELS = Array.from({ length: 8 }, (_, index) => {
  const code = String(index + 1).padStart(2, '0')
  return { id: `cam${code}`, label: `摄像头 ${code}` }
})
const ACTIVE_INSPECTION_KEY = 'inspection-robot.active-inspection'
const SELECTED_CAMERAS_KEY = 'inspection-robot.selected-cameras'
const AUDIO_PARAMETERS = { sample_rate: 16000, channels: 1, duration_seconds: 3 }
const POLL_INTERVAL = 2500
const DEVICE_STATE_INTERVAL = 15000
const RESULT_PAGE_SIZE = 24
const STREAM_MAX_ATTEMPTS = 4

const cameras = reactive(CAMERA_CHANNELS.map((channel) => ({ ...channel, selected: false })))
const deviceStates = ref({})
const deviceStatesReady = ref(false)
const deviceStatesError = ref('')
const platform = ref(null)

const runtime = reactive({ environments: [], modelPath: '', configPath: '', resultPath: '', hint: '', error: '' })
const runtimeLoading = ref(false)
const form = reactive({ environment: '', durationSeconds: 0 })

const audio = reactive({ capturing: false, asset: null })
const liftBusy = ref('')

const task = reactive({
  taskRunId: '',
  mode: '',
  state: 'idle',
  processed: 0,
  positive: 0,
  startedAt: null,
  finishedAt: null,
  error: '',
  cameraErrors: {}
})

const detections = ref([])
const resultsTotal = ref(0)
const resultsMore = ref(false)
const resultIndex = ref(0)
const resultsLoading = ref(false)
const resultsError = ref('')
const liveFrames = reactive({})
const busy = ref('')
const restoring = ref(false)

let pollTimer = null
let deviceTimer = null
let stream = null
let streamRetryTimer = null
let streamAttempts = 0
let resultsAutoLoaded = false

const selectedCameras = computed(() => cameras.filter((camera) => camera.selected))
const mode = computed(() => MODE_BY_CAMERA_COUNT[selectedCameras.value.length] || '')
const modeLabel = computed(() => MODE_LABELS[task.mode || mode.value] || '未启动')
const isRunning = computed(() => ['starting', 'running', 'stopping'].includes(task.state))
const stateLabel = computed(() => STATE_LABELS[task.state] || task.state || STATE_LABELS.idle)
const stateTag = computed(() => STATE_TAGS[task.state] || 'info')
const cameraErrorList = computed(() => Object.entries(task.cameraErrors || {}).map(([id, message]) => `${id}: ${message}`))

const environmentPlaceholder = computed(() => {
  if (runtimeLoading.value) return '读取中…'
  return runtime.environments.length ? '请选择运行环境' : '后端未返回可用运行环境'
})
const platformHint = computed(() => {
  if (!platform.value) return ''
  const { robotId, mode: platformMode } = platform.value
  return [robotId && `机器人 ${robotId}`, platformMode && `模式 ${platformMode}`, platform.value.apiVersion && `API ${platform.value.apiVersion}`]
    .filter(Boolean)
    .join(' · ')
})
const environmentHint = computed(() => runtime.hint || (runtime.error ? `运行配置读取失败：${runtime.error}` : '虚拟环境、模型权重和结果目录由后端巡检配置提供'))

const audioDescription = computed(() => {
  if (audio.capturing) return '正在采集音频…'
  if (audio.asset?.assetId) {
    const size = Number(audio.asset.sizeBytes)
    return Number.isFinite(size) ? `已保存 · ${audio.asset.assetId} · ${(size / 1024).toFixed(1)} KB` : `已保存 · ${audio.asset.assetId}`
  }
  return `点击采集 ${AUDIO_PARAMETERS.duration_seconds} 秒音频`
})

const currentResult = computed(() => detections.value[resultIndex.value] || null)
const currentResultImageUrl = computed(() => getInspectionImageUrl(task.taskRunId, currentResult.value?.resultImageId))
const currentLiveFrame = computed(() => {
  const cameraId = currentResult.value?.cameraId
  if (cameraId && liveFrames[cameraId]) return liveFrames[cameraId]
  const keys = Object.keys(liveFrames)
  return keys.length ? liveFrames[keys[0]] : ''
})
const previewSrc = computed(() => currentLiveFrame.value || currentResultImageUrl.value)
const previewList = computed(() => (previewSrc.value ? [previewSrc.value] : []))
const previewEmptyText = computed(() => {
  if (resultsLoading.value) return '结果加载中…'
  if (detections.value.length) return '当前检测记录没有返回标注图'
  return '暂无检测结果图，启动检测后点击「加载结果图」'
})
const currentLabels = computed(() => {
  const result = currentResult.value
  if (!result) return []
  if (result.countByLabel && typeof result.countByLabel === 'object') {
    return Object.entries(result.countByLabel).map(([label, count]) => `${label} × ${count}`)
  }
  if (Array.isArray(result.detections)) {
    return result.detections.map((item) => item?.label || item?.className || item?.class).filter(Boolean)
  }
  return []
})

// 设备状态：一次 robot/state 覆盖全部通道，避免 8 次单独请求。
function normalizeDeviceStates(payload) {
  const source = payload?.devices || payload?.deviceStates || payload
  if (!source || typeof source !== 'object') return {}
  const entries = Array.isArray(source)
    ? source.filter((item) => item?.deviceId).map((item) => [item.deviceId, item])
    : Object.entries(source).filter(([, value]) => value && typeof value === 'object')
  return entries.reduce((result, [key, value]) => {
    result[String(value.deviceId || key).toLowerCase()] = value
    return result
  }, {})
}

function resolveDeviceState(deviceId) {
  const states = deviceStates.value
  const key = String(deviceId || '').toLowerCase()
  if (states[key]) return states[key]
  const digits = key.replace(/\D/g, '')
  if (!digits) return null
  const matched = Object.keys(states).find((item) => /cam|video/.test(item) && item.replace(/\D/g, '') === digits)
  return matched ? states[matched] : null
}

function cameraDescription(camera) {
  const state = resolveDeviceState(camera.id)
  if (!state) {
    if (deviceStatesReady.value) return '后端未上报该通道状态'
    return deviceStatesError.value || '状态读取中…'
  }
  const parts = []
  if (state.health) parts.push(HEALTH_LABELS[state.health] || state.health)
  if (state.quality) parts.push(QUALITY_LABELS[state.quality] || state.quality)
  if (!parts.length && state.values && typeof state.values === 'object') {
    const streaming = state.values.streaming ?? state.values.online ?? state.values.enabled
    if (streaming !== undefined) parts.push(streaming ? '视频流已开' : '视频流已关')
  }
  return parts.join(' · ') || '已上报状态'
}

async function loadDeviceStates() {
  try {
    deviceStates.value = normalizeDeviceStates(unwrap(await getRobotState(), {}))
    deviceStatesReady.value = true
    deviceStatesError.value = ''
  } catch (error) {
    deviceStatesReady.value = false
    deviceStatesError.value = apiErrorMessage(error, '设备状态读取失败')
  }
}

async function loadPlatformInfo() {
  try {
    platform.value = unwrap(await getPlatformInfo(), null)
  } catch {
    platform.value = null
  }
}

// 运行配置：虚拟环境、模型权重、配置文件和结果目录都由后端配置接口返回，前端只做只读展示。
function pickText(source, keys) {
  for (const key of keys) {
    const value = source?.[key]
    if (typeof value === 'string' && value.trim()) return value
    if (value && typeof value === 'object' && typeof value.path === 'string') return value.path
  }
  return ''
}

function applyRuntimeConfig(data) {
  const source = data && typeof data === 'object' ? data : {}
  const rawList = source.environments || source.profiles || source.runtimes || source.virtualEnvironments
  const list = []
  if (Array.isArray(rawList)) {
    rawList.forEach((item) => {
      const value = typeof item === 'string' ? item : item?.value ?? item?.id ?? item?.name
      if (!value) return
      list.push({
        value: String(value),
        label: typeof item === 'string' ? item : String(item.label || item.name || value),
        detail: String((typeof item === 'object' && (item.detail || item.description)) || '')
      })
    })
  }
  const single = source.environment || source.virtualEnvironment
  if (!list.length && single) {
    list.push({ value: String(single), label: String(single), detail: String(source.environmentDetail || '') })
  }
  runtime.environments = list
  form.environment = list.some((item) => item.value === form.environment) ? form.environment : list[0]?.value || ''
  runtime.modelPath = pickText(source, ['modelPath', 'model', 'weights', 'modelWeights'])
  runtime.configPath = pickText(source, ['configPath', 'configFile', 'inspectionConfig'])
  runtime.resultPath = pickText(source, ['resultPath', 'resultDir', 'outputDir', 'resultsDir'])
  runtime.hint = list.find((item) => item.value === form.environment)?.detail || ''
}

async function loadRuntimeConfig() {
  runtimeLoading.value = true
  try {
    applyRuntimeConfig(unwrap(await getInspectionConfig({ configType: 'inspection' }), {}))
    runtime.error = ''
  } catch (error) {
    runtime.environments = []
    form.environment = ''
    runtime.error = apiErrorMessage(error, '运行配置读取失败')
  } finally {
    runtimeLoading.value = false
  }
}

function readJson(key) {
  try {
    return JSON.parse(window.localStorage.getItem(key) || 'null')
  } catch {
    return null
  }
}

function applyCameraSelection(cameraIds) {
  const selected = new Set(cameraIds || [])
  cameras.forEach((camera) => { camera.selected = selected.has(camera.id) })
}

function persistCameraSelection() {
  window.localStorage.setItem(SELECTED_CAMERAS_KEY, JSON.stringify(selectedCameras.value.map((camera) => camera.id)))
}

function persistActiveInspection() {
  if (!task.taskRunId) return
  window.localStorage.setItem(ACTIVE_INSPECTION_KEY, JSON.stringify({
    taskRunId: task.taskRunId,
    mode: task.mode,
    cameraIds: selectedCameras.value.map((camera) => camera.id)
  }))
}

function clearActiveInspection() {
  window.localStorage.removeItem(ACTIVE_INSPECTION_KEY)
}

function toggleCamera(camera) {
  if (isRunning.value) {
    ElMessage.warning('检测进行中，请先停止任务再调整参与检测的摄像头')
    return
  }
  camera.selected = !camera.selected
  persistCameraSelection()
}

async function captureAudio() {
  if (audio.capturing) return
  audio.capturing = true
  try {
    const asset = unwrap(await captureMedia({
      taskRunId: task.taskRunId || `manual-${Date.now()}`,
      waypointId: 'inspection-audio',
      deviceId: 'audio',
      mediaType: 'audio',
      parameters: AUDIO_PARAMETERS
    }), null)
    if (!asset?.assetId) throw new Error('后端未返回音频资产 assetId')
    audio.asset = asset
    ElMessage.success(`音频采集完成 · ${asset.assetId}`)
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, '音频采集失败'))
  } finally {
    audio.capturing = false
  }
}

async function handleLift(action) {
  const labels = { up: '升起', down: '下降', stop: '停止' }
  liftBusy.value = action
  try {
    if (action === 'stop') await stopInspectionLift()
    else await moveInspectionLift(action)
    ElMessage.success(`检测升降${labels[action] || action}指令已下发`)
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, `检测升降${labels[action] || action}失败`))
  } finally {
    liftBusy.value = ''
  }
}

function applyStatus(status) {
  if (!status || typeof status !== 'object') return
  ;['taskRunId', 'mode', 'state', 'processed', 'positive', 'startedAt', 'finishedAt', 'error', 'cameraErrors'].forEach((key) => {
    if (status[key] !== undefined && status[key] !== null) task[key] = status[key]
  })
  if (isRunning.value) {
    persistActiveInspection()
    return
  }
  if (TERMINAL_STATES.includes(task.state)) {
    stopPolling()
    closeStream()
    clearActiveInspection()
    if (!resultsAutoLoaded && task.taskRunId && task.positive > 0) {
      resultsAutoLoaded = true
      loadResults()
    }
  }
}

function startPolling() {
  stopPolling()
  pollTimer = window.setInterval(async () => {
    if (!task.taskRunId || !isRunning.value) return
    try {
      applyStatus(unwrap(await getInspectionStatus(task.taskRunId), {}))
    } catch (error) {
      ElMessage.error(apiErrorMessage(error, '巡检状态读取失败'))
      stopPolling()
    }
  }, POLL_INTERVAL)
}

function stopPolling() {
  if (pollTimer) window.clearInterval(pollTimer)
  pollTimer = null
}

function scheduleStreamReconnect() {
  if (streamRetryTimer || streamAttempts >= STREAM_MAX_ATTEMPTS) return
  const delay = Math.min(2000 * 2 ** streamAttempts, 15000)
  streamAttempts += 1
  streamRetryTimer = window.setTimeout(() => {
    streamRetryTimer = null
    if (isRunning.value) openStream()
  }, delay)
}

// WebSocket 只提供低延迟状态和实时标注帧，生命周期仍以轮询为准。
function openStream() {
  closeStream()
  const url = getInspectionStreamUrl(task.taskRunId)
  if (!url || typeof WebSocket === 'undefined') return
  try {
    stream = new WebSocket(url)
  } catch {
    stream = null
    return
  }
  stream.onopen = () => { streamAttempts = 0 }
  stream.onmessage = handleStreamMessage
  stream.onerror = () => {}
  stream.onclose = () => {
    stream = null
    if (isRunning.value) scheduleStreamReconnect()
  }
}

function closeStream() {
  if (streamRetryTimer) {
    window.clearTimeout(streamRetryTimer)
    streamRetryTimer = null
  }
  if (!stream) return
  const current = stream
  stream = null
  current.onclose = null
  current.onmessage = null
  current.onerror = null
  try {
    current.close()
  } catch {
    // 连接已经关闭时忽略。
  }
}

function handleStreamMessage(event) {
  let payload
  try {
    payload = JSON.parse(event.data)
  } catch {
    return
  }
  const data = payload?.data || {}
  if (data.status) applyStatus(data.status)
  if (!detections.value.length && Array.isArray(data.detections?.items) && data.detections.items.length) {
    detections.value = data.detections.items
    resultsTotal.value = Number(data.detections.total) || data.detections.items.length
    resultsMore.value = detections.value.length < resultsTotal.value
    resultIndex.value = 0
  }
  const frames = data.frames?.frames || data.frames
  if (frames && typeof frames === 'object' && !Array.isArray(frames)) {
    Object.entries(frames).forEach(([cameraId, frame]) => {
      if (frame?.available && frame.jpegBase64) {
        liveFrames[frame.cameraId || cameraId] = `data:image/jpeg;base64,${frame.jpegBase64}`
      }
    })
    return
  }
  const frame = data.frame
  if (frame?.available && frame.jpegBase64) {
    liveFrames[frame.cameraId || 'cam01'] = `data:image/jpeg;base64,${frame.jpegBase64}`
  }
}

async function startDetection() {
  const cameraIds = selectedCameras.value.map((camera) => camera.id)
  const startMode = MODE_BY_CAMERA_COUNT[cameraIds.length]
  if (!startMode) {
    ElMessage.warning('请选择 1 路、4 路或 8 路摄像头后再开始检测')
    return
  }
  busy.value = 'start'
  try {
    const started = unwrap(await startInspection({
      mode: startMode,
      cameraIds,
      durationSeconds: Number(form.durationSeconds) || 0
    }), {})
    detections.value = []
    resultsTotal.value = 0
    resultsMore.value = false
    resultIndex.value = 0
    resultsError.value = ''
    resultsAutoLoaded = false
    streamAttempts = 0
    Object.keys(liveFrames).forEach((key) => { delete liveFrames[key] })
    Object.assign(task, { taskRunId: '', mode: startMode, state: 'starting', processed: 0, positive: 0, error: '', cameraErrors: {} })
    applyStatus(started)
    if (!task.taskRunId) {
      ElMessage.warning('后端未返回 taskRunId，任务状态无法跟踪')
      return
    }
    ElMessage.success(`检测任务已启动 · ${modeLabel.value}`)
    startPolling()
    openStream()
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, '启动检测失败'))
  } finally {
    busy.value = ''
  }
}

async function stopDetection() {
  if (!task.taskRunId) return
  busy.value = 'stop'
  try {
    applyStatus(unwrap(await stopInspection(task.taskRunId), {}))
    if (isRunning.value) task.state = 'stopping'
    ElMessage.success('停止指令已下发')
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, '停止检测失败'))
  } finally {
    busy.value = ''
  }
}

async function loadResults({ append = false } = {}) {
  if (!task.taskRunId) {
    ElMessage.warning('请先启动一次检测任务')
    return
  }
  resultsLoading.value = true
  resultsError.value = ''
  try {
    const offset = append ? detections.value.length : 0
    const page = unwrap(await getDetections(task.taskRunId, { offset, limit: RESULT_PAGE_SIZE }), {})
    const items = Array.isArray(page) ? page : page.items || []
    detections.value = append ? [...detections.value, ...items] : items
    const total = Number(Array.isArray(page) ? items.length : page.total)
    resultsTotal.value = Number.isFinite(total) ? total : detections.value.length
    resultsMore.value = detections.value.length < resultsTotal.value
    if (!append) resultIndex.value = 0
    if (!append) {
      if (detections.value.length) ElMessage.success(`已加载 ${detections.value.length} 条检测记录`)
      else ElMessage.warning('当前任务暂无阳性检测记录')
    }
  } catch (error) {
    resultsError.value = apiErrorMessage(error, '检测结果加载失败')
    if (!append) detections.value = []
  } finally {
    resultsLoading.value = false
  }
}

function moveResult(delta) {
  if (detections.value.length < 2) return
  resultIndex.value = (resultIndex.value + delta + detections.value.length) % detections.value.length
}

function selectResult(index) {
  resultIndex.value = index
}

function handleKeydown(event) {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName)) return
  if (!detections.value.length) return
  if (event.key === 'ArrowLeft') moveResult(-1)
  if (event.key === 'ArrowRight') moveResult(1)
}

function formatTime(value) {
  if (value === undefined || value === null || value === '') return '—'
  const date = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false })
}

function thumbnailUrl(item) {
  return getInspectionImageUrl(task.taskRunId, item?.resultImageId || item?.originalImageId)
}

async function restoreActiveInspection() {
  const savedCameras = readJson(SELECTED_CAMERAS_KEY)
  if (Array.isArray(savedCameras)) applyCameraSelection(savedCameras)
  const saved = readJson(ACTIVE_INSPECTION_KEY)
  if (!saved?.taskRunId) return
  restoring.value = true
  try {
    applyStatus(unwrap(await getInspectionStatus(saved.taskRunId), {}))
    if (!task.taskRunId) task.taskRunId = saved.taskRunId
    if (Array.isArray(saved.cameraIds) && saved.cameraIds.length) applyCameraSelection(saved.cameraIds)
    if (isRunning.value) {
      startPolling()
      openStream()
    } else {
      clearActiveInspection()
    }
  } catch (error) {
    clearActiveInspection()
    if (error?.response?.status !== 404) ElMessage.error(apiErrorMessage(error, '巡检任务状态恢复失败'))
  } finally {
    restoring.value = false
  }
}

onMounted(() => {
  loadDeviceStates()
  loadPlatformInfo()
  loadRuntimeConfig()
  restoreActiveInspection()
  deviceTimer = window.setInterval(loadDeviceStates, DEVICE_STATE_INTERVAL)
  window.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  stopPolling()
  closeStream()
  if (deviceTimer) window.clearInterval(deviceTimer)
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div class="detection-view">
    <div class="panel-row">
      <!-- 01 / INPUTS：参与检测的摄像头与音频、升降输入 -->
      <el-card class="panel" shadow="never">
        <template #header>
          <div class="panel-head">
            <div class="panel-head__title">
              <span class="eyebrow">01 / INPUTS</span>
              <h2>摄像头与音频</h2>
            </div>
            <div class="panel-head__meta">
              <el-tag :type="selectedCameras.length ? 'primary' : 'info'" effect="light" round>
                {{ selectedCameras.length }} / {{ cameras.length }} 已启用
              </el-tag>
            </div>
          </div>
        </template>

        <div class="camera-grid">
          <el-tooltip
            v-for="camera in cameras"
            :key="camera.id"
            :content="camera.selected ? '点击取消该摄像头参与检测' : '点击让该摄像头参与本次检测'"
            placement="top"
          >
            <button
              type="button"
              class="input-tile"
              :class="{ 'is-active': camera.selected }"
              :disabled="isRunning"
              @click="toggleCamera(camera)"
            >
              <span class="input-tile__icon">
                <el-icon>
                  <VideoCameraFilled v-if="camera.selected" />
                  <VideoCamera v-else />
                </el-icon>
              </span>
              <span class="input-tile__body">
                <strong>{{ camera.label }}</strong>
                <small>{{ cameraDescription(camera) }}</small>
              </span>
              <span class="input-tile__state">{{ camera.selected ? 'ON' : 'OFF' }}</span>
            </button>
          </el-tooltip>
        </div>

        <div class="media-row">
          <button
            type="button"
            class="input-tile"
            :class="{ 'is-active': Boolean(audio.asset) }"
            :disabled="audio.capturing"
            @click="captureAudio"
          >
            <span class="input-tile__icon">
              <el-icon :class="{ 'is-spin': audio.capturing }">
                <Loading v-if="audio.capturing" />
                <Microphone v-else />
              </el-icon>
            </span>
            <span class="input-tile__body">
              <strong>麦克风</strong>
              <small>{{ audioDescription }}</small>
            </span>
            <span class="input-tile__state">{{ audio.capturing ? '采集中' : audio.asset ? '已采集' : '待采集' }}</span>
          </button>

          <div class="input-tile input-tile--static">
            <span class="input-tile__icon">
              <el-icon><Tools /></el-icon>
            </span>
            <span class="input-tile__body">
              <strong>检测升降</strong>
              <small>通过设备命令调整检测位姿</small>
            </span>
            <span class="input-tile__actions">
              <el-tooltip content="升起检测台" placement="top">
                <el-button
                  circle
                  size="small"
                  :icon="Top"
                  :loading="liftBusy === 'up'"
                  :disabled="Boolean(liftBusy)"
                  @click="handleLift('up')"
                />
              </el-tooltip>
              <el-tooltip content="下降检测台" placement="top">
                <el-button
                  circle
                  size="small"
                  :icon="Bottom"
                  :loading="liftBusy === 'down'"
                  :disabled="Boolean(liftBusy)"
                  @click="handleLift('down')"
                />
              </el-tooltip>
              <el-tooltip content="停止升降" placement="top">
                <el-button
                  circle
                  size="small"
                  type="danger"
                  :icon="VideoPause"
                  :loading="liftBusy === 'stop'"
                  :disabled="Boolean(liftBusy)"
                  @click="handleLift('stop')"
                />
              </el-tooltip>
            </span>
          </div>
        </div>
      </el-card>

      <!-- 02 / CONFIGURATION：运行环境、模型与本次检测参数 -->
      <el-card class="panel" shadow="never">
        <template #header>
          <div class="panel-head">
            <div class="panel-head__title">
              <span class="eyebrow">02 / CONFIGURATION</span>
              <h2>运行配置</h2>
            </div>
            <div class="panel-head__meta">
              <el-button
                text
                circle
                :icon="Refresh"
                :loading="runtimeLoading"
                title="重新读取运行配置"
                @click="loadRuntimeConfig"
              />
            </div>
          </div>
        </template>

        <el-form label-position="top" class="config-form">
          <el-form-item label="虚拟环境">
            <el-select
              v-model="form.environment"
              class="config-control"
              :disabled="isRunning || !runtime.environments.length"
              :loading="runtimeLoading"
              :placeholder="environmentPlaceholder"
            >
              <el-option
                v-for="item in runtime.environments"
                :key="item.value"
                :label="item.label"
                :value="item.value"
              />
            </el-select>
            <p class="field-hint">{{ environmentHint }}</p>
            <p v-if="platformHint" class="field-hint">平台：{{ platformHint }}</p>
          </el-form-item>

          <el-form-item label="模型权重">
            <el-input class="config-control" :model-value="runtime.modelPath" readonly placeholder="后端未返回模型权重路径">
              <template #suffix><el-icon><FolderOpened /></el-icon></template>
            </el-input>
          </el-form-item>

          <el-form-item label="配置文件">
            <el-input class="config-control" :model-value="runtime.configPath" readonly placeholder="后端未返回配置文件路径">
              <template #suffix><el-icon><FolderOpened /></el-icon></template>
            </el-input>
          </el-form-item>

          <el-form-item label="结果保存目录">
            <el-input class="config-control" :model-value="runtime.resultPath" readonly placeholder="后端未返回结果目录">
              <template #suffix><el-icon><FolderOpened /></el-icon></template>
            </el-input>
            <p class="field-hint">结果图由巡检服务登记后通过证据图片接口提供</p>
          </el-form-item>

          <el-form-item label="运行时长（秒）">
            <el-input-number
              v-model="form.durationSeconds"
              :min="0"
              :step="1"
              :disabled="isRunning"
            />
            <p class="field-hint">0 表示持续运行，直到手动停止</p>
          </el-form-item>

          <div class="config-actions">
            <el-button
              type="primary"
              size="large"
              class="config-actions__primary"
              :icon="VideoPlay"
              :loading="busy === 'start'"
              :disabled="isRunning || restoring || !selectedCameras.length"
              @click="startDetection"
            >
              {{ restoring ? '恢复任务中…' : '开始检测' }}
            </el-button>
            <el-button
              type="danger"
              size="large"
              :icon="VideoPause"
              :loading="busy === 'stop'"
              :disabled="!isRunning"
              @click="stopDetection"
            >
              停止
            </el-button>
          </div>
        </el-form>
      </el-card>
    </div>

    <!-- 03 / RESULTS：任务统计、标注图预览和阳性检测记录 -->
    <el-card class="panel" shadow="never">
      <template #header>
        <div class="panel-head">
          <div class="panel-head__title">
            <span class="eyebrow">03 / RESULTS</span>
            <h2>检测结果</h2>
          </div>
          <div class="panel-head__meta">
            <div v-if="task.taskRunId" class="task-summary">
              <el-tag :type="stateTag" effect="light" size="small">{{ stateLabel }}</el-tag>
              <span>{{ modeLabel }} · {{ task.processed }} 帧 · {{ task.positive }} 阳性帧</span>
              <el-tag type="info" effect="plain" size="small">{{ task.taskRunId }}</el-tag>
            </div>
            <el-button
              :icon="Picture"
              :loading="resultsLoading"
              :disabled="!task.taskRunId"
              @click="loadResults()"
            >
              加载结果图
            </el-button>
          </div>
        </div>
      </template>

      <el-alert
        v-if="task.error"
        class="results-alert"
        type="error"
        show-icon
        :closable="false"
        :title="`巡检任务失败：${task.error}`"
      />
      <el-alert
        v-if="cameraErrorList.length"
        class="results-alert"
        type="warning"
        show-icon
        :closable="false"
        :title="`通道异常：${cameraErrorList.join('；')}`"
      />
      <el-alert
        v-if="resultsError"
        class="results-alert"
        type="error"
        show-icon
        :closable="false"
        :title="resultsError"
      />

      <div class="results-layout">
        <div class="result-preview">
          <el-image
            v-if="previewSrc"
            class="result-preview__image"
            :src="previewSrc"
            fit="contain"
            :preview-src-list="previewList"
            :initial-index="0"
            hide-on-click-modal
          >
            <template #error>
              <el-empty description="证据图片读取失败" :image-size="72" />
            </template>
          </el-image>
          <el-empty v-else :image-size="96" :description="previewEmptyText" />

          <div v-if="detections.length > 1" class="result-preview__nav">
            <el-button circle size="small" :icon="ArrowLeft" title="上一条" @click="moveResult(-1)" />
            <span>{{ resultIndex + 1 }} / {{ detections.length }}</span>
            <el-button circle size="small" :icon="ArrowRight" title="下一条" @click="moveResult(1)" />
          </div>
        </div>

        <div class="result-detail">
          <el-descriptions v-if="currentResult" :column="1" border size="small">
            <el-descriptions-item label="摄像头">{{ currentResult.cameraId || '—' }}</el-descriptions-item>
            <el-descriptions-item label="帧编号">{{ currentResult.frameId ?? '—' }}</el-descriptions-item>
            <el-descriptions-item label="检测时间">{{ formatTime(currentResult.capturedAt) }}</el-descriptions-item>
            <el-descriptions-item label="推理耗时">
              {{ currentResult.latencyMs != null ? `${currentResult.latencyMs} ms` : '—' }}
            </el-descriptions-item>
            <el-descriptions-item label="检出目标">
              <template v-if="currentLabels.length">
                <el-tag
                  v-for="label in currentLabels"
                  :key="label"
                  class="label-tag"
                  type="danger"
                  effect="light"
                  size="small"
                >
                  {{ label }}
                </el-tag>
              </template>
              <span v-else>—</span>
            </el-descriptions-item>
            <el-descriptions-item label="标注图编号">{{ currentResult.resultImageId || '—' }}</el-descriptions-item>
            <el-descriptions-item label="原图编号">{{ currentResult.originalImageId || '—' }}</el-descriptions-item>
          </el-descriptions>
          <el-empty v-else :image-size="72" description="结果记录将在巡检服务返回后显示" />
        </div>
      </div>

      <div v-if="detections.length" class="result-strip">
        <el-scrollbar>
          <div class="result-strip__track">
            <button
              v-for="(item, index) in detections"
              :key="item.detectionId || `${item.cameraId}-${item.frameId}-${index}`"
              type="button"
              class="result-thumb"
              :class="{ 'is-active': index === resultIndex }"
              @click="selectResult(index)"
            >
              <img
                v-if="thumbnailUrl(item)"
                class="result-thumb__image"
                :src="thumbnailUrl(item)"
                :alt="`结果图 ${index + 1}`"
                loading="lazy"
              />
              <span v-else class="result-thumb__image result-thumb__image--empty">
                <el-icon><Picture /></el-icon>
              </span>
              <span class="result-thumb__meta">
                <strong>{{ item.cameraId || '—' }}</strong>
                <small>#{{ item.frameId ?? '—' }}</small>
              </span>
            </button>
          </div>
        </el-scrollbar>
        <div v-if="resultsMore" class="result-strip__more">
          <el-button text type="primary" :loading="resultsLoading" @click="loadResults({ append: true })">
            加载更多（已显示 {{ detections.length }} / {{ resultsTotal }} 条）
          </el-button>
        </div>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.detection-view {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.panel-row {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}

.panel :deep(.el-card__header) {
  padding: 14px 20px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.panel :deep(.el-card__body) {
  padding: 20px;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.panel-head__title h2 {
  margin: 4px 0 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  letter-spacing: 0;
}

.eyebrow {
  display: block;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .12em;
  color: var(--el-text-color-secondary);
}

.panel-head__meta {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.task-summary {
  display: flex;
  align-items: center;
  gap: 10px;
}

.camera-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.input-tile {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 58px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-base);
  background: var(--el-fill-color-blank);
  color: var(--el-text-color-regular);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color .2s, background-color .2s, color .2s;
}

.input-tile:hover:not(:disabled) {
  border-color: var(--el-color-primary-light-5);
  color: var(--el-color-primary);
}

.input-tile:focus-visible {
  outline: 2px solid var(--el-color-primary-light-5);
  outline-offset: 1px;
}

.input-tile.is-active {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.input-tile:disabled {
  cursor: not-allowed;
  opacity: .6;
}

.input-tile--static {
  cursor: default;
}

.input-tile--static:hover {
  border-color: var(--el-border-color);
  color: var(--el-text-color-regular);
}

.input-tile__icon {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  border-radius: var(--el-border-radius-base);
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
  font-size: 17px;
}

.input-tile.is-active .input-tile__icon {
  background: var(--el-color-primary-light-8);
  color: var(--el-color-primary);
}

.input-tile__body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.input-tile__body strong {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.input-tile.is-active .input-tile__body strong {
  color: var(--el-color-primary);
}

.input-tile__body small {
  margin-top: 2px;
  overflow: hidden;
  color: var(--el-text-color-secondary);
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.input-tile__state {
  flex: 0 0 auto;
  color: var(--el-text-color-placeholder);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .08em;
}

.input-tile.is-active .input-tile__state {
  color: var(--el-color-primary);
}

.input-tile__actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.media-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
  margin-top: 12px;
}

.config-form :deep(.el-form-item) {
  margin-bottom: 16px;
}

.config-form :deep(.el-form-item__label) {
  padding-bottom: 4px;
  color: var(--el-text-color-regular);
  font-size: 13px;
  line-height: 1.4;
}

.config-form :deep(.el-form-item__content) {
  display: block;
  line-height: 1.5;
}

.config-control {
  width: 100%;
}

.field-hint {
  margin-top: 4px;
  color: var(--el-text-color-secondary);
  font-size: 11px;
  line-height: 1.5;
}

.config-actions {
  display: flex;
  gap: 12px;
  margin-top: 20px;
}

.config-actions__primary {
  flex: 1;
}

.results-alert {
  margin-bottom: 16px;
}

.results-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
  gap: 20px;
}

.result-preview {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 320px;
  padding: 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
  background: var(--el-fill-color-lighter);
}

.result-preview__image {
  width: 100%;
  height: 100%;
  min-height: 280px;
}

.result-preview__nav {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.result-detail {
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
}

.result-detail :deep(.el-descriptions__label) {
  width: 92px;
  color: var(--el-text-color-secondary);
}

.result-detail :deep(.el-descriptions__content) {
  word-break: break-all;
}

.label-tag + .label-tag {
  margin-left: 6px;
}

.result-strip {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--el-border-color-lighter);
}

.result-strip__track {
  display: flex;
  gap: 12px;
  padding-bottom: 4px;
}

.result-thumb {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 132px;
  flex: 0 0 132px;
  padding: 6px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-base);
  background: var(--el-fill-color-blank);
  color: var(--el-text-color-regular);
  font: inherit;
  cursor: pointer;
  transition: border-color .2s, box-shadow .2s;
}

.result-thumb:hover {
  border-color: var(--el-color-primary-light-5);
}

.result-thumb.is-active {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 2px var(--el-color-primary-light-8);
}

.result-thumb__image {
  width: 100%;
  height: 74px;
  object-fit: cover;
  border-radius: 2px;
  background: var(--el-fill-color-light);
}

.result-thumb__image--empty {
  display: grid;
  place-items: center;
  color: var(--el-text-color-placeholder);
  font-size: 20px;
}

.result-thumb__meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  font-size: 11px;
}

.result-thumb__meta strong {
  color: var(--el-text-color-primary);
  font-weight: 600;
}

.result-thumb__meta small {
  color: var(--el-text-color-secondary);
}

.result-strip__more {
  margin-top: 6px;
  text-align: center;
}

.is-spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 1200px) {
  .panel-row,
  .results-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 720px) {
  .camera-grid,
  .media-row {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
