<script setup>
// 手动采集：不依赖巡检任务，推着机器人随手录多路视频。
//
// 复用现有的 POST /api/v1/inspections —— 它本来就支持「任选相机子集 + 时长(0=手动) +
// 是否推理」，只是一直被叫作"智能检测"并且不显示产物路径。这里把它做成"采集"语义：
// 开始/停止、看进度、看路径、预览、下载。
//
// 声音采集当前不可用：后端只有 /media/captures 的单次 10 s 录音，没有时长可控的连续录音
// 入口（那套逻辑写死在 mission_runner 里）。与其做一个点了没用的开关，不如显式禁用并说明。
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { Refresh, VideoPause, VideoPlay } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import AsyncSection from '@/components/AsyncSection.vue'
import FileList from '@/components/FileList.vue'
import MediaPreviewDialog from '@/components/MediaPreviewDialog.vue'
import PathCard from '@/components/PathCard.vue'
import {
  fetchInspectionFileBlob, fetchPreviewBlob, getInspectionStatus,
  openInspectionFolder, startInspection, stopInspection
} from '@/api/inspection'
import { listCameras } from '@/api/cameras'
import { unwrap } from '@/api/envelope'
import { useActiveInspection } from '@/composables/useActiveInspection'
import { useAsyncData } from '@/composables/useAsyncData'
import { getErrorMessage } from '@/utils/request'

const DURATION_PRESETS = [1, 5, 10, 30]
const POLL_INTERVAL = 2000

const media = ref('video')                       // 目前只有 video 可用
const selected = ref([])
const pipeline = ref('passthrough')              // 采集默认不推理：先省 CPU
const durationMode = ref('manual')               // preset / custom / manual
const presetMinutes = ref(5)
const customMinutes = ref(15)
const taskName = ref('手动采集')

const task = ref(null)                           // 当前任务状态（自己的或别人正在跑的）
const busy = ref('')                             // '' | start | stop
const statusError = ref('')
const preview = reactive({ visible: false, title: '', kind: 'video', loader: null })

const active = useActiveInspection()

let pollTimer = null
let tickTimer = null
const now = ref(Date.now())

// 相机清单来自后端目录，不写死 8 路；接口不可用时回退内置编号。
const { data: cameraRows, loading: camerasLoading, error: camerasError, load: loadCameras } = useAsyncData(
  async () => {
    try {
      const body = unwrap(await listCameras(), {}) || {}
      const rows = (body.cameras || []).filter((item) => item.enabled !== false)
      return rows.length ? rows : []
    } catch {
      return []
    }
  },
  { initialData: [] }
)

const cameraOptions = computed(() => {
  const rows = cameraRows.value || []
  if (rows.length) {
    return rows.map((item) => ({
      value: item.id,
      label: item.label || item.id,
      // kind = ptz 是球形相机，不参与多路采集（字段来自 app/common/cameras.py:as_dict）
      disabled: item.kind === 'ptz'
    }))
  }
  return Array.from({ length: 8 }, (_, index) => {
    const id = `cam${String(index + 1).padStart(2, '0')}`
    return { value: id, label: `通道 ${index + 1}（${id}）`, disabled: false }
  })
})

const isMine = computed(() => Boolean(task.value?.taskRunId))
const taskState = computed(() => String(task.value?.state || 'idle'))

const stateText = computed(() => ({
  idle: '未开始',
  starting: '正在启动',
  running: '采集中',
  stopping: '正在收尾',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止'
}[taskState.value] || taskState.value))

const stateType = computed(() => ({
  starting: 'info',
  running: 'success',
  stopping: 'warning',
  completed: 'success',
  failed: 'danger',
  stopped: 'info',
  idle: 'info'
}[taskState.value] || 'info'))

const running = computed(() => ['starting', 'running', 'stopping'].includes(taskState.value))

// 另一个入口（智能检测）占了唯一的任务槽位时，这里必须禁用而不是让用户点了报错。
const blockedByOther = computed(() => active.busy.value && active.taskRunId.value !== (task.value?.taskRunId || ''))

const durationSeconds = computed(() => {
  if (durationMode.value === 'manual') return 0
  const minutes = durationMode.value === 'preset' ? presetMinutes.value : Number(customMinutes.value)
  return Math.max(0, Math.round((Number(minutes) || 0) * 60))
})

// 终态时刻（毫秒）：任务结束后用它把已用时长钉住。
// 之前只有每秒刷新的 now，结束采集后定时器没停，时长会一直往上涨。
const frozenAt = ref(null)

function toMillis(value) {
  if (value === undefined || value === null || value === '') return null
  const ms = typeof value === 'number' ? value * 1000 : Date.parse(String(value))
  return Number.isFinite(ms) ? ms : null
}

const elapsedText = computed(() => {
  const started = toMillis(task.value?.startedAt)
  if (started === null) return '—'
  // 优先用后端 finishedAt 结算（引擎收尾时写入，精确）；没有就冻结在第一次看到终态的时刻。
  const end = toMillis(task.value?.finishedAt) ?? frozenAt.value ?? now.value
  const seconds = Math.max(0, Math.floor((end - started) / 1000))
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
  const ss = String(seconds % 60).padStart(2, '0')
  return `${mm}:${ss}`
})

// 每路状态：live / waiting / down，来自后端 cameraStats / cameraDisabled
const cameraStates = computed(() => {
  const stats = task.value?.cameraStats || {}
  const disabled = task.value?.cameraDisabled || {}
  const waiting = task.value?.cameraWaiting || {}
  return Object.keys(stats).map((key) => ({
    id: key,
    state: disabled[key] ? 'down' : waiting[key] ? 'waiting' : (stats[key]?.state || 'live'),
    reason: disabled[key] || ''
  }))
})

// 产物文件：后端只给相对路径（cameraFiles），大小要下载后才知道，这里不编造。
const files = computed(() => {
  const value = task.value?.cameraFiles || {}
  return Object.entries(value).map(([camera, item]) => ({
    path: item?.video || `${camera}/video.mkv`,
    label: `${camera} 录像`,
    kind: 'video'
  }))
})

const outputDir = computed(() => String(task.value?.outputDir || ''))

function startTicking() {
  stopTicking()
  tickTimer = window.setInterval(() => { now.value = Date.now() }, 1000)
}

function stopTicking() {
  if (tickTimer) window.clearInterval(tickTimer)
  tickTimer = null
}

async function refreshStatus(showError = false) {
  const id = task.value?.taskRunId
  if (!id) return
  try {
    task.value = unwrap(await getInspectionStatus(id), {}) || task.value
    statusError.value = ''
  } catch (reason) {
    statusError.value = getErrorMessage(reason, '读取任务状态失败')
    if (showError) ElMessage.error(statusError.value)
  }
}

function startPolling() {
  stopPolling()
  pollTimer = window.setInterval(async () => {
    if (document.hidden) return
    await refreshStatus()
    if (!running.value) {
      // 任务已经结束：停掉每秒刷新，并把已用时长钉在当前时刻（有 finishedAt 就以后端为准）。
      if (frozenAt.value === null) frozenAt.value = Date.now()
      stopPolling()
      stopTicking()
      active.refresh()
    }
  }, POLL_INTERVAL)
}

function stopPolling() {
  if (pollTimer) window.clearInterval(pollTimer)
  pollTimer = null
}

async function start() {
  if (!selected.value.length) {
    ElMessage.warning('请至少选择一个摄像头')
    return
  }
  if (blockedByOther.value) {
    ElMessage.warning(`已有任务在运行（${active.state.value}），请先在对应页面停止`)
    return
  }
  busy.value = 'start'
  try {
    const value = unwrap(await startInspection({
      taskName: taskName.value.trim() || '手动采集',
      cameraIds: [...selected.value],
      // mode 只是布局提示，真正生效的是 cameraIds
      mode: ({ 1: 'single', 4: 'four', 8: 'eight' }[selected.value.length] || 'custom'),
      durationSeconds: durationSeconds.value,
      pipeline: pipeline.value
    }), {})
    if (!value?.taskRunId) throw new Error('后端未返回任务编号')
    task.value = { state: 'starting', cameraIds: [...selected.value], ...value }
    frozenAt.value = null
    statusError.value = ''
    startTicking()
    startPolling()
    active.refresh()
    ElMessage.success(durationSeconds.value ? '采集已开始，到点自动结束' : '采集已开始，手动结束')
  } catch (error) {
    ElMessage.error(getErrorMessage(error, '开始采集失败'))
  } finally {
    busy.value = ''
  }
}

async function stop() {
  if (!task.value?.taskRunId) return
  try {
    await ElMessageBox.confirm(
      '结束采集会停止所有相机录制并收尾写盘，已录内容会保留。确认结束？',
      '结束采集',
      { type: 'warning', confirmButtonText: '结束采集', cancelButtonText: '继续采集' }
    )
  } catch {
    return
  }
  busy.value = 'stop'
  try {
    task.value = unwrap(await stopInspection(task.value.taskRunId), {}) || task.value
    ElMessage.info('已请求结束，正在收尾')
    // 收尾要关文件、写索引，给一点时间再读最终状态
    window.setTimeout(async () => {
      await refreshStatus()
      active.refresh()
    }, 1200)
  } catch (error) {
    ElMessage.error(getErrorMessage(error, '结束采集失败'))
  } finally {
    busy.value = ''
  }
}

async function openDir() {
  if (!task.value?.taskRunId) return
  try {
    const result = unwrap(await openInspectionFolder(task.value.taskRunId), {})
    if (result.opened) ElMessage.success(`已在机器人主机打开：${result.dir}`)
    else ElMessage.warning(result.detail || '机器人主机无法打开文件管理器，请改用「复制路径」')
  } catch (error) {
    ElMessage.error(getErrorMessage(error, '打开目录失败'))
  }
}

function download(file) {
  const id = task.value?.taskRunId
  if (!id) return
  fetchInspectionFileBlob(id, file.path)
    .then((blob) => {
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = String(file.path).split('/').pop() || 'download'
      link.click()
      URL.revokeObjectURL(url)
    })
    .catch((error) => ElMessage.error(getErrorMessage(error, '下载失败')))
}

function openPreview(file) {
  if (!outputDir.value) return
  const absolute = `${outputDir.value.replace(/\/$/, '')}/${file.path}`
  preview.title = file.label || file.path
  preview.kind = file.kind === 'audio' ? 'audio' : 'video'
  preview.loader = file.kind === 'video'
    ? () => fetchPreviewBlob(absolute)
    : () => fetchInspectionFileBlob(task.value.taskRunId, file.path)
  preview.visible = true
}

onMounted(async () => {
  await loadCameras()
  // 默认全选可用通道
  selected.value = cameraOptions.value.filter((item) => !item.disabled).map((item) => item.value)
  active.start()
  // 进入页面先接上正在跑的任务（可能是检测页启动的，也可能是刷新前启动的）
  await active.refresh()
  if (active.busy.value) {
    task.value = { ...active.task.value }
    startTicking()
    startPolling()
  }
})

onBeforeUnmount(() => {
  stopPolling()
  stopTicking()
})
</script>

<template>
  <div class="view">
    <PageHeader
      title="手动采集"
      description="推着机器人随手录，不依赖巡检任务；数据存到机器人本机"
      :status-text="stateText"
      :status-type="stateType"
    >
      <template #extra>
        <el-button :icon="Refresh" :loading="busy === 'refresh'" @click="refreshStatus(true)">刷新状态</el-button>
      </template>
    </PageHeader>

    <AsyncSection :loading="camerasLoading && !cameraOptions.length" :error="camerasError" loading-text="正在读取相机清单…" @retry="loadCameras">
      <el-alert
        v-if="blockedByOther"
        class="capture-alert"
        type="warning"
        :closable="false"
        show-icon
        :title="`已有任务在运行（${active.taskRunId.value} · ${active.state.value}）`"
        description="巡检域同时只能跑一个任务。请先在「智能检测」页停止它，再回到这里开始采集。"
      />

      <div class="capture-grid">
        <section class="view-panel">
          <div class="view-panel__head">
            <h2>采集配置</h2>
            <small>开始后不可修改，需要换参数先结束</small>
          </div>

          <el-form label-width="96px" :disabled="running">
            <el-form-item label="采集内容">
              <el-radio-group v-model="media">
                <el-radio value="video">视频</el-radio>
                <el-tooltip content="后端暂无时长可控的连续录音接口（当前只有单次 10 秒录音），该能力待后端补齐" placement="top">
                  <span class="disabled-option">
                    <el-radio value="both" disabled>声音 + 视频</el-radio>
                    <el-radio value="audio" disabled>仅声音</el-radio>
                  </span>
                </el-tooltip>
              </el-radio-group>
            </el-form-item>

            <el-form-item label="摄像头">
              <div class="camera-picker">
                <div class="camera-picker__actions">
                  <el-button text size="small" @click="selected = cameraOptions.filter((i) => !i.disabled).map((i) => i.value)">全选</el-button>
                  <el-button text size="small" @click="selected = []">清空</el-button>
                  <span class="text-muted">已选 {{ selected.length }} 路</span>
                </div>
                <el-checkbox-group v-model="selected" class="camera-picker__list">
                  <el-checkbox
                    v-for="item in cameraOptions"
                    :key="item.value"
                    :value="item.value"
                    :disabled="item.disabled"
                    border
                  >{{ item.label }}</el-checkbox>
                </el-checkbox-group>
              </div>
            </el-form-item>

            <el-form-item label="模型检测">
              <el-switch v-model="pipeline" active-value="inference" inactive-value="passthrough" />
              <span class="field-hint">{{ pipeline === 'inference' ? '边录边推理（占 CPU）' : '只录制不推理（推荐采集时使用）' }}</span>
            </el-form-item>

            <el-form-item label="采集时长">
              <el-radio-group v-model="durationMode">
                <el-radio value="preset">预设</el-radio>
                <el-radio value="custom">自定义</el-radio>
                <el-radio value="manual">不限（手动结束）</el-radio>
              </el-radio-group>
            </el-form-item>
            <el-form-item v-if="durationMode === 'preset'" label="选择">
              <el-radio-group v-model="presetMinutes">
                <el-radio-button v-for="item in DURATION_PRESETS" :key="item" :value="item">{{ item }} 分钟</el-radio-button>
              </el-radio-group>
            </el-form-item>
            <el-form-item v-if="durationMode === 'custom'" label="分钟数">
              <el-input-number v-model="customMinutes" :min="1" :max="120" />
              <span class="field-hint">到点后后端自动收尾</span>
            </el-form-item>

            <el-form-item label="任务名">
              <el-input v-model="taskName" maxlength="40" show-word-limit placeholder="例如 3号舍东侧噪声" />
            </el-form-item>

            <div class="capture-actions">
              <el-button
                type="primary"
                size="large"
                :icon="VideoPlay"
                :loading="busy === 'start'"
                :disabled="running || blockedByOther"
                @click="start"
              >开始采集</el-button>
              <el-button
                type="danger"
                size="large"
                plain
                :icon="VideoPause"
                :loading="busy === 'stop'"
                :disabled="!isMine || !running"
                @click="stop"
              >结束采集</el-button>
            </div>
          </el-form>
        </section>

        <section class="view-panel">
          <div class="view-panel__head">
            <h2>采集中</h2>
            <small>{{ isMine ? `任务 ${task.taskRunId}` : '当前没有进行中的采集' }}</small>
          </div>

          <div class="capture-stats">
            <div class="stat">
              <span class="stat__label">已用时长</span>
              <strong class="stat__value">{{ elapsedText }}</strong>
            </div>
            <div class="stat">
              <span class="stat__label">状态</span>
              <el-tag :type="stateType" effect="light" size="small">{{ stateText }}</el-tag>
            </div>
            <div class="stat">
              <span class="stat__label">相机</span>
              <strong class="stat__value">{{ task?.cameraCount ?? selected.length }} 路</strong>
            </div>
            <div class="stat">
              <span class="stat__label">推理</span>
              <strong class="stat__value">{{ task?.pipeline === 'inference' ? '开' : '关' }}</strong>
            </div>
          </div>

          <el-alert
            v-if="statusError"
            class="capture-alert"
            type="warning"
            :closable="false"
            show-icon
            :title="statusError"
          />

          <div v-if="cameraStates.length" class="camera-states">
            <el-tag
              v-for="item in cameraStates"
              :key="item.id"
              size="small"
              :type="item.state === 'live' ? 'success' : item.state === 'waiting' ? 'info' : 'danger'"
              effect="light"
            >{{ item.id }} · {{ item.state }}</el-tag>
          </div>

          <PathCard
            :path="outputDir"
            title="保存位置"
            hint="远程操作时请用「复制路径」，在机器人主机上打开的文件管理器你看不到"
            can-open
            @open="openDir"
          />

          <div class="view-panel__head files-head">
            <h2>产物文件</h2>
            <small>每路一个 MKV；预览由后端转封装成 MP4 后播放</small>
          </div>
          <FileList :files="files" empty-text="采集开始后这里会列出每路的录像文件" @preview="openPreview" @download="download" />
        </section>
      </div>
    </AsyncSection>

    <MediaPreviewDialog
      v-model="preview.visible"
      :title="preview.title"
      :kind="preview.kind"
      :loader="preview.loader"
    />
  </div>
</template>

<style scoped>
.capture-grid {
  display: grid;
  grid-template-columns: minmax(0, 420px) minmax(0, 1fr);
  gap: var(--app-gap);
  align-items: start;
}

.capture-alert {
  margin-bottom: var(--app-gap);
}

.camera-picker {
  width: 100%;
}

.camera-picker__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.camera-picker__list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 6px;
}

.camera-picker__list :deep(.el-checkbox) {
  margin-right: 0;
}

.field-hint {
  margin-left: 10px;
  color: var(--app-text-muted);
  font-size: 12px;
}

.disabled-option {
  display: inline-flex;
  gap: 8px;
  opacity: 0.55;
}

.capture-actions {
  display: flex;
  gap: 12px;
  padding-top: 4px;
}

.capture-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}

.stat {
  padding: 10px 12px;
  border: 1px solid var(--app-border);
  border-radius: 9px;
}

.stat__label {
  display: block;
  color: var(--app-text-muted);
  font-size: 12px;
  margin-bottom: 4px;
}

.stat__value {
  font-size: 18px;
  font-weight: 600;
}

.camera-states {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}

.files-head {
  margin-top: 12px;
}

@media (max-width: 1100px) {
  .capture-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
