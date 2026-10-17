<script setup>
import { onMounted, ref } from 'vue'
import { useCameraStream } from '@/composables/useCameraStream'
import { getInspectionCameraUrl } from '@/api/inspection'

const props = defineProps({ taskRunId: { type: String, required: true }, cameraId: { type: String, required: true } })
const canvas = ref(null)
const detections = []
const stream = useCameraStream({
  url: () => getInspectionCameraUrl(props.taskRunId, props.cameraId),
  onPaint(ctx, pts, width, height) {
    let best = null
    let delta = 500
    for (const record of detections) {
      const distance = Math.abs(record.pts - pts)
      if (distance < delta) { best = record; delta = distance }
    }
    if (!best) return
    ctx.lineWidth = Math.max(2, width / 600)
    ctx.font = Math.max(14, width / 70) + 'px sans-serif'
    for (const box of best.detections || []) {
      if (!Array.isArray(box.bbox_xyxy)) continue
      const [x1, y1, x2, y2] = box.bbox_xyxy
      const sx = width / best.w, sy = height / best.h
      ctx.strokeStyle = '#4ade80'
      ctx.fillStyle = '#4ade80'
      ctx.strokeRect(x1 * sx, y1 * sy, (x2 - x1) * sx, (y2 - y1) * sy)
      ctx.fillText((box.label || '') + ' ' + Math.round(box.confidence * 100) + '%', x1 * sx, Math.max(18, y1 * sy - 5))
    }
  }
})
stream.onMessage(message => {
  if (message.t !== 'det') return
  detections.push(message)
  if (detections.length > 100) detections.shift()
})
onMounted(() => stream.attach(canvas.value))
</script>

<template>
  <div class="inspection-preview">
    <canvas ref="canvas" />
    <div class="preview-status">
      <span>{{ cameraId }}</span>
      <span>{{ stream.statusText.value }}</span>
    </div>
  </div>
</template>

<style scoped>
.inspection-preview { position: relative; background: #0c1420; border-radius: 8px; overflow: hidden; aspect-ratio: 16 / 9; }
canvas { width: 100%; height: 100%; object-fit: contain; display: block; }
.preview-status { position: absolute; inset: auto 0 0; display: flex; justify-content: space-between; gap: 12px; padding: 8px 12px; color: white; background: #0009; font-size: 12px; }
</style>
