<script setup>
// 手动采集：不依赖巡检任务，推着机器人随手录多路视频 / 声音。
//
// 两条链路合起来构成一次采集：
// - 视频：POST /api/v1/inspections（任选相机子集 + 时长 0=手动 + 是否推理）；
// - 声音：POST /api/v1/audio/recordings（真麦克风采集，写 <任务目录>/audio/session.wav）。
// 同处一个任务目录，前端只显示一个保存路径，文件清单里视频与音频并列。
//
// 起停顺序：先起视频拿到目录 → 再起音频（声音+视频）；停止时先停音频（WAV 要收尾写头）
// → 再停视频。音频起不来就立刻停掉视频并报错，不允许静默降级成"只录了画面"。
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { Refresh, VideoPause, VideoPlay } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import AsyncSection from '@/components/AsyncSection.vue'
import FileList from '@/components/FileList.vue'
import MediaPreviewDialog from '@/components/MediaPreviewDialog.vue'
import PathCard from '@/components/PathCard.vue'
import {
  fetchManagedFileBlob, fetchPreviewBlob, getInspectionStatus,
  openInspectionFolder, startInspection, stopInspection
} from '@/api/inspection'
import { getActiveAudioRecording, startAudioRecording, stopAudioRecording } from '@/api/audio'
import { listCameras } from '@/api/cameras'
import { unwrap } from '@/api/envelope'
import { useActiveInspection } from '@/composables/useActiveInspection'
import { useAsyncData } from '@/composables/useAsyncData'
import { getErrorMessage } from '@/utils/request'

const DURATION_PRESETS = [1, 5, 10, 30]
const POLL_INTERVAL = 2000

const media = ref('both')                        // video / both / audio
const selected = ref([])
const pipeline = ref('passthrough')              // 采集默认不推理：先省 CPU
const durationMode = ref('manual')               // preset / custom / manual
const presetMinutes = ref(5)
const customMinutes = ref(15)
const taskName = ref('手动采集')

const task = ref(null)                           // 视频任务状态（自己的或别人正在跑的）
const audio = ref(null)                          // 音频录制状态
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
const audioState = computed(() => String(audio.value?.state || 'idle'))
const audioRunning = computed(() => ['starting', 'recording', 'stopping'].includes(audioState.value))
const wantVideo = computed(() => media.value !== 'audio')
const wantAudio = computed(() => media.value !== 'video')

const stateText = computed(() => {
  if (audioRunning.value && !['starting', 'running', 'stopping'].includes(taskState.value)) {
    return audioState.value === 'recording' ? '录音中' : '正在启动录音'
  }
  return ({
    idle: '未开始',
    starting: '正在启动',
    running: '采集中',
    stopping: '正在收尾',
    completed: '已完成',
    failed: '失败',
    stopped: '已停止'
  }[taskState.value] || taskState.value)
})

const stateType = computed(() => ({
  starting: 'info',
  recording: 'success',
  running: 'success',
  stopping: 'warning',
  completed: 'success',
  failed: 'danger',
  stopped: 'info',
  idle: 'info'
}[audioRunning.value ? audioState.value : taskState.value] || 'info'))

const running = computed(() => ['starting', 'running', 'stopping'].includes(taskState.value) || audioRunning.value)

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
  // 音视频可能相差几百毫秒起停，取更早的开始时间更接近"这次采集持续了多久"。
  const starts = [toMillis(task.value?.startedAt), audio.value?.startedAt ? audio.value.startedAt * 1000 : null]
    .filter((value) => value !== null)
  if (!starts.length) return '—'
  const started = Math.min(...starts)
  const ends = [toMillis(task.value?.finishedAt)]
  if (audio.value?.state === 'completed' && audio.value.durationSeconds) {
    ends.push(started + Number(audio.value.durationSeconds) * 1000)
  }
  const ended = Math.max(...ends.filter((value) => value !== null), 0) || null
  const end = ended ?? frozenAt.value ?? now.value
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

// 产物文件：视频每路一个 MKV（后端 cameraFiles 给相对路径），音频固定 audio/session.wav。
// 大小只有音频收尾后才知道（视频 cameraFiles 不带字节数），没有就显示横杠，不编造。
const files = computed(() => {
  const rows = []
  const value = task.value?.cameraFiles || {}
  Object.entries(value).forEach(([camera, item]) => {
    rows.push({ path: item?.video || `${camera}/video.mkv`, label: `${camera} 录像`, kind: 'video' })
  })
  if (audio.value?.path && audio.value.state !== 'failed') {
    rows.push({
      path: 'audio/session.wav',
      label: '现场录音',
      kind: 'audio',
      size: audio.value.bytes || 0
    })
  }
  return rows
})

const outputDir = computed(() => String(task.value?.outputDir || audio.value?.directory || ''))

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
  if (id) {
    try {
      task.value = unwrap(await getInspectionStatus(id), {}) || task.value
      statusError.value = ''
    } catch (reason) {
      statusError.value = getErrorMessage(reason, '读取任务状态失败')
      if (showError) ElMessage.error(statusError.value)
    }
  }
  // 录音状态单独轮询：它的生命周期与视频任务不完全一致（只录声音时没有任务）
  if (audio.value && audioRunning.value) {
    try {
      const value = unwrap(await getActiveAudioRecording(), null)
      if (value) audio.value = { ...audio.value, ...value }
    } catch {
      // 轮询失败不打断采集，下一次再取
    }
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
  if (wantVideo.value && !selected.value.length) {
    ElMessage.warning('请至少选择一个摄像头')
    return
  }
  if (blockedByOther.value) {
    ElMessage.warning(`已有任务在运行（${active.state.value}），请先在对应页面停止`)
    return
  }
  busy.value = 'start'
  let startedTask = null
  try {
    // 1) 视频先起：它负责建任务目录，音频要写进同一个目录
    if (wantVideo.value) {
      const value = unwrap(await startInspection({
        taskName: taskName.value.trim() || '手动采集',
        cameraIds: [...selected.value],
        // mode 只是布局提示，真正生效的是 cameraIds
        mode: ({ 1: 'single', 4: 'four', 8: 'eight' }[selected.value.length] || 'custom'),
        durationSeconds: durationSeconds.value,
        pipeline: pipeline.value
      }), {})
      if (!value?.taskRunId) throw new Error('后端未返回任务编号')
      startedTask = value
      task.value = { state: 'starting', cameraIds: [...selected.value], ...value }
    } else {
      task.value = null
    }
    frozenAt.value = null
    statusError.value = ''

    // 2) 音频：声音+视频时写进任务目录；只录声音时让后端自己建目录
    if (wantAudio.value) {
      const directory = wantVideo.value ? (task.value?.outputDir || '') : ''
      audio.value = unwrap(await startAudioRecording(directory || undefined), {}) || {}
      if (audio.value.state === 'failed') throw new Error(audio.value.error || '麦克风不可用')
    } else {
      audio.value = null
    }

    startTicking()
    startPolling()
    active.refresh()
    ElMessage.success(durationSeconds.value ? '采集已开始，到点自动结束' : '采集已开始，手动结束')
  } catch (error) {
    // 音频起不来就别留一个"只录了画面"的采集：把视频也停掉，让用户看到真实原因。
    if (startedTask?.taskRunId) {
      try { await stopInspection(startedTask.taskRunId) } catch { /* 收尾失败也只能记录 */ }
      task.value = { ...(task.value || {}), state: 'failed', error: '音频不可用，已停止视频采集' }
    }
    if (audio.value?.state === 'failed') {
      ElMessage.error(audio.value.error || '麦克风不可用')
    } else {
      ElMessage.error(getErrorMessage(error, '开始采集失败'))
    }
  } finally {
    busy.value = ''
  }
}

async function stop() {
  if (!running.value) return
  try {
    await ElMessageBox.confirm(
      `结束采集会停止${wantAudio.value ? '录音与' : ''}${wantVideo.value ? '所有相机录制' : '音频设备'}并收尾写盘，已录内容会保留。确认结束？`,
      '结束采集',
      { type: 'warning', confirmButtonText: '结束采集', cancelButtonText: '继续采集' }
    )
  } catch {
    return
  }
  busy.value = 'stop'
  try {
    // 先停音频：WAV 要写正确的头，收尾比视频快；失败也要继续停视频。
    if (audio.value && audioRunning.value) {
      try {
        audio.value = unwrap(await stopAudioRecording(), {}) || audio.value
      } catch (error) {
        ElMessage.warning(getErrorMessage(error, '停止录音失败，请检查文件是否完整'))
      }
    }
    if (task.value?.taskRunId) {
      task.value = unwrap(await stopInspection(task.value.taskRunId), {}) || task.value
    }
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
  if (!task.value?.taskRunId) {
    ElMessage.info(`录音目录：${outputDir.value || '（未开始）'}，可用「复制路径」取走`)
    return
  }
  try {
    const result = unwrap(await openInspectionFolder(task.value.taskRunId), {})
    if (result.opened) ElMessage.success(`已在机器人主机打开：${result.dir}`)
    else ElMessage.warning(result.detail || '机器人主机无法打开文件管理器，请改用「复制路径」')
  } catch (error) {
    ElMessage.error(getErrorMessage(error, '打开目录失败'))
  }
}

function download(file) {
  const base = outputDir.value.replace(/\/$/, '')
  if (!base) return
  fetchManagedFileBlob(`${base}/${file.path}`)
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
  const base = outputDir.value.replace(/\/$/, '')
  if (!base) return
  const absolute = `${base}/${file.path}`
  preview.title = file.label || file.path
  preview.kind = file.kind === 'audio' ? 'audio' : 'video'
  // 视频要走转封装（MKV 浏览器播不了），音频与服务端记录的 WAV 原样返回即可
  preview.loader = file.kind === 'video'
    ? () => fetchPreviewBlob(absolute)
    : () => fetchManagedFileBlob(absolute)
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
  }
  // 刷新页面后可能还有一段录音在跑，接管它的状态，否则"结束采集"会停不掉音频
  try {
    const recording = unwrap(await getActiveAudioRecording(), null)
    if (recording) audio.value = recording
  } catch {
    // 读不到就当没有录音
  }
  if (running.value) {
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
                <el-radio value="both">声音 + 视频</el-radio>
                <el-radio value="video">仅视频</el-radio>
                <el-radio value="audio">仅声音</el-radio>
              </el-radio-group>
              <span v-if="wantAudio" class="field-hint">
                {{ wantVideo ? '音频写入同一任务目录 audio/session.wav' : '后端会新建一个采集目录存放 WAV' }}
              </span>
            </el-form-item>

            <el-form-item v-if="wantVideo" label="摄像头">
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

            <el-form-item v-if="wantVideo" label="模型检测">
              <el-switch v-model="pipeline" active-value="inference" inactive-value="passthrough" />
              <span class="field-hint">{{ pipeline === 'inference' ? '边录边推理（占 CPU）' : '只录制不推理（推荐采集时使用）' }}</span>
            </el-form-item>

            <el-form-item v-if="wantVideo" label="采集时长">
              <el-radio-group v-model="durationMode">
                <el-radio value="preset">预设</el-radio>
                <el-radio value="custom">自定义</el-radio>
                <el-radio value="manual">不限（手动结束）</el-radio>
              </el-radio-group>
            </el-form-item>
            <el-form-item v-if="wantVideo && durationMode === 'preset'" label="选择">
              <el-radio-group v-model="presetMinutes">
                <el-radio-button v-for="item in DURATION_PRESETS" :key="item" :value="item">{{ item }} 分钟</el-radio-button>
              </el-radio-group>
            </el-form-item>
            <el-form-item v-if="wantVideo && durationMode === 'custom'" label="分钟数">
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
                :disabled="!running"
                @click="stop"
              >结束采集</el-button>
            </div>
          </el-form>
        </section>

        <section class="view-panel">
          <div class="view-panel__head">
            <h2>采集中</h2>
            <small>
              {{ isMine ? `视频任务 ${task.taskRunId}` : '' }}
              <span v-if="isMine && audio">·</span>
              <span v-if="audio">{{ audioState === 'recording' ? '录音中' : audioState === 'completed' ? '录音已收尾' : audioState === 'failed' ? '录音失败' : '录音启动中' }}</span>
              <span v-if="!isMine && !audio">当前没有进行中的采集</span>
            </small>
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
              <strong class="stat__value">{{ wantVideo ? (task?.cameraCount ?? selected.length) : 0 }} 路</strong>
            </div>
            <div class="stat">
              <span class="stat__label">音频</span>
              <strong class="stat__value">{{ wantAudio ? (audioState === 'failed' ? '失败' : audio ? '在录' : '—') : '关' }}</strong>
            </div>
          </div>

          <el-alert
            v-if="audio?.error"
            class="capture-alert"
            type="error"
            :closable="false"
            show-icon
            :title="audio.error"
            description="麦克风被占用或未接好。请检查 USB 麦克风与增益设置（hardware.yaml 的 devices.audio）。"
          />

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
