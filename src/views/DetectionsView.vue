<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { FolderOpened, Microphone, VideoPlay, VideoPause, Top, Bottom } from '@element-plus/icons-vue'
import PageHeader from '@/components/PageHeader.vue'
import InspectionPreview from '@/components/InspectionPreview.vue'
import { listCameras } from '@/api/cameras'
import { unwrap, apiErrorMessage } from '@/api/envelope'
import { captureMedia, getInspectionConfig, getInspectionStatus, getInspectionStatusUrl,
  startInspection, stopInspection, moveInspectionLift, stopInspectionLift,
  openInspectionFolder } from '@/api/inspection'
import { listMediaAssets, loadAudioUrl, downloadMediaAsset } from '@/api/media'
import { openLocalFolder } from '@/utils/localFolder'

// 与后端冻结参数一致（44.1kHz / 单声道 / 10 秒）：前端只负责触发，不下发参数覆盖。
const AUDIO_DURATION = 10

const TASK_KEY = 'inspection-robot.active-inspection'
const SELECTION_KEY = 'inspection-robot.selected-cameras'
const cameras = ref(Array.from({ length: 8 }, (_, index) => ({ id: 'cam' + String(index + 1).padStart(2, '0'), label: '摄像头 ' + (index + 1) })))
const selected = ref(['cam01'])
const form = reactive({ taskName: '实时检测', durationSeconds: 0 })
const runtime = ref({})
const task = ref({ state: 'idle', cameraIds: [] })
const busy = ref('')
const restoring = ref(true)
const statusError = ref('')
const audioBusy = ref(false)
const audioVisible = ref(false)
const audioAssets = ref([])
const audioLoading = ref(false)
const audioError = ref('')
const audioPlaying = ref('') // 正在加载/播放的 assetId
const audioUrl = ref('')    // 当前 <audio> 的 object URL
const audioRef = ref(null)  // <audio> 元素
const audioTotal = ref(0)
const liftBusy = ref('')
const openingFolder = ref(false)
const active = computed(() => ['starting', 'running', 'stopping'].includes(task.value.state))
const stateLabel = computed(() => ({ idle: '等待启动', starting: '启动中', running: '检测进行中', stopping: '正在收尾（写盘有超时保护）', stopped: '已停止', completed: '已完成', failed: '失败' }[task.value.state] || task.value.state))
const previewIds = computed(() => active.value ? task.value.cameraIds || [] : [])
// 后端只在 cameraErrors 里放真实故障（拒绝连接/鉴权失败/路径不存在）；
// 同一路摄像头的主、子码流合并成一行，避免 4 路就刷出 8 条黄条。
const errors = computed(() => {
  const grouped = {}
  for (const [key, message] of Object.entries(task.value.cameraErrors || {})) {
    const [cameraId, kind] = String(key).split('/')
    const line = kind === 'main' ? `主码流 ${message}` : kind === 'sub' ? `子码流 ${message}` : message
    grouped[cameraId] = grouped[cameraId] ? `${grouped[cameraId]}；${line}` : line
  }
  return Object.entries(grouped).map(([id, message]) => id + '：' + message)
})
// "还没收到数据"不是故障：启动阶段只显示一条建连进度，运行中断流才提示重连。
const streamHint = computed(() => {
  const waiting = Object.entries(task.value.cameraWaiting || {})
  if (!waiting.length) return ''
  const cameraIds = rows => [...new Set(rows.map(([key]) => String(key).split('/')[0]))]
  if (task.value.state === 'starting') {
    const ready = Number(task.value.cameraReady) || 0
    const total = Number(task.value.cameraTotal) || 0
    const progress = total ? `${ready}/${total} 路已就绪` : '等待首个关键帧'
    return `正在连接码流：${progress}，首次建连通常需要几秒（${cameraIds(waiting).join('、')}）`
  }
  if (task.value.state === 'running') {
    // 2s 抖动很常见，运行中持续 3s 以上才值得提示，否则文案会一闪一闪。
    const stalled = waiting.filter(([, value]) => (Number(value) || 0) >= 3)
    if (!stalled.length) return ''
    const seconds = Math.max(...stalled.map(([, value]) => Number(value) || 0))
    return `${cameraIds(stalled).join('、')} 码流中断，正在重连（已 ${seconds.toFixed(1)}s）`
  }
  return ''
})
// 被摘掉的路（启动超时/断流/连续推理失败）：单独成一组提示，与"还在连"区分开。
const disabledAlerts = computed(() => Object.entries(task.value.cameraDisabled || {})
  .map(([cameraId, reason]) => `${cameraId} 已停用：${reason}`))
// 每路指标直接取自后端 camera_stats，多路排障看数字即可。
const cameraRows = computed(() => {
  const stats = task.value.cameraStats || {}
  const disabled = task.value.cameraDisabled || {}
  return Object.entries(stats).map(([cameraId, item]) => {
    const sub = item.sub || {}
    const main = item.main || {}
    return {
      cameraId,
      state: disabled[cameraId] ? 'down' : (item.state || 'waiting'),
      processed: Number(item.processed) || 0,
      dropped: Number(item.overwrittenFrames) || 0,
      stale: Number(item.staleFrames) || 0,
      decodeErrors: Number(sub.decodeErrors) || 0,
      packets: Number(main.packets) || 0,
      sessions: Number(main.sessions) || 0,
      note: disabled[cameraId] || ''
    }
  })
})
const cameraStateMeta = state => ({
  live: { label: '正常', type: 'success' },
  waiting: { label: '连接中', type: 'info' },
  down: { label: '已停用', type: 'danger' }
}[state] || { label: state || '未知', type: 'info' })
// 状态同步：优先用 /ws/inspections/{id} 推送（同一份 status），
// 只有推送连不上或反复断开时才退回 2s 轮询，避免推送抖动时丢掉状态更新。
const STATUS_WS_MAX_FAILURES = 3
const STATUS_POLL_INTERVAL = 2000
let disposed = false
let polling = false
let statusSocket = null
let statusTaskId = ''
let statusFailures = 0
let statusRetryTimer = null
let pollTimer = null
let statusWatchdog = null

function remember() {
  try {
    localStorage.setItem(TASK_KEY, JSON.stringify({ taskRunId: task.value.taskRunId }))
    localStorage.setItem(SELECTION_KEY, JSON.stringify(selected.value))
  } catch { /* 存储不可用不影响任务 */ }
}
function applyStatus(value) {
  task.value = { ...task.value, ...value }
  remember()
}
async function poll() {
  if (polling || disposed || !task.value.taskRunId) return
  polling = true
  const id = task.value.taskRunId
  try {
    const value = unwrap(await getInspectionStatus(id), {})
    if (disposed || id !== task.value.taskRunId) return
    applyStatus(value)
    statusError.value = ''
  } catch (error) {
    if (disposed) return
    if (error?.response?.status === 404) {
      task.value = { state: 'idle', cameraIds: [] }
      localStorage.removeItem(TASK_KEY)
      statusError.value = ''
    } else statusError.value = apiErrorMessage(error, '任务状态读取失败，正在重试')
  } finally { polling = false }
}

function closeStatusSocket() {
  if (!statusSocket) return
  const current = statusSocket
  statusSocket = null
  current.onopen = null
  current.onmessage = null
  current.onerror = null
  current.onclose = null
  try { current.close() } catch { /* 已关闭 */ }
}

function stopPolling() {
  if (pollTimer) window.clearInterval(pollTimer)
  pollTimer = null
}

function startPolling() {
  if (pollTimer || disposed) return
  pollTimer = window.setInterval(() => { if (active.value || statusError.value) poll() }, STATUS_POLL_INTERVAL)
}

function scheduleStatusReconnect() {
  if (disposed || statusRetryTimer) return
  const delay = Math.min(1000 * (2 ** statusFailures), 10000)
  statusRetryTimer = window.setTimeout(() => {
    statusRetryTimer = null
    openStatusSocket()
  }, delay)
}

function openStatusSocket() {
  const id = task.value.taskRunId
  if (disposed || !id) return
  if (typeof WebSocket === 'undefined') { startPolling(); return }
  closeStatusSocket()
  let socket
  try { socket = new WebSocket(getInspectionStatusUrl(id)) } catch { statusFailures += 1; startPolling(); return }
  statusSocket = socket
  socket.onopen = () => {
    statusFailures = 0
    stopPolling()          // 推送已就位，不必再轮询
  }
  socket.onmessage = event => {
    let payload
    try { payload = JSON.parse(event.data) } catch { return }
    // 只认状态帧：hub 也会推错误/停止之类的事件，不能当成 status 写进页面。
    const data = payload?.data ?? payload
    const status = data?.status ?? data
    if (!status || typeof status !== 'object' || !status.state) return
    if (id !== task.value.taskRunId) return
    applyStatus(status)
    statusError.value = ''
  }
  socket.onerror = () => {}
  socket.onclose = () => {
    if (statusSocket === socket) statusSocket = null
    if (disposed) return
    statusFailures += 1
    if (statusFailures >= STATUS_WS_MAX_FAILURES) { startPolling(); return }
    scheduleStatusReconnect()
  }
}

function openStatusChannel() {
  const id = task.value.taskRunId
  if (disposed || !id) return
  if (typeof WebSocket === 'undefined') { startPolling(); return }
  // 已经在订阅同一个任务就别重连（start() 与 active 监听都会调到这来）。
  if (statusSocket && statusTaskId === id) return
  statusTaskId = id
  statusFailures = 0
  openStatusSocket()
  // 兜底：推送 8s 内没有任何消息（例如中间代理掐断长连接）就主动探一次。
  if (!statusWatchdog) {
    statusWatchdog = window.setInterval(() => {
      if (disposed || !task.value.taskRunId) return
      if (statusSocket && statusSocket.readyState === WebSocket.OPEN) return
      startPolling()
    }, 8000)
  }
}

function stopStatusChannel() {
  closeStatusSocket()
  stopPolling()
  statusTaskId = ''
  if (statusRetryTimer) { window.clearTimeout(statusRetryTimer); statusRetryTimer = null }
  if (statusWatchdog) { window.clearInterval(statusWatchdog); statusWatchdog = null }
}
function chooseCount(count) { selected.value = cameras.value.slice(0, count).map(item => item.id) }
async function start() {
  if (active.value || busy.value || restoring.value) return
  if (!selected.value.length || selected.value.length > 8) return ElMessage.warning('请选择 1 至 8 路摄像头')
  if (!form.taskName.trim()) return ElMessage.warning('请输入任务名')
  busy.value = 'start'
  try {
    const value = unwrap(await startInspection({ taskName: form.taskName.trim(), cameraIds: selected.value,
      mode: ({ 1: 'single', 4: 'four', 8: 'eight' }[selected.value.length] || 'custom'),
      durationSeconds: form.durationSeconds }), {})
    if (!value.taskRunId) throw new Error('后端未返回任务编号')
    task.value = { state: 'starting', cameraIds: [...selected.value], ...value }
    remember()
    statusError.value = ''
    openStatusChannel()
    ElMessage.success('检测任务已启动')
  } catch (error) { ElMessage.error(apiErrorMessage(error, '检测启动失败')) }
  finally { busy.value = '' }
}
async function stop() {
  busy.value = 'stop'
  try { applyStatus(unwrap(await stopInspection(task.value.taskRunId), {})) }
  catch (error) { ElMessage.error(apiErrorMessage(error, '停止任务失败')) }
  finally { busy.value = '' }
}
// 没有进行中的任务时，本轮手动采集归到同一个「独立采集」编号，
// 让多次采集的音频证据能按组归档。
const standaloneRunId = ref('')
function evidenceRunId() {
  if (task.value.taskRunId) return task.value.taskRunId
  if (!standaloneRunId.value) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    standaloneRunId.value = `standalone-${stamp}`
  }
  return standaloneRunId.value
}
async function captureAudio() {
  audioBusy.value = true
  try {
    // 参数不随请求下发：44.1kHz/单声道/10s 已在后端配置冻结，前端只触发。
    const value = unwrap(await captureMedia({ taskRunId: evidenceRunId(),
      waypointId: 'inspection-audio', deviceId: 'audio', mediaType: 'audio' }), {})
    const quality = value?.qualityState || 'valid'
    if (quality === 'valid') ElMessage.success(`录音完成（${AUDIO_DURATION} 秒）`)
    else if (quality === 'degraded') ElMessage.warning('录音完成，但电平异常（削波或中断），已标记 degraded')
    else ElMessage.warning('录音完成，但未采到有效声音，请检查麦克风')
    if (audioVisible.value) await refreshAudio()
  } catch (error) { ElMessage.error(apiErrorMessage(error, '音频采集失败')) }
  finally { audioBusy.value = false }
}
async function refreshAudio() {
  audioLoading.value = true
  audioError.value = ''
  try {
    const value = unwrap(await listMediaAssets({ mediaType: 'audio', limit: 20 }), {})
    audioAssets.value = value.items || []
    audioTotal.value = value.total || audioAssets.value.length
  } catch (error) { audioError.value = apiErrorMessage(error, '录音列表读取失败') }
  finally { audioLoading.value = false }
}
function openAudioPanel() {
  audioVisible.value = true
  refreshAudio()
}
async function playAudio(asset) {
  // <audio> 的 src 请求不带登录态，统一先以 blob 拉取再交给播放器。
  if (audioUrl.value) { URL.revokeObjectURL(audioUrl.value); audioUrl.value = '' }
  audioPlaying.value = asset.assetId
  try {
    audioUrl.value = await loadAudioUrl(asset.assetId)
    if (audioRef.value) { audioRef.value.src = audioUrl.value; audioRef.value.play() }
  } catch (error) { ElMessage.error(apiErrorMessage(error, '录音加载失败')) }
  finally { audioPlaying.value = '' }
}
async function saveAudio(asset) {
  try { await downloadMediaAsset(asset.assetId) }
  catch (error) { ElMessage.error(apiErrorMessage(error, '录音下载失败')) }
}
function qualityTag(state) {
  return { valid: 'success', degraded: 'warning', invalid: 'danger' }[state] || 'info'
}
function qualityLabel(state) {
  return { valid: '正常', degraded: '电平异常', invalid: '无效' }[state] || state
}
async function lift(action) {
  liftBusy.value = action
  try { await (action === 'stop' ? stopInspectionLift() : moveInspectionLift(action)) }
  catch (error) { ElMessage.error(apiErrorMessage(error, '升降指令失败')) }
  finally { liftBusy.value = '' }
}
async function openResults() {
  if (openingFolder.value || !task.value.taskRunId) return
  openingFolder.value = true
  try {
    const result = unwrap(await openInspectionFolder(task.value.taskRunId), {})
    if (result.opened) {
      ElMessage.success(`已打开检测结果目录：${result.dir}`)
      return
    }
    // 与球形摄像页面一致：服务端无桌面会话时尝试本机打开，并复制目录。
    const target = String(result.dir || '').trim()
    if (!target) throw new Error('后端未返回本次任务目录')
    const { opened, copied } = await openLocalFolder(target)
    ElMessage({
      type: opened ? 'success' : 'warning',
      message: opened
        ? `已请求打开检测结果目录：${target}${copied ? '；若浏览器拦截，路径已复制' : ''}`
        : copied ? `无法直接打开系统文件夹，路径已复制，请粘贴到资源管理器地址栏：${target}`
          : `无法直接打开系统文件夹，请手动打开：${target}`,
      duration: 8000
    })
  } catch (error) { ElMessage.error(apiErrorMessage(error, '打开检测结果目录失败')) }
  finally { openingFolder.value = false }
}
// 任务进入终态后 3s 关掉推送：再留着只是让 worker 每 500ms 白跑一次 IPC。
watch(active, (value, previous) => {
  if (value) openStatusChannel()
  else if (previous) window.setTimeout(() => { if (!active.value && !disposed) stopStatusChannel() }, 3000)
})

onMounted(async () => {
  try {
    const saved = JSON.parse(localStorage.getItem(SELECTION_KEY) || 'null')
    if (Array.isArray(saved) && saved.length) selected.value = saved
    const previous = JSON.parse(localStorage.getItem(TASK_KEY) || 'null')
    if (previous?.taskRunId) {
      task.value.taskRunId = previous.taskRunId
      await poll()
    }
  } catch { /* 无效缓存忽略 */ }
  try {
    const value = unwrap(await listCameras(), {})
    const rows = (value.cameras || []).filter(item => item.kind === 'inspection' && item.enabled !== false)
    if (rows.length) {
      cameras.value = rows
      selected.value = selected.value.filter(id => rows.some(item => item.id === id))
    }
  } catch { /* 默认八路目录 */ }
  try { runtime.value = unwrap(await getInspectionConfig({ configType: 'inspection' }), {}) }
  catch { /* 任务实际配置由后端校验 */ }
  if (disposed) return
  restoring.value = false
  // 先取一次完整状态，再订阅推送：刷新页面后能立刻看到当前进度。
  if (task.value.taskRunId) openStatusChannel()
})
onBeforeUnmount(() => {
  disposed = true
  stopStatusChannel()
  if (audioUrl.value) URL.revokeObjectURL(audioUrl.value)
})
</script>

<template>
  <div class="detection-page">
    <PageHeader title="实时检测" description="多路摄像头实时检测、预览与录像" />
    <div class="setup-grid">
      <el-card shadow="never">
        <template #header><h2>摄像头与音频</h2></template>
        <div class="selection-actions">
          <el-button v-for="count in [1, 4, 8]" :key="count" :disabled="active || restoring" @click="chooseCount(count)">{{ count }} 路</el-button>
          <span>已选 {{ selected.length }} 路</span>
        </div>
        <el-checkbox-group v-model="selected" :disabled="active || restoring" class="camera-options">
          <el-checkbox v-for="camera in cameras" :key="camera.id" :value="camera.id" border>
            <span>{{ camera.label || camera.id }}</span><small v-if="camera.host">{{ camera.host }}</small>
          </el-checkbox>
        </el-checkbox-group>
        <div class="controls">
          <el-button :icon="Microphone" :loading="audioBusy" :disabled="restoring" @click="captureAudio">采集 {{ AUDIO_DURATION }} 秒音频</el-button>
          <el-button :disabled="restoring" @click="openAudioPanel">录音记录</el-button>
          <el-button :icon="Top" :loading="liftBusy === 'up'" :disabled="Boolean(liftBusy)" @click="lift('up')">升起</el-button>
          <el-button :icon="Bottom" :loading="liftBusy === 'down'" :disabled="Boolean(liftBusy)" @click="lift('down')">下降</el-button>
          <el-button type="danger" plain @click="lift('stop')">停止升降</el-button>
        </div>
      </el-card>
      <el-card shadow="never">
        <template #header><h2>运行配置</h2></template>
        <el-form label-position="top" :disabled="active || restoring">
          <el-form-item label="任务名"><el-input v-model="form.taskName" maxlength="80" show-word-limit /></el-form-item>
          <el-form-item label="运行时长（秒，0 表示持续运行）"><el-input-number v-model="form.durationSeconds" :min="0" :max="86400" /></el-form-item>
        </el-form>
        <p v-if="runtime.modelPath" class="config-note">
          模型：{{ runtime.modelPath }}<span v-if="runtime.modelDevice"> · 设备 {{ runtime.modelDevice }}</span>
          <el-tag v-if="runtime.modelPath && runtime.modelEnabled === false" size="small" type="warning" effect="plain">未启用</el-tag>
        </p>
        <p class="config-note">自动保存至 ./data/cams/日期时间-任务名/</p>
        <div class="controls">
          <el-button type="primary" :icon="VideoPlay" :loading="busy === 'start'" :disabled="active || restoring || Boolean(statusError)" @click="start">启动检测</el-button>
          <el-button :icon="VideoPause" :loading="busy === 'stop'" :disabled="!active || task.state === 'stopping'" @click="stop">停止检测</el-button>
          <el-tag :type="task.state === 'failed' ? 'danger' : active ? 'success' : 'info'">{{ stateLabel }}</el-tag>
        </div>
        <p v-if="task.taskRunId" class="config-note">{{ task.taskName || form.taskName }} · 已检测 {{ task.processed || 0 }} 帧 · 阳性 {{ task.positive || 0 }} 帧</p>
      </el-card>
    </div>
    <el-alert v-if="statusError" :title="statusError" type="warning" :closable="false" />
    <el-alert v-if="task.error" :title="task.error" type="error" :closable="false" />
    <el-alert v-if="streamHint" :title="streamHint" type="info" :closable="false" />
    <el-alert v-for="error in errors" :key="error" :title="error" type="warning" :closable="false" />
    <el-alert v-for="error in disabledAlerts" :key="error" :title="error" type="error" :closable="false" />
    <el-card v-if="cameraRows.length" shadow="never">
      <template #header><div class="results-header"><h2>每路状态</h2><span class="config-note">后端 camera_stats 实时值</span></div></template>
      <el-table :data="cameraRows" size="small">
        <el-table-column prop="cameraId" label="相机" width="90" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }"><el-tag size="small" :type="cameraStateMeta(row.state).type">{{ cameraStateMeta(row.state).label }}</el-tag></template>
        </el-table-column>
        <el-table-column prop="processed" label="已检测" width="80" />
        <el-table-column prop="dropped" label="丢帧(覆盖)" width="100" />
        <el-table-column prop="stale" label="过期帧" width="80" />
        <el-table-column prop="decodeErrors" label="解码错误" width="90" />
        <el-table-column prop="packets" label="主码流收包" width="100" />
        <el-table-column prop="sessions" label="重连" width="70" />
        <el-table-column prop="note" label="说明" min-width="180" show-overflow-tooltip />
      </el-table>
    </el-card>
    <el-card shadow="never" class="results-card">
      <template #header>
        <div class="results-header"><h2>检测结果</h2><el-button :icon="FolderOpened" :loading="openingFolder" :disabled="!task.taskRunId" @click="openResults">打开检测结果</el-button></div>
      </template>
      <div v-if="previewIds.length" class="preview-grid" :class="{ single: previewIds.length === 1, eight: previewIds.length > 4 }">
        <InspectionPreview v-for="id in previewIds" :key="task.taskRunId + ':' + id" :task-run-id="task.taskRunId" :camera-id="id" />
      </div>
      <el-empty v-else :description="task.taskRunId ? '任务已结束，可打开本次任务文件夹查看录像与检测记录' : '启动检测后显示实时视频预览'" />
    </el-card>
    <el-dialog v-model="audioVisible" title="录音记录" width="min(720px, 94vw)">
      <el-alert v-if="audioError" :title="audioError" type="error" :closable="false" />
      <el-table v-loading="audioLoading" :data="audioAssets" size="small">
        <el-table-column label="时间" width="170"><template #default="{ row }">{{ (row.capturedAt || '').replace('T', ' ').slice(0, 19) }}</template></el-table-column>
        <el-table-column prop="fileName" label="文件" min-width="180" show-overflow-tooltip />
        <el-table-column label="大小" width="90"><template #default="{ row }">{{ ((row.sizeBytes || 0) / 1024).toFixed(0) }} KB</template></el-table-column>
        <el-table-column label="质量" width="100">
          <template #default="{ row }"><el-tag size="small" :type="qualityTag(row.qualityState)">{{ qualityLabel(row.qualityState) }}</el-tag></template>
        </el-table-column>
        <el-table-column label="操作" width="140">
          <template #default="{ row }">
            <el-button link type="primary" :loading="audioPlaying === row.assetId" @click="playAudio(row)">试听</el-button>
            <el-button link type="primary" @click="saveAudio(row)">下载</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="audio-player">
        <audio v-if="audioVisible" ref="audioRef" controls :src="audioUrl || undefined" style="width: 100%"></audio>
        <p v-else-if="!audioLoading && !audioAssets.length" class="config-note">暂无录音，点击「采集 {{ AUDIO_DURATION }} 秒音频」开始</p>
      </div>
      <template #footer>
        <el-button @click="refreshAudio">刷新</el-button>
        <el-button @click="audioVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.detection-page { display: flex; flex-direction: column; gap: 20px; }
h2 { margin: 0; font-size: 17px; font-weight: 600; }
.setup-grid { display: grid; grid-template-columns: 1.2fr 1fr; gap: 20px; }
.selection-actions, .controls, .results-header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.results-header { justify-content: space-between; }
.selection-actions { margin-bottom: 18px; }
.selection-actions span, .config-note { color: var(--el-text-color-secondary); font-size: 13px; overflow-wrap: anywhere; }
.camera-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-bottom: 24px; }
.camera-options :deep(.el-checkbox) { margin: 0; height: 56px; }
.camera-options small { display: block; margin-top: 4px; color: var(--el-text-color-secondary); }
.controls { margin-top: 18px; }
.controls :deep(.el-button + .el-button), .selection-actions :deep(.el-button + .el-button) { margin-left: 0; }
.preview-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.preview-grid.single { grid-template-columns: 1fr; }
.preview-grid.eight { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.audio-player { margin-top: 12px; }
@media (max-width: 1200px) { .preview-grid.eight { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 800px) { .setup-grid, .preview-grid, .preview-grid.eight { grid-template-columns: 1fr; } }
</style>
