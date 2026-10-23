<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useCameraStream } from '@/composables/useCameraStream'
import { getInspectionCameraUrl } from '@/api/inspection'

const props = defineProps({ taskRunId: { type: String, required: true }, cameraId: { type: String, required: true } })
const canvas = ref(null)
const overlay = ref(null)
// 推理耗时与视频帧率独立：从结果到达时开始保留，不能用源帧的年龄清除。
const DETECTION_HOLD_MS = 3000
let currentDetection = null
let latestPts = -Infinity
let clearTimer = null

function clearOverlay() {
  if (clearTimer !== null) window.clearTimeout(clearTimer)
  clearTimer = null
  currentDetection = null
  const layer = overlay.value
  layer?.getContext('2d')?.clearRect(0, 0, layer.width, layer.height)
}

function resetOverlay() {
  clearOverlay()
  latestPts = -Infinity
}

function drawOverlay(width = canvas.value?.width, height = canvas.value?.height) {
  const layer = overlay.value
  if (!layer || !width || !height) return
  if (layer.width !== width || layer.height !== height) {
    layer.width = width
    layer.height = height
  }
  const ctx = layer.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, width, height)
  const record = currentDetection
  if (!record || !(record.w > 0 && record.h > 0)) return
  ctx.lineWidth = Math.max(2, width / 600)
  ctx.font = Math.max(14, width / 70) + 'px sans-serif'
  for (const box of record.detections || []) {
    if (!Array.isArray(box.bbox_xyxy) || box.bbox_xyxy.length !== 4 || !box.bbox_xyxy.every(Number.isFinite)) continue
    const [x1, y1, x2, y2] = box.bbox_xyxy
    const sx = width / record.w, sy = height / record.h
    ctx.strokeStyle = '#4ade80'
    ctx.fillStyle = '#4ade80'
    ctx.strokeRect(x1 * sx, y1 * sy, (x2 - x1) * sx, (y2 - y1) * sy)
    ctx.fillText((box.label || '') + ' ' + Math.round(box.confidence * 100) + '%', x1 * sx, Math.max(18, y1 * sy - 5))
  }
}

const stream = useCameraStream({
  url: () => getInspectionCameraUrl(props.taskRunId, props.cameraId),
  onPaint(_ctx, _pts, width, height) {
    drawOverlay(width, height)
  }
})
stream.onMessage(message => {
  if (message.t !== 'det' || !Number.isFinite(message.pts) || message.pts <= latestPts) return
  latestPts = message.pts
  clearOverlay()
  currentDetection = message
  drawOverlay()
  // 即使视频停止刷新，也要清除过期框；新空结果会立即清除上一轮目标。
  clearTimer = window.setTimeout(clearOverlay, DETECTION_HOLD_MS)
})
watch(stream.phase, phase => {
  if (phase !== 'live') resetOverlay()
})
onMounted(() => stream.attach(canvas.value))
onBeforeUnmount(resetOverlay)
</script>

<template>
  <div class="inspection-preview">
    <canvas ref="canvas" />
    <canvas ref="overlay" class="detection-overlay" />
    <div class="preview-status">
      <span>{{ cameraId }} · 子码流预览</span>
      <span>{{ stream.statusText.value }}</span>
    </div>
  </div>
</template>

<style scoped>
.inspection-preview { position: relative; background: #0c1420; border-radius: 8px; overflow: hidden; aspect-ratio: 16 / 9; }
canvas { width: 100%; height: 100%; object-fit: contain; display: block; }
.detection-overlay { position: absolute; inset: 0; pointer-events: none; }
.preview-status { position: absolute; inset: auto 0 0; display: flex; justify-content: space-between; gap: 12px; padding: 8px 12px; color: white; background: #0009; font-size: 12px; }
</style>
