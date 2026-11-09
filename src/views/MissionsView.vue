<script setup>
// 任务管理（采集会话版）：巡检任务的增删改查。
// 数据走 /api/v1/missions（missions 表），与旧 api/tasks.js（ui_tasks 影子表）分开。
// 表单只配"采什么"：视频通道、长录音、分段录音、结束方式；执行器在 P1 接入。
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { Delete, Plus, Refresh, RefreshRight, Search, VideoPlay } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import AsyncSection from '@/components/AsyncSection.vue'
import DataTable from '@/components/DataTable.vue'
import {
  CAMERA_OPTIONS, MISSION_STATES, archiveMission, createMission, createMissionDraft,
  endModeLabel, fetchArtifactBlob, fetchMissionDetail, fetchMissionsPage, fetchRunArtifacts, formatBytes,
  resumeRun, runMission, stateLabel, stateTagType, stopRun, toPayload, updateMission
} from '@/api/missions'
import { unwrap } from '@/api/envelope'
import { useServerTable } from '@/composables/useServerTable'
import { useAsyncTask } from '@/composables/useAsyncTask'
import { useRefreshFeedback } from '@/composables/useRefreshFeedback'
import { formatTime } from '@/utils/format'

const keyword = ref('')
const stateFilter = ref('')
const enabledTotal = ref(0)

const dialogVisible = ref(false)
const editing = ref(false)
const draft = reactive(createMissionDraft())
const draftRef = ref(null)

// 执行配置（A1）：本次临时覆盖采集组合，不影响任务本身的定义
const runDialogVisible = ref(false)
const runTarget = ref(null)
const runDraft = reactive({
  video: { enabled: true, cameras: [] },
  audio: { enabled: true, continuous: { enabled: true }, segments: { enabled: true } }
})

// 详情抽屉（P3）：任务配置 + 运行历史 + 产物
const detailVisible = ref(false)
const detailLoading = ref(false)
const detail = ref(null)
const artifacts = ref(null)
const selectedRunId = ref('')
// 产物音频走 Blob，避免生产鉴权下 <audio src> 带不上 token
const audioUrls = reactive({})
const audioLoading = reactive({})

const { pendingKey, run } = useAsyncTask()
const { refresh: refreshWithFeedback } = useRefreshFeedback()

const {
  rows, total, page, pageSize, loading, error, load, search, reload, setPage, setPageSize
} = useServerTable(fetchMissionsPage, { pageSize: 10 })

const columns = [
  { prop: 'name', label: '任务名称', minWidth: 200, fixed: 'left' },
  { prop: 'captureSummary', label: '采集组合', width: 170, slot: 'capture' },
  { prop: 'durationSeconds', label: '结束方式', width: 120, slot: 'endMode' },
  { prop: 'state', label: '状态', width: 110, slot: 'state' },
  { prop: 'createdAt', label: '创建时间', width: 175, formatter: (row) => formatTime(row.createdAt) },
  { prop: 'missionId', label: '任务 ID', width: 200 },
  { prop: 'actions', label: '操作', width: 280, fixed: 'right', slot: 'actions' }
]

const rules = {
  name: [{ required: true, message: '请输入任务名称', trigger: 'blur' }]
}

/** 采集组合的实时校验：与后端 normalize_definition 保持同一套口径。 */
const captureError = computed(() => {
  const videoOn = !!draft.video.enabled
  const audioEnabled = !!draft.audio.enabled
  const continuousOn = !!draft.audio.continuous.enabled
  const segmentsOn = !!draft.audio.segments.enabled
  const audioActive = audioEnabled && (continuousOn || segmentsOn)

  if (videoOn && !(draft.video.cameras || []).length) return '开启视频录像时至少选择一个相机通道'
  if (audioEnabled && !continuousOn && !segmentsOn) return '录音已开启，但长录音与分段都关闭'
  if (!videoOn && !audioActive) return '请至少开启录音或录像'
  if (Number(draft.durationSeconds) > Number(draft.maxDurationSeconds)) return '设定时长不能超过安全上限'
  return ''
})

/** 结束方式用分钟输入，落库仍是秒。 */
const durationMinutes = computed({
  get: () => Math.round((Number(draft.durationSeconds) || 0) / 60),
  set: (value) => {
    draft.durationSeconds = Math.max(0, Number(value) || 0) * 60
  }
})

const maxDurationMinutes = computed({
  get: () => Math.round((Number(draft.maxDurationSeconds) || 3600) / 60),
  set: (value) => {
    draft.maxDurationSeconds = Math.max(1, Number(value) || 60) * 60
  }
})

const headerDescription = computed(() => {
  const scope = keyword.value || stateFilter.value ? '筛选结果' : '全部'
  return `${scope} ${total.value} 个巡检任务 · 已启用 ${enabledTotal.value} 个`
})

/** 空采集提示：列表里直接说清"这次什么都没采"。 */
function captureRowType(row) {
  return String(row?.captureSummary || '').startsWith('仅') ? 'warning' : 'info'
}

let filterTimer = null
watch([keyword, stateFilter], () => {
  if (filterTimer) window.clearTimeout(filterTimer)
  filterTimer = window.setTimeout(() => {
    search({ keyword: keyword.value, state: stateFilter.value })
  }, 300)
})

onMounted(async () => {
  await load()
  await refreshEnabledTotal()
})

async function refreshEnabledTotal() {
  try {
    const result = await fetchMissionsPage({ state: 'enabled', page: 1, pageSize: 1 })
    enabledTotal.value = result.total
  } catch {
    enabledTotal.value = 0
  }
}

function openCreate() {
  editing.value = false
  Object.assign(draft, createMissionDraft())
  dialogVisible.value = true
}

function openEdit(row) {
  editing.value = true
  Object.assign(draft, createMissionDraft(row))
  dialogVisible.value = true
}

async function submitDraft() {
  if (!draftRef.value) return
  const valid = await draftRef.value.validate().catch(() => false)
  if (!valid) return
  if (captureError.value) {
    ElMessage.warning(captureError.value)
    return
  }
  const payload = toPayload(draft)
  const action = editing.value
    ? () => updateMission(draft.missionId, payload)
    : () => createMission(payload)
  const result = await run('save', action, { success: editing.value ? '任务已更新' : '任务已创建' })
  if (result === undefined) return
  dialogVisible.value = false
  await reload()
  await refreshEnabledTotal()
}

async function openDetail(row) {
  detailVisible.value = true
  detailLoading.value = true
  detail.value = null
  artifacts.value = null
  selectedRunId.value = ''
  try {
    const data = await fetchMissionDetail(row.missionId)
    detail.value = data
    const latest = (data.runs || [])[0]
    if (latest) {
      await selectRun(latest)
    } else if (data.latestArtifacts) {
      artifacts.value = data.latestArtifacts
    }
    if ((data.runs || []).some(isRunning)) startDetailPolling(row.missionId)
  } catch (error) {
    ElMessage.error(error?.message || '详情加载失败')
  } finally {
    detailLoading.value = false
  }
}

async function selectRun(run) {
  selectedRunId.value = run.taskRunId
  artifacts.value = null
  try {
    artifacts.value = await fetchRunArtifacts(run.taskRunId)
  } catch (error) {
    ElMessage.warning(error?.message || '产物加载失败')
  }
}

async function loadAudio(row) {
  const key = `${selectedRunId.value}:${row.path}`
  if (audioUrls[key]) return
  audioLoading[key] = true
  try {
    const blob = await fetchArtifactBlob(selectedRunId.value, row.path)
    audioUrls[key] = URL.createObjectURL(blob)
  } catch (error) {
    ElMessage.error(error?.message || '音频加载失败')
  } finally {
    audioLoading[key] = false
  }
}

function audioKey(row) {
  return `${selectedRunId.value}:${row.path}`
}

/** 下载/打开产物。走 axios 取二进制而不是裸 <a href>：
 *  开启鉴权后浏览器直接请求带不上 Authorization，会 401。 */
async function downloadArtifact(row) {
  const key = `dl:${audioKey(row)}`
  if (audioLoading[key]) return
  audioLoading[key] = true
  try {
    const blob = await fetchArtifactBlob(selectedRunId.value, row.path)
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = row.path.split('/').pop() || 'artifact'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    window.setTimeout(() => URL.revokeObjectURL(url), 2000)
  } catch (error) {
    ElMessage.error(error?.message || '文件获取失败')
  } finally {
    audioLoading[key] = false
  }
}

function runStateText(state) {
  return {
    queued: '排队中', executing: '执行中', completed: '已完成',
    failed: '失败', aborted: '已中止', interrupted: '已中断'
  }[state] || state || '—'
}

function runStateType(state) {
  return { completed: 'success', executing: 'primary', failed: 'danger', aborted: 'warning' }[state] || 'info'
}

function alertLabel(severity) {
  return { critical: '严重', warning: '告警', info: '提示' }[severity] || severity || '—'
}

function alertTagType(severity) {
  return { critical: 'danger', warning: 'warning', info: 'info' }[severity] || 'info'
}

/** 中断/失败后重跑：后端会新开一次会话，旧目录保留。 */
async function retryRun(row) {
  const started = await run(
    `resume-${row.taskRunId}`,
    async () => unwrap(await resumeRun(row.taskRunId, 60), null),
    { success: '已重新开始一次采集' }
  )
  if (!started?.taskRunId) return
  ElMessage.info(`新运行：${started.taskRunId}`)
  if (detail.value?.mission?.missionId) {
    await openDetail({ missionId: detail.value.mission.missionId })
  }
}

/** 结束正在运行的会话：停采集 → 收尾 → 落库，产物保留。 */
async function stopCurrentRun(row) {
  try {
    await ElMessageBox.confirm(
      `将结束本次采集（${row.taskRunId}）。已采集的视频与音频会正常收尾并保留，任务状态记为「已中止」。`,
      '结束采集',
      { type: 'warning', confirmButtonText: '结束', cancelButtonText: '继续采集' }
    )
  } catch {
    return
  }
  const result = await run(
    `stop-${row.taskRunId}`,
    () => stopRun(row.taskRunId, 'operator'),
    { success: '已请求结束，正在收尾' }
  )
  if (result === undefined) return
  if (detail.value?.mission?.missionId) {
    // 收尾要关文件、写 manifest、落库，给一点时间再刷新
    window.setTimeout(() => refreshDetail(detail.value.mission.missionId), 1200)
  }
}

function isRunning(row) {
  return ['queued', 'executing'].includes(row?.state)
}

/** 打开执行配置：把任务的采集组合带进来，允许本次临时改动。 */
function openRunDialog(row) {
  runTarget.value = row
  runDraft.video.enabled = !!row.video?.enabled
  runDraft.video.cameras = [...(row.video?.cameras || [])]
  runDraft.audio.enabled = !!row.audio?.enabled
  runDraft.audio.continuous.enabled = !!row.audio?.continuous?.enabled
  runDraft.audio.segments.enabled = !!row.audio?.segments?.enabled
  runDialogVisible.value = true
}

/** 本次运行的虚拟时长（0 表示不定时，按安全上限算）。 */
const runTargetSeconds = computed(() => {
  const row = runTarget.value
  if (!row) return 0
  return Number(row.durationSeconds) > 0
    ? Number(row.durationSeconds)
    : Number(row.maxDurationSeconds || 3600)
})

/** 执行前的即时校验，口径与后端 normalize_definition 一致。 */
const runCaptureError = computed(() => {
  const videoOn = !!runDraft.video.enabled
  const audioEnabled = !!runDraft.audio.enabled
  const continuousOn = !!runDraft.audio.continuous.enabled
  const segmentsOn = !!runDraft.audio.segments.enabled
  const audioActive = audioEnabled && (continuousOn || segmentsOn)

  if (videoOn && !(runDraft.video.cameras || []).length) return '开启视频录像时至少选择一个相机通道'
  if (audioEnabled && !continuousOn && !segmentsOn) return '录音已开启，但长录音与分段都关闭'
  if (!videoOn && !audioActive) return '请至少开启录音或录像'
  return ''
})

/** 本次配置是否偏离了任务定义——偏离时要明确提示"只影响这一次"。 */
const runDiffersFromTask = computed(() => {
  const row = runTarget.value
  if (!row) return false
  return (
    !!runDraft.video.enabled !== !!row.video?.enabled
    || !!runDraft.audio.enabled !== !!row.audio?.enabled
    || !!runDraft.audio.continuous.enabled !== !!row.audio?.continuous?.enabled
    || !!runDraft.audio.segments.enabled !== !!row.audio?.segments?.enabled
  )
})

/** 粗略磁盘预估，与后端 _ensure_disk_space 的口径一致（音频 88200 B/s/份，视频 512 KB/s/路）。 */
const runDiskEstimateMb = computed(() => {
  const seconds = runTargetSeconds.value
  let copies = 0
  if (runDraft.audio.enabled) {
    copies = (runDraft.audio.continuous.enabled ? 1 : 0) + (runDraft.audio.segments.enabled ? 1 : 0)
  }
  let bytes = 88200 * copies * seconds
  if (runDraft.video.enabled) {
    bytes += 512 * 1024 * Math.max(1, runDraft.video.cameras.length) * seconds
  }
  return Math.round((bytes * 1.2) / 1024 / 1024)
})

/** 秒 → m:ss / h:mm:ss，用于进度显示。 */
function formatClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const hour = Math.floor(total / 3600)
  const minute = Math.floor((total % 3600) / 60)
  const second = total % 60
  const pad = (value) => String(value).padStart(2, '0')
  return hour > 0 ? `${hour}:${pad(minute)}:${pad(second)}` : `${minute}:${pad(second)}`
}

// 详情抽屉打开且有会话在跑时自动刷新，让用户看到进度与"结束"按钮
let detailTimer = null

function stopDetailPolling() {
  if (detailTimer) {
    window.clearInterval(detailTimer)
    detailTimer = null
  }
}

function startDetailPolling(missionId) {
  stopDetailPolling()
  detailTimer = window.setInterval(async () => {
    if (!detailVisible.value) {
      stopDetailPolling()
      return
    }
    try {
      const data = await fetchMissionDetail(missionId)
      detail.value = data
      if (!(data.runs || []).some(isRunning)) {
        stopDetailPolling()
      }
    } catch {
      stopDetailPolling()
    }
  }, 2000)
}

async function refreshDetail(missionId) {
  try {
    const data = await fetchMissionDetail(missionId)
    detail.value = data
    const latest = (data.runs || [])[0]
    if (latest && latest.taskRunId !== selectedRunId.value) {
      await selectRun(latest)
    }
    if ((data.runs || []).some(isRunning)) startDetailPolling(missionId)
    else stopDetailPolling()
  } catch {
    /* 刷新失败保留原内容 */
  }
}

watch(detailVisible, (visible) => {
  if (!visible) {
    stopDetailPolling()
    Object.keys(audioUrls).forEach((key) => {
      URL.revokeObjectURL(audioUrls[key])
      delete audioUrls[key]
    })
  }
})

onUnmounted(() => {
  stopDetailPolling()
  Object.keys(audioUrls).forEach((key) => URL.revokeObjectURL(audioUrls[key]))
})

async function executeMission() {
  const row = runTarget.value
  if (!row || runCaptureError.value) return

  const overrides = {
    video: { enabled: !!runDraft.video.enabled, cameras: [...runDraft.video.cameras] },
    audio: {
      enabled: !!runDraft.audio.enabled,
      continuous: { enabled: !!runDraft.audio.continuous.enabled },
      segments: { enabled: !!runDraft.audio.segments.enabled }
    }
  }
  const started = await run(
    `run-${row.missionId}`,
    async () => unwrap(await runMission(row.missionId, { overrides, speed: 60 }), null),
    { success: '采集会话已启动' }
  )
  if (!started?.taskRunId) return
  runDialogVisible.value = false
  ElMessage.info(`运行 ID：${started.taskRunId}`)

  // 直接打开详情：能立即看到进行中的会话与进度，也就能点「结束」
  await openDetail({ missionId: row.missionId })
}

async function removeMission(row) {
  try {
    await ElMessageBox.confirm(
      `归档后该任务不再出现在列表中，历史运行记录与采集数据保留。确认归档「${row.name}」？`,
      '归档确认',
      { type: 'warning', confirmButtonText: '归档', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const result = await run(`archive-${row.missionId}`, () => archiveMission(row.missionId), { success: '任务已归档' })
  if (result === undefined) return
  await reload()
  await refreshEnabledTotal()
}

async function toggleState(row) {
  const next = row.state === 'enabled' ? 'disabled' : 'enabled'
  const result = await run(`state-${row.missionId}`, () => updateMission(row.missionId, {
    name: row.name,
    state: next,
    video: row.video,
    audio: row.audio,
    durationSeconds: row.durationSeconds,
    maxDurationSeconds: row.maxDurationSeconds,
    infer: row.infer
  }), { success: next === 'enabled' ? '任务已启用' : '任务已停用', silentError: true })
  if (result === undefined) {
    ElMessage.error('状态修改失败')
    return
  }
  row.state = next
  await refreshEnabledTotal()
}

function resetFilters() {
  keyword.value = ''
  stateFilter.value = ''
}

async function refresh() {
  await refreshWithFeedback(async () => {
    const ok = await reload()
    await refreshEnabledTotal()
    return ok && !error.value
  }, { success: '任务列表已刷新', isError: () => error.value })
}
</script>

<template>
  <div class="view">
    <PageHeader title="任务管理" :description="headerDescription">
      <template #extra>
        <el-button :icon="Refresh" :loading="loading" @click="refresh">刷新</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新建任务</el-button>
      </template>
    </PageHeader>

    <AsyncSection :loading="loading && !rows.length" :error="error" loading-text="正在加载任务列表…" @retry="load">
      <section class="view-panel">
        <div class="view-toolbar">
          <div class="view-toolbar__actions">
            <el-input
              v-model="keyword"
              class="filter-search"
              placeholder="按任务名称或任务 ID 搜索"
              :prefix-icon="Search"
              clearable
            />
            <el-select v-model="stateFilter" class="filter-select" placeholder="任务状态" clearable>
              <el-option v-for="item in MISSION_STATES" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
            <el-button text :icon="RefreshRight" @click="resetFilters">重置</el-button>
          </div>
          <span class="view-toolbar__hint">共 {{ total }} 条</span>
        </div>

        <DataTable
          :rows="rows"
          :columns="columns"
          :loading="loading"
          row-key="missionId"
          :page="page"
          :page-size="pageSize"
          :total="total"
          empty-text="暂无巡检任务"
          @page-change="setPage"
          @size-change="setPageSize"
        >
          <template #empty>
            <el-empty :description="keyword || stateFilter ? '没有符合筛选条件的任务' : '还没有巡检任务'">
              <el-button v-if="keyword || stateFilter" @click="resetFilters">清空筛选</el-button>
              <el-button v-else type="primary" :icon="Plus" @click="openCreate">新建任务</el-button>
            </el-empty>
          </template>

          <template #cell-endMode="{ row }">
            {{ endModeLabel(row) }}
          </template>

          <template #cell-state="{ row }">
            <el-tag :type="stateTagType(row.state)" size="small">{{ stateLabel(row.state) }}</el-tag>
          </template>

          <template #cell-capture="{ row }">
            <el-tag :type="captureRowType(row)" size="small" effect="plain">{{ row.captureSummary || '未采集' }}</el-tag>
          </template>

          <template #cell-actions="{ row }">
            <el-button text size="small" @click.stop="openDetail(row)">详情</el-button>
            <el-button text type="primary" size="small" @click.stop="openEdit(row)">编辑</el-button>
            <el-button
              text
              type="success"
              size="small"
              :icon="VideoPlay"
              :loading="pendingKey === `run-${row.missionId}`"
              :disabled="row.state !== 'enabled'"
              @click.stop="openRunDialog(row)"
            >
              执行
            </el-button>
            <el-button
              text
              type="warning"
              size="small"
              :loading="pendingKey === `state-${row.missionId}`"
              @click.stop="toggleState(row)"
            >
              {{ row.state === 'enabled' ? '停用' : '启用' }}
            </el-button>
            <el-button
              text
              type="danger"
              size="small"
              :icon="Delete"
              :loading="pendingKey === `archive-${row.missionId}`"
              @click.stop="removeMission(row)"
            >
              归档
            </el-button>
          </template>
        </DataTable>
      </section>
    </AsyncSection>

    <el-dialog v-model="dialogVisible" :title="editing ? '编辑任务' : '新建任务'" width="700px" destroy-on-close>
      <el-form ref="draftRef" :model="draft" :rules="rules" label-width="120px">
        <el-form-item label="任务名称" prop="name">
          <el-input v-model="draft.name" placeholder="例如：上午舍内采集" maxlength="200" show-word-limit />
        </el-form-item>

        <el-divider content-position="left">视频</el-divider>
        <el-form-item label="视频录像">
          <el-switch v-model="draft.video.enabled" />
          <span class="hint-text">关闭后本次任务不录视频</span>
        </el-form-item>
        <el-form-item v-if="draft.video.enabled" label="相机通道">
          <el-checkbox-group v-model="draft.video.cameras">
            <el-checkbox v-for="item in CAMERA_OPTIONS" :key="item.value" :value="item.value">
              {{ item.label }}
            </el-checkbox>
          </el-checkbox-group>
        </el-form-item>

        <el-divider content-position="left">录音</el-divider>
        <el-form-item label="录音">
          <el-switch v-model="draft.audio.enabled" />
          <span class="hint-text">关闭后本次任务不录音</span>
        </el-form-item>
        <template v-if="draft.audio.enabled">
          <el-form-item label="连续长录音">
            <el-switch v-model="draft.audio.continuous.enabled" />
            <span class="hint-text">整段为一个文件，随任务结束而结束</span>
          </el-form-item>
          <el-form-item label="保存分段">
            <el-switch v-model="draft.audio.segments.enabled" />
            <span class="hint-text">另存 60 秒一段，用于崩溃恢复与模型推理</span>
          </el-form-item>
          <el-form-item v-if="draft.audio.segments.enabled" label="分段时长">
            <el-input-number v-model="draft.audio.segments.segmentSeconds" :min="10" :max="60" :step="10" />
            <span class="hint-text">秒（10–60）</span>
          </el-form-item>
        </template>

        <el-divider content-position="left">结束方式</el-divider>
        <el-form-item label="运行时长">
          <el-input-number v-model="durationMinutes" :min="0" :max="maxDurationMinutes" />
          <span class="hint-text">分钟，0 表示不定时、靠手动结束</span>
        </el-form-item>
        <el-form-item label="安全上限">
          <el-input-number v-model="maxDurationMinutes" :min="1" :max="240" />
          <span class="hint-text">分钟，防止忘记停止（默认 60）</span>
        </el-form-item>

        <el-form-item label="任务状态">
          <el-radio-group v-model="draft.state">
            <el-radio value="enabled">启用</el-radio>
            <el-radio value="disabled">停用</el-radio>
            <el-radio value="draft">草稿</el-radio>
          </el-radio-group>
        </el-form-item>

        <el-divider content-position="left">推理</el-divider>
        <el-form-item label="异常声音检测">
          <el-switch v-model="draft.infer.enabled" />
          <span class="hint-text">
            能力：{{ draft.infer.capability }}；执行器尚未消费该配置，开启后仅记录在任务定义里
          </span>
        </el-form-item>

        <el-alert v-if="captureError" :title="captureError" type="warning" :closable="false" show-icon />
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="pendingKey === 'save'" :disabled="!!captureError" @click="submitDraft">
          {{ editing ? '保存' : '创建' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 执行配置：本次临时覆盖采集组合，不改任务定义 -->
    <el-dialog v-model="runDialogVisible" title="执行采集" width="620px" destroy-on-close>
      <template v-if="runTarget">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="任务">{{ runTarget.name }}</el-descriptions-item>
          <el-descriptions-item label="任务默认">{{ runTarget.captureSummary }}</el-descriptions-item>
          <el-descriptions-item label="本次时长">
            {{ runTarget.durationSeconds > 0 ? formatClock(runTargetSeconds) : `不定时（上限 ${formatClock(runTargetSeconds)}）` }}
          </el-descriptions-item>
          <el-descriptions-item label="预计占用">约 {{ runDiskEstimateMb }} MB</el-descriptions-item>
        </el-descriptions>

        <el-divider content-position="left">本次采集内容</el-divider>

        <el-form label-width="110px">
          <el-form-item label="视频录像">
            <el-switch v-model="runDraft.video.enabled" />
          </el-form-item>
          <el-form-item v-if="runDraft.video.enabled" label="相机通道">
            <el-checkbox-group v-model="runDraft.video.cameras">
              <el-checkbox v-for="item in CAMERA_OPTIONS" :key="item.value" :value="item.value">
                {{ item.label }}
              </el-checkbox>
            </el-checkbox-group>
          </el-form-item>

          <el-form-item label="录音">
            <el-switch v-model="runDraft.audio.enabled" />
          </el-form-item>
          <template v-if="runDraft.audio.enabled">
            <el-form-item label="连续长录音">
              <el-switch v-model="runDraft.audio.continuous.enabled" />
            </el-form-item>
            <el-form-item label="保存分段">
              <el-switch v-model="runDraft.audio.segments.enabled" />
            </el-form-item>
          </template>
        </el-form>

        <el-alert
          v-if="runCaptureError"
          :title="runCaptureError"
          type="warning"
          :closable="false"
          show-icon
        />
        <el-alert
          v-else-if="runDiffersFromTask"
          title="本次配置与任务定义不同，只对这一次运行生效，不会修改任务。"
          type="info"
          :closable="false"
          show-icon
        />
      </template>

      <template #footer>
        <el-button @click="runDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="pendingKey === `run-${runTarget?.missionId}`"
          :disabled="!!runCaptureError"
          @click="executeMission"
        >
          开始采集
        </el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="detailVisible" title="任务详情" size="62%" destroy-on-close>
      <div v-loading="detailLoading" class="detail-body">
        <template v-if="detail">
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="任务名称">{{ detail.mission.name }}</el-descriptions-item>
            <el-descriptions-item label="采集组合">{{ detail.mission.captureSummary }}</el-descriptions-item>
            <el-descriptions-item label="结束方式">{{ endModeLabel(detail.mission) }}</el-descriptions-item>
            <el-descriptions-item label="任务状态">{{ stateLabel(detail.mission.state) }}</el-descriptions-item>
            <el-descriptions-item label="任务 ID" :span="2">
              <span class="mono">{{ detail.mission.missionId }}</span>
            </el-descriptions-item>
          </el-descriptions>

          <el-divider content-position="left">运行历史</el-divider>
          <el-empty v-if="!detail.runs.length" description="还没有运行记录" :image-size="56" />
          <el-table
            v-else
            :data="detail.runs"
            size="small"
            border
            highlight-current-row
            @row-click="selectRun"
          >
            <el-table-column prop="taskRunId" label="运行 ID" min-width="170">
              <template #default="{ row }"><span class="mono">{{ row.taskRunId }}</span></template>
            </el-table-column>
            <el-table-column label="状态" width="88">
              <template #default="{ row }">
                <el-tag :type="runStateType(row.state)" size="small">{{ runStateText(row.state) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="进度" width="150">
              <template #default="{ row }">
                <div v-if="isRunning(row)" class="run-progress">
                  <el-progress
                    :percentage="row.progressPercent || 0"
                    :stroke-width="5"
                    :show-text="false"
                  />
                  <span class="run-progress__text">
                    {{ formatClock(row.elapsedSeconds) }} / {{ formatClock(row.targetSeconds) }}
                  </span>
                </div>
                <span v-else class="run-progress__text">
                  {{ row.elapsedSeconds > 0 ? formatClock(row.elapsedSeconds) : '—' }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="开始" width="150">
              <template #default="{ row }">{{ formatTime(row.startedAt) }}</template>
            </el-table-column>
            <el-table-column label="结束" width="150">
              <template #default="{ row }">{{ formatTime(row.finishedAt) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="90">
              <template #default="{ row }">
                <el-button
                  v-if="isRunning(row)"
                  text
                  type="danger"
                  size="small"
                  :loading="pendingKey === `stop-${row.taskRunId}`"
                  @click.stop="stopCurrentRun(row)"
                >
                  结束
                </el-button>
                <el-button
                  v-else-if="['interrupted', 'failed', 'aborted'].includes(row.state)"
                  text
                  type="primary"
                  size="small"
                  :loading="pendingKey === `resume-${row.taskRunId}`"
                  @click.stop="retryRun(row)"
                >
                  重跑
                </el-button>
              </template>
            </el-table-column>
          </el-table>

          <el-divider content-position="left">告警</el-divider>
          <el-empty v-if="!detail.alerts || !detail.alerts.length" description="本次没有告警" :image-size="48" />
          <el-table v-else :data="detail.alerts" size="small" border>
            <el-table-column label="级别" width="90">
              <template #default="{ row }">
                <el-tag :type="alertTagType(row.severity)" size="small">{{ alertLabel(row.severity) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="message" label="内容" min-width="260" />
            <el-table-column label="时间" width="170">
              <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
            </el-table-column>
          </el-table>

          <el-divider content-position="left">产物</el-divider>
          <template v-if="artifacts && artifacts.exists">
            <p class="artifact-path mono">{{ artifacts.directory }}</p>
            <el-table :data="artifacts.files" size="small" border>
              <el-table-column prop="path" label="文件" min-width="230">
                <template #default="{ row }"><span class="mono">{{ row.path }}</span></template>
              </el-table-column>
              <el-table-column label="大小" width="95">
                <template #default="{ row }">{{ formatBytes(row.size) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="250">
                <template #default="{ row }">
                  <template v-if="row.mime.startsWith('audio')">
                    <audio
                      v-if="audioUrls[audioKey(row)]"
                      :src="audioUrls[audioKey(row)]"
                      controls
                      class="audio-player"
                    />
                    <el-button
                      v-else
                      text
                      type="primary"
                      size="small"
                      :loading="audioLoading[audioKey(row)]"
                      @click="loadAudio(row)"
                    >
                      加载音频
                    </el-button>
                  </template>
                  <el-button
                    v-else
                    text
                    type="primary"
                    size="small"
                    :loading="audioLoading[`dl:${audioKey(row)}`]"
                    @click="downloadArtifact(row)"
                  >
                    下载
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
          </template>
          <el-empty v-else description="该运行没有产物（或目录已被清理）" :image-size="56" />
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.hint-text {
  margin-left: 10px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.mono {
  font-family: var(--el-font-family-mono, monospace);
  font-size: 12px;
}

.detail-body {
  min-height: 200px;
}

.artifact-path {
  margin: 0 0 8px;
  color: var(--el-text-color-secondary);
  word-break: break-all;
}

.audio-player {
  width: 220px;
  height: 32px;
}

.run-progress {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.run-progress__text {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
