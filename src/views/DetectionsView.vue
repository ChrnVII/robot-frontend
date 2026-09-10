<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { getDetectionImage, getDetections, getInspectionStatus, startInspection, stopInspection } from '@/api/inspection'

const form = reactive({ taskRunId: 'inspection-demo-001', mode: 'four', durationSeconds: 300 })
const modeOptions = [
  { label: '单摄像头', value: 'single', count: 1 },
  { label: '四路巡检', value: 'four', count: 4 },
  { label: '八路巡检', value: 'eight', count: 8 },
]
const cameras = Array.from({ length: 8 }, (_, index) => ({ id: `cam${String(index + 1).padStart(2, '0')}`, name: `摄像头 ${String(index + 1).padStart(2, '0')}` }))
const status = ref({ taskRunId: form.taskRunId, mode: 'four', state: 'stopped', processed: 0, positive: 0, cameraErrors: {} })
const detections = ref([])
const selectedDetection = ref(null)
const loading = ref(false)
const resultsLoading = ref(false)
const isDemo = ref(true)
const imageUrl = ref('')
let timer

const demoDetections = [
  { eventType: 'detection', taskRunId: form.taskRunId, cameraId: 'cam01', frameId: 128, detectionId: 'cam01-00000128', capturedAt: '2026-09-10T10:21:38+08:00', detections: [{ label: '人员未佩戴安全帽', confidence: 0.96 }], countByLabel: { '人员未佩戴安全帽': 1 }, latencyMs: 82, resultImageId: 'cam01:00000128_result.jpg' },
  { eventType: 'detection', taskRunId: form.taskRunId, cameraId: 'cam02', frameId: 97, detectionId: 'cam02-00000097', capturedAt: '2026-09-10T10:20:55+08:00', detections: [{ label: '设备温度异常', confidence: 0.91 }], countByLabel: { '设备温度异常': 1 }, latencyMs: 76, resultImageId: 'cam02:00000097_result.jpg' },
  { eventType: 'detection', taskRunId: form.taskRunId, cameraId: 'cam03', frameId: 73, detectionId: 'cam03-00000073', capturedAt: '2026-09-10T10:20:11+08:00', detections: [{ label: '区域入侵', confidence: 0.88 }], countByLabel: { '区域入侵': 1 }, latencyMs: 95, resultImageId: 'cam03:00000073_result.jpg' },
  { eventType: 'detection', taskRunId: form.taskRunId, cameraId: 'cam04', frameId: 42, detectionId: 'cam04-00000042', capturedAt: '2026-09-10T10:19:43+08:00', detections: [{ label: '烟火疑似', confidence: 0.84 }], countByLabel: { '烟火疑似': 1 }, latencyMs: 103, resultImageId: 'cam04:00000042_result.jpg' },
]

const currentMode = computed(() => modeOptions.find((option) => option.value === form.mode) || modeOptions[1])
const activeCameras = computed(() => cameras.slice(0, currentMode.value.count))
const isRunning = computed(() => ['starting', 'running', 'stopping'].includes(status.value.state))
const stateText = computed(() => ({ starting: '启动中', running: '运行中', stopping: '停止中', completed: '已完成', stopped: '已停止', failed: '失败' }[status.value.state] || '未连接'))
const stateType = computed(() => ({ running: 'success', completed: 'success', starting: 'warning', stopping: 'warning', failed: 'danger' }[status.value.state] || 'info'))
const positiveRate = computed(() => status.value.processed ? `${((status.value.positive / status.value.processed) * 100).toFixed(1)}%` : '0.0%')

function unwrap(response) {
  const body = response?.data ?? response
  return body?.data ?? body
}
function seedDemo() {
  detections.value = demoDetections
  selectedDetection.value = detections.value[0]
  status.value = { ...status.value, state: 'stopped', processed: 1280, positive: 4 }
}
async function refreshStatus(showMessage = false) {
  try {
    const data = unwrap(await getInspectionStatus(form.taskRunId))
    if (data && typeof data === 'object') { status.value = { ...status.value, ...data }; isDemo.value = false }
  } catch (error) {
    if (showMessage) ElMessage.warning('暂时无法连接后端，当前显示演示数据')
  }
}
async function refreshDetections(showMessage = true) {
  resultsLoading.value = true
  try {
    const data = unwrap(await getDetections(form.taskRunId, { offset: 0, limit: 50 }))
    const items = Array.isArray(data?.items) ? data.items : []
    if (items.length) { detections.value = items; selectedDetection.value = items[0]; isDemo.value = false }
    else if (showMessage) ElMessage.info('当前巡检暂无检测结果')
  } catch (error) {
    if (showMessage) ElMessage.warning('无法读取检测结果，保留演示数据')
  } finally { resultsLoading.value = false }
}
async function beginInspection() {
  loading.value = true
  try {
    const response = await startInspection({ mode: form.mode, taskRunId: form.taskRunId, durationSeconds: Number(form.durationSeconds) || 0, cameraIds: activeCameras.value.map((camera) => camera.id) })
    const data = unwrap(response)
    status.value = { ...status.value, ...(data || {}), taskRunId: form.taskRunId, mode: form.mode, state: data?.state || 'starting' }
    isDemo.value = false
    ElMessage.success('巡检任务已启动')
    beginPolling()
  } catch (error) { ElMessage.error('启动失败，请检查服务连接') }
  finally { loading.value = false }
}
async function stopCurrentInspection() {
  if (!form.taskRunId) return
  loading.value = true
  try { await stopInspection(form.taskRunId); status.value = { ...status.value, state: 'stopping' }; ElMessage.success('停止信号已提交'); beginPolling() }
  catch (error) { ElMessage.error('停止失败，请检查服务连接') }
  finally { loading.value = false }
}
function beginPolling() {
  clearInterval(timer)
  timer = setInterval(async () => { await refreshStatus(); if (!isRunning.value) { clearInterval(timer); await refreshDetections(false) } }, 3000)
}
async function selectDetection(item) {
  selectedDetection.value = item
  if (!item?.resultImageId) return
  try {
    const response = await getDetectionImage(form.taskRunId, item.resultImageId)
    if (imageUrl.value) URL.revokeObjectURL(imageUrl.value)
    imageUrl.value = URL.createObjectURL(response.data)
  } catch (error) { imageUrl.value = '' }
}
function formatTime(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '--' }
function labelOf(item) { return Object.keys(item?.countByLabel || {})[0] || item?.detections?.[0]?.label || '检测事件' }

onMounted(() => { seedDemo(); refreshStatus(); refreshDetections(false) })
onBeforeUnmount(() => { clearInterval(timer); if (imageUrl.value) URL.revokeObjectURL(imageUrl.value) })
</script>

<template>
  <div class="detection-page">
    <div class="section-heading"><div><span class="eyebrow">01 / INSPECTION</span><h2>智能巡检与检测结果</h2><p>启动一次巡检任务，实时查看摄像头状态和模型识别结果。</p></div><el-tag :type="isDemo ? 'warning' : 'success'" effect="plain">{{ isDemo ? '演示数据' : '接口已连接' }}</el-tag></div>

    <el-card class="config-card" shadow="never">
      <div class="card-title"><div><span class="eyebrow">CONFIGURATION</span><h3>巡检配置</h3></div><el-tag :type="stateType" effect="light">{{ stateText }}</el-tag></div>
      <el-form :model="form" label-position="top" class="inspection-form"><el-form-item label="任务运行 ID"><el-input v-model="form.taskRunId" placeholder="inspection-demo-001" :disabled="isRunning" /></el-form-item><el-form-item label="巡检模式"><el-select v-model="form.mode" :disabled="isRunning"><el-option v-for="item in modeOptions" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item><el-form-item label="运行时长（秒）"><el-input-number v-model="form.durationSeconds" :min="0" :max="86400" controls-position="right" /></el-form-item><div class="form-actions"><el-button type="primary" :loading="loading" :disabled="isRunning" @click="beginInspection">▶&nbsp; 开始检测</el-button><el-button type="danger" plain :loading="loading" :disabled="!isRunning" @click="stopCurrentInspection">■&nbsp; 停止</el-button></div></el-form>
    </el-card>

    <div class="stats-grid"><div class="stat-card"><span>任务状态</span><strong>{{ stateText }}</strong><small>{{ form.taskRunId }}</small></div><div class="stat-card"><span>已处理帧数</span><strong>{{ status.processed.toLocaleString() }}</strong><small>Processed frames</small></div><div class="stat-card"><span>检测阳性</span><strong class="accent">{{ status.positive }}</strong><small>Positive events</small></div><div class="stat-card"><span>阳性率</span><strong>{{ positiveRate }}</strong><small>{{ currentMode.label }}</small></div></div>

    <div class="workspace-grid"><el-card class="camera-card" shadow="never"><div class="card-title compact"><div><span class="eyebrow">INPUTS / {{ activeCameras.length }} CAMERAS</span><h3>摄像头画面</h3></div><el-button text @click="refreshStatus(true)">↻ 刷新</el-button></div><div class="video-preview"><div class="scan-line"></div><span class="video-symbol">◉</span><strong>实时视频流</strong><small>{{ isRunning ? '正在接收检测画面' : '等待巡检任务启动' }}</small></div><div class="camera-grid"><div v-for="camera in cameras" :key="camera.id" class="camera-tile" :class="{ active: activeCameras.some((item) => item.id === camera.id) }"><span class="camera-icon">⌁</span><div><strong>{{ camera.name }}</strong><small>{{ activeCameras.some((item) => item.id === camera.id) ? '已启用' : '待机' }}</small></div><em>{{ activeCameras.some((item) => item.id === camera.id) ? 'ON' : 'OFF' }}</em></div></div></el-card>

      <el-card class="results-card" shadow="never"><div class="card-title compact"><div><span class="eyebrow">RESULTS / {{ detections.length }}</span><h3>检测结果</h3></div><el-button type="primary" plain :loading="resultsLoading" @click="refreshDetections(true)">加载结果</el-button></div><div v-if="selectedDetection" class="result-focus"><div class="result-image"><img v-if="imageUrl" :src="imageUrl" alt="检测证据" /><div v-else><span>▧</span><small>证据图片预览</small></div></div><div class="result-focus-info"><el-tag type="danger" effect="light">{{ labelOf(selectedDetection) }}</el-tag><strong>{{ selectedDetection.cameraId }} · #{{ selectedDetection.frameId }}</strong><span>置信度 {{ Math.round((selectedDetection.detections?.[0]?.confidence || 0) * 100) || '--' }}%</span></div></div><el-empty v-else description="暂无检测结果" :image-size="70" /><div class="result-list"><button v-for="item in detections" :key="item.detectionId" class="result-row" :class="{ selected: selectedDetection?.detectionId === item.detectionId }" @click="selectDetection(item)"><div><strong>{{ labelOf(item) }}</strong><small>{{ item.cameraId }} · {{ formatTime(item.capturedAt) }}</small></div><span>{{ item.latencyMs ?? '--' }} ms</span></button></div></el-card></div>
  </div>
</template>

<style scoped>
.detection-page { max-width: 1500px; margin:0 auto; }.section-heading,.card-title { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }.section-heading { margin-bottom:22px; }.eyebrow { color:#409eff; font-size:10px; font-weight:800; letter-spacing:1.7px; }.section-heading h2 { margin:6px 0 3px; font-size:26px; }.section-heading p { margin:0; color:var(--muted); font-size:13px; }.card-title h3 { margin:5px 0 0; font-size:18px; }.config-card,.camera-card,.results-card { border:1px solid var(--line); border-radius:12px; }.config-card :deep(.el-card__body),.camera-card :deep(.el-card__body),.results-card :deep(.el-card__body) { padding:22px; }.inspection-form { display:grid; grid-template-columns:1.35fr 1fr 1fr auto; gap:18px; align-items:end; margin-top:18px; }.inspection-form :deep(.el-form-item) { margin-bottom:0; }.form-actions { display:flex; gap:9px; padding-bottom:1px; }.form-actions .el-button { height:40px; margin:0; }.stats-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin:16px 0; }.stat-card { padding:17px 19px; border:1px solid var(--line); border-radius:11px; background:var(--panel); }.stat-card span,.stat-card small { display:block; color:var(--muted); font-size:11px; }.stat-card strong { display:block; margin:6px 0 1px; font-size:24px; }.stat-card strong.accent { color:var(--primary); }.workspace-grid { display:grid; grid-template-columns:minmax(0,1.5fr) minmax(320px,.8fr); gap:16px; }.compact { align-items:center; }.video-preview { position:relative; height:250px; display:flex; flex-direction:column; align-items:center; justify-content:center; overflow:hidden; border-radius:9px; background:linear-gradient(145deg,#f5f7fa,#eef1f6); color:#606266; }.video-preview strong { margin-top:9px; font-size:22px; letter-spacing:1px; }.video-preview small { color:#909399; font-size:11px; }.video-symbol { display:grid; place-items:center; width:52px; height:52px; border:1px solid #a0cfff; border-radius:50%; color:#409eff; font-size:24px; }.scan-line { position:absolute; left:0; right:0; top:48%; height:1px; background:linear-gradient(90deg,transparent,#409eff,transparent); opacity:.45; }.camera-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:9px; margin-top:12px; }.camera-tile { display:flex; align-items:center; gap:8px; min-width:0; padding:10px; border:1px solid var(--line); border-radius:8px; background:#fafcfb; }.camera-tile.active { border-color:#b3d8ff; background:#ecf5ff; }.camera-icon { display:grid; place-items:center; width:27px; height:27px; flex:none; border-radius:6px; background:#ecf5ff; color:#409eff; font-size:17px; }.camera-tile strong,.camera-tile small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.camera-tile strong { font-size:11px; }.camera-tile small { margin-top:2px; color:var(--muted); font-size:10px; }.camera-tile em { margin-left:auto; color:#909399; font-size:9px; font-style:normal; }.result-focus { display:flex; gap:12px; margin:18px 0 13px; padding:10px; border-radius:9px; background:#f5f7fa; }.result-image { width:115px; height:90px; flex:none; display:grid; place-items:center; overflow:hidden; border-radius:6px; background:#e4e7ed; color:#909399; }.result-image img { width:100%; height:100%; object-fit:cover; }.result-image div { text-align:center; }.result-image span { display:block; font-size:26px; }.result-image small { font-size:10px; }.result-focus-info { display:flex; flex-direction:column; align-items:flex-start; gap:8px; padding:5px 0; }.result-focus-info strong { font-size:12px; }.result-focus-info span { color:var(--muted); font-size:11px; }.result-list { display:flex; flex-direction:column; gap:7px; max-height:292px; overflow:auto; }.result-row { display:flex; align-items:center; justify-content:space-between; gap:10px; width:100%; padding:10px 11px; border:1px solid transparent; border-radius:8px; background:#f5f7fa; color:var(--ink); text-align:left; cursor:pointer; }.result-row:hover,.result-row.selected { border-color:#b3d8ff; background:#ecf5ff; }.result-row strong,.result-row small { display:block; }.result-row strong { font-size:12px; }.result-row small { margin-top:3px; color:var(--muted); font-size:10px; }.result-row>span { color:var(--muted); font-size:10px; white-space:nowrap; }
@media (max-width:1100px) { .inspection-form { grid-template-columns:repeat(2,1fr); }.form-actions { grid-column:1/-1; }.workspace-grid { grid-template-columns:1fr; } }
@media (max-width:650px) { .section-heading h2 { font-size:22px; }.stats-grid { grid-template-columns:repeat(2,1fr); }.inspection-form { grid-template-columns:1fr; }.camera-grid { grid-template-columns:repeat(2,1fr); }.form-actions { grid-column:auto; }.header-meta { display:none; } }
</style>

