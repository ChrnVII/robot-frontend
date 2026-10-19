import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import test from 'node:test'

const source = readFileSync(new URL('../src/components/InspectionPreview.vue', import.meta.url), 'utf8')
  .match(/<script setup>([\s\S]*?)<\/script>/)[1]
  .replace(/^import .* from .*$/gm, '')

function preview() {
  let options, message, phaseChanged, unmount, visibleBoxes = 0, now = 0
  const timers = new Map()
  let nextTimer = 0
  const ctx = {
    clearRect() { visibleBoxes = 0 },
    strokeRect() { visibleBoxes++ },
    fillText() {}
  }
  const sandbox = vm.createContext({
    Number, Infinity,
    defineProps: () => ({ taskRunId: 'run', cameraId: 'cam01' }),
    ref: () => ({ value: { width: 640, height: 480, getContext: () => ctx } }),
    watch: (_, callback) => { phaseChanged = callback },
    onMounted() {},
    onBeforeUnmount(callback) { unmount = callback },
    useCameraStream(value) {
      options = value
      return { phase: {}, onMessage(callback) { message = callback } }
    },
    window: {
      setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id },
      clearTimeout(id) { timers.delete(id) }
    }
  })
  vm.runInContext(source, sandbox)
  return {
    send: (pts, detections = [{ bbox_xyxy: [10, 10, 100, 100], confidence: .9 }]) => message({ t: 'det', pts, w: 640, h: 480, detections }),
    paint: pts => options.onPaint({}, pts, 640, 480),
    boxes: () => visibleBoxes,
    phase: value => phaseChanged(value),
    unmount: () => unmount(),
    timers: () => timers.size,
    advance(ms) {
      now += ms
      for (const timer of [...timers.values()]) if (timer.at <= now) timer.callback()
    }
  }
}

test('late inference stays visible across video frames and renews on the next result', () => {
  const view = preview()
  view.paint(2000)
  view.send(1000) // inference arrived a second after its source frame
  assert.equal(view.boxes(), 1) // draw immediately without waiting for video
  view.advance(2500)
  view.paint(4500)
  assert.equal(view.boxes(), 1)
  view.send(4000)
  view.advance(1000)
  view.paint(5500)
  assert.equal(view.boxes(), 1)
  view.advance(2000) // expire even when video is no longer advancing
  assert.equal(view.boxes(), 0)
  view.paint(6000)
  assert.equal(view.boxes(), 0)
})

test('new empty results clear boxes and old results cannot restore them', () => {
  const view = preview()
  view.send(1000)
  view.send(2000, [])
  assert.equal(view.boxes(), 0)
  view.send(1500)
  view.paint(2100)
  assert.equal(view.boxes(), 0)
})

test('disconnect and unmount clear overlays and timers; reconnect accepts a new timeline', () => {
  const view = preview()
  view.send(1000)
  view.phase('waiting')
  assert.equal(view.boxes(), 0)
  assert.equal(view.timers(), 0)
  view.send(100)
  assert.equal(view.boxes(), 1)
  view.unmount()
  assert.equal(view.boxes(), 0)
  assert.equal(view.timers(), 0)
})
