<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { FolderOpened, Microphone, VideoPlay, VideoPause, Top, Bottom } from '@element-plus/icons-vue'
import PageHeader from '@/components/PageHeader.vue'
import InspectionPreview from '@/components/InspectionPreview.vue'
import { listCameras } from '@/api/cameras'
import { unwrap, apiErrorMessage } from '@/api/envelope'
import { captureMedia, getInspectionConfig, getInspectionStatus, startInspection, stopInspection,
  moveInspectionLift, stopInspectionLift, openInspectionFolder } from '@/api/inspection'
import { openLocalFolder } from '@/utils/localFolder'

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
const liftBusy = ref('')
const openingFolder = ref(false)
const active = computed(() => ['starting', 'running', 'stopping'].includes(task.value.state))
const stateLabel = computed(() => ({ idle: '等待启动', starting: '启动中', running: '检测进行中', stopping: '正在收尾', stopped: '已停止', completed: '已完成', failed: '失败' }[task.value.state] || task.value.state))
const previewIds = computed(() => active.value ? task.value.cameraIds || [] : [])
const errors = computed(() => Object.entries(task.value.cameraErrors || {}).map(([id, error]) => id + '：' + error))
let timer = null
let disposed = false
let polling = false

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
async function captureAudio() {
  audioBusy.value = true
  try {
    await captureMedia({ taskRunId: task.value.taskRunId || 'manual-' + Date.now(), waypointId: 'inspection-audio',
      deviceId: 'audio', mediaType: 'audio', parameters: { sample_rate: 16000, channels: 1, duration_seconds: 3 } })
    ElMessage.success('音频采集完成')
  } catch (error) { ElMessage.error(apiErrorMessage(error, '音频采集失败')) }
  finally { audioBusy.value = false }
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
  timer = window.setInterval(() => { if (active.value || statusError.value) poll() }, 2000)
})
onBeforeUnmount(() => { disposed = true; if (timer) window.clearInterval(timer) })
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
          <el-button :icon="Microphone" :loading="audioBusy" @click="captureAudio">采集 3 秒音频</el-button>
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
        <p v-if="runtime.modelPath" class="config-note">模型：{{ runtime.modelPath }}</p>
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
    <el-alert v-for="error in errors" :key="error" :title="error" type="warning" :closable="false" />
    <el-card shadow="never" class="results-card">
      <template #header>
        <div class="results-header"><h2>检测结果</h2><el-button :icon="FolderOpened" :loading="openingFolder" :disabled="!task.taskRunId" @click="openResults">打开检测结果</el-button></div>
      </template>
      <div v-if="previewIds.length" class="preview-grid" :class="{ single: previewIds.length === 1, eight: previewIds.length > 4 }">
        <InspectionPreview v-for="id in previewIds" :key="task.taskRunId + ':' + id" :task-run-id="task.taskRunId" :camera-id="id" />
      </div>
      <el-empty v-else :description="task.taskRunId ? '任务已结束，可打开本次任务文件夹查看录像与检测记录' : '启动检测后显示实时视频预览'" />
    </el-card>
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
@media (max-width: 1200px) { .preview-grid.eight { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 800px) { .setup-grid, .preview-grid, .preview-grid.eight { grid-template-columns: 1fr; } }
</style>
