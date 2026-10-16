// 球形摄像头低延迟画面：WebSocket 收 Annex-B → WebCodecs 硬解 → canvas。
//
// 参照独立 demo（单码流 RTSP → Annex-B 透传 → WebCodecs），把播放端逻辑收进
// composable，页面只负责挂 canvas 与显示指标。三处关键取舍：
//
//   1. 只保留最新一帧：解码输出用 pendingFrame 覆盖，rAF 里画完立刻 close，
//      绝不排队，避免「越播越慢」；
//   2. 积压即丢 + 关键帧重同步：decodeQueueSize 超过阈值就丢到下一个关键帧，
//      解码器出错则标记 needReset，等下一个关键帧重建；
//   3. 不可用时如实降级：非安全上下文 / 无 WebCodecs / 后端未启用时 mode 变为
//      'fallback'，由页面回退到已有的 JPEG 轮询，画面始终有东西。
import { computed, onBeforeUnmount, reactive, readonly, ref } from 'vue'
import {
  FRAME_FLAG,
  FRAME_HEADER_LENGTH,
  cameraStreamBlockReason,
  getCameraPreviewUrl
} from '@/api/cameraStream'

const RECONNECT_MIN_DELAY = 1000
const RECONNECT_MAX_DELAY = 15000
const MAX_DECODE_QUEUE = 8        // 解码队列积压阈值，超过只收关键帧

export function useCameraStream() {
  const mode = ref('idle')          // idle | webcodecs | fallback
  const phase = ref('idle')         // idle | connecting | waiting | live | error | stopped
  const errorText = ref('')
  const blockReason = ref('')
  const codec = ref('')
  const resolution = reactive({ width: 0, height: 0 })
  const metrics = reactive({
    fps: 0,
    latencyMs: null,
    droppedFrames: 0,
    decodedFrames: 0,
    receivedFrames: 0,
    receivedKeyframes: 0,
    decodeQueue: 0
  })

  let socket = null
  let decoder = null
  let videoContext = null
  let videoCanvas = null
  let rafId = null
  let framePending = null
  let needReset = true
  let lastFrameAt = 0
  let disposed = false
  let reconnectAttempts = 0
  let reconnectTimer = null
  let timelineEpoch = 0
  let hardwarePreference = 'prefer-hardware'
  let hardwareFailures = 0
  let lastSampleAt = 0
  let lastSampleFrames = 0
  let onServerMessage = null

  const statusText = computed(() => {
    if (mode.value === 'fallback') return blockReason.value || '已回退到 JPEG 轮询'
    switch (phase.value) {
      case 'connecting': return '正在连接实时画面…'
      case 'waiting': return '等待摄像头画面…'
      case 'live': return `实时画面 · ${codec.value || '解码中'}`
      case 'error': return errorText.value || '实时画面异常'
      case 'stopped': return '实时画面已停止'
      default: return '实时画面待启用'
    }
  })

  const statusType = computed(() => {
    if (mode.value === 'fallback') return 'warning'
    if (phase.value === 'live') return 'success'
    if (phase.value === 'error') return 'danger'
    return 'info'
  })

  /* ------------------------------ 解码器 ------------------------------ */

  function makeDecoder() {
    if (!codec.value) return
    const reason = cameraStreamBlockReason()
    if (reason) {
      blockReason.value = reason
      return
    }
    if (decoder) {
      try { decoder.close() } catch { /* 已经关闭 */ }
    }
    errorText.value = ''
    try {
      decoder = new VideoDecoder({ output: onDecodedFrame, error: onDecoderError })
      // Annex-B 输入：不传 description，参数集随关键帧带内传输。
      // optimizeForLatency 让解码器最小化输出前的排队帧数。
      decoder.configure({
        codec: codec.value,
        optimizeForLatency: true,
        hardwareAcceleration: hardwarePreference
      })
      needReset = true
    } catch (reason) { onDecoderError(reason) }
  }

  function onDecoderError(event) {
    errorText.value = (event && event.message) ? event.message : String(event)
    console.error('[camera-stream] decoder error', errorText.value)
    try { decoder?.close() } catch { /* 已关闭 */ }
    decoder = null
    needReset = true                       // 等下一个关键帧重建解码器
    hardwareFailures += 1
    if (hardwareFailures >= 2 && hardwarePreference === 'prefer-hardware') {
      hardwarePreference = 'no-preference'  // 硬解可能是元凶，降到默认策略再试
    }
    phase.value = 'error'
  }

  function onDecodedFrame(frame) {
    // 只保留最新一帧：旧的立刻释放，绝不排队
    if (disposed) { frame.close(); return }
    if (framePending) framePending.close()
    framePending = frame
  }

  /* ------------------------------ 渲染循环 ------------------------------ */

  function paint() {
    if (!videoContext || !videoCanvas) return
    if (framePending) {
      const frame = framePending
      framePending = null
      const width = frame.displayWidth
      const height = frame.displayHeight
      if (width && height && (videoCanvas.width !== width || videoCanvas.height !== height)) {
        videoCanvas.width = width
        videoCanvas.height = height
      }
      videoContext.drawImage(frame, 0, 0)

      const pts = Math.round(frame.timestamp / 1000)   // WebCodecs 用微秒，链路上是毫秒
      frame.close()

      lastFrameAt = performance.now()
      resolution.width = width
      resolution.height = height
      metrics.decodedFrames += 1
      if (timelineEpoch) {
        const latency = Date.now() - (timelineEpoch + pts)
        metrics.latencyMs = latency >= 0 && latency < 60000 ? latency : null
      }
      if (phase.value !== 'live') phase.value = 'live'
    }

    const now = performance.now()
    if (phase.value === 'live' && now - lastFrameAt > 5000) {
      phase.value = 'waiting'
      metrics.latencyMs = null
    }
    if (now - lastSampleAt >= 1000) {
      const elapsed = now - lastSampleAt || 1000
      metrics.fps = (metrics.decodedFrames - lastSampleFrames) * 1000 / elapsed
      lastSampleFrames = metrics.decodedFrames
      lastSampleAt = now
      metrics.decodeQueue = decoder ? decoder.decodeQueueSize : 0
    }
  }

  function renderLoop() {
    if (disposed) return
    rafId = window.requestAnimationFrame(() => {
      paint()
      renderLoop()
    })
  }

  /* ------------------------------ WebSocket ------------------------------ */

  function scheduleReconnect() {
    if (disposed || reconnectTimer) return
    const delay = Math.min(RECONNECT_MIN_DELAY * 2 ** reconnectAttempts, RECONNECT_MAX_DELAY)
    reconnectAttempts += 1
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  function handleText(raw) {
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (message.t === 'config') {
      timelineEpoch = Number(message.t0) || 0
      if (message.size && message.size.length === 2) {
        resolution.width = Number(message.size[0]) || 0
        resolution.height = Number(message.size[1]) || 0
      }
      if (message.codec && message.codec !== codec.value) {
        codec.value = String(message.codec)
        makeDecoder()
      }
      return
    }
    if (message.t === 'error') {
      // 后端未启用低延迟预览：如实降级，由页面回退到 JPEG 轮询
      blockReason.value = message.message || '后端未启用低延迟预览'
      mode.value = 'fallback'
      phase.value = 'stopped'
      closeSocket()
      return
    }
    if (message.t === 'stop') {
      phase.value = 'stopped'
      closeSocket()
      scheduleReconnect()
      return
    }
    // 其余消息（如录像状态变化）交给页面处理
    onServerMessage?.(message)
  }

  function handleBinary(buffer) {
    if (buffer.byteLength <= FRAME_HEADER_LENGTH) return
    const view = new DataView(buffer)
    const flags = view.getUint8(0)
    const pts = view.getUint32(1, true)
    const payload = new Uint8Array(buffer, FRAME_HEADER_LENGTH)

    metrics.receivedFrames += 1
    if (flags & FRAME_FLAG.KEY) metrics.receivedKeyframes += 1
    if (flags & FRAME_FLAG.CONFIG) return

    const key = Boolean(flags & FRAME_FLAG.KEY)
    if (flags & FRAME_FLAG.RESET || decoder?.decodeQueueSize > MAX_DECODE_QUEUE) {
      needReset = true
      metrics.droppedFrames += 1
    }
    if (needReset || !decoder) {
      if (!key) return
      makeDecoder() // reset() 后必须重新 configure，不能直接 decode。
      if (!decoder || decoder.state !== 'configured') return
      needReset = false
    }

    try {
      decoder.decode(new EncodedVideoChunk({
        type: (flags & FRAME_FLAG.KEY) ? 'key' : 'delta',
        timestamp: pts * 1000,                         // WebCodecs 要微秒
        data: payload
      }))
    } catch (reason) {
      console.error('[camera-stream] decode failed', reason)
      needReset = true
    }
  }

  function closeSocket() {
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (!socket) return
    const current = socket
    socket = null
    current.onopen = null
    current.onmessage = null
    current.onerror = null
    current.onclose = null
    try { current.close() } catch { /* 已关闭 */ }
  }

  function connect() {
    if (disposed || mode.value !== 'webcodecs') return
    const url = getCameraPreviewUrl()
    if (!url) {
      blockReason.value = '未配置后端地址'
      mode.value = 'fallback'
      return
    }
    closeSocket()
    needReset = true
    if (framePending) { framePending.close(); framePending = null }
    phase.value = 'connecting'
    try {
      socket = new WebSocket(url)
    } catch (reason) {
      errorText.value = String(reason)
      phase.value = 'error'
      scheduleReconnect()
      return
    }
    socket.binaryType = 'arraybuffer'
    socket.onopen = () => {
      reconnectAttempts = 0
      phase.value = 'waiting'
    }
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') handleText(event.data)
      else if (event.data instanceof ArrayBuffer) handleBinary(event.data)
    }
    socket.onerror = () => {
      if (mode.value !== 'fallback') {
        errorText.value = '实时画面连接错误'
      }
    }
    socket.onclose = () => {
      socket = null
      if (disposed || mode.value === 'fallback') return
      phase.value = 'waiting'
      needReset = true
      metrics.latencyMs = null
      scheduleReconnect()
    }
  }

  /* ------------------------------ 对外接口 ------------------------------ */

  /**
   * 绑定 canvas 并开始播放（幂等）。
   *
   * 页面把 canvas 放在 AsyncSection 插槽里，加载态切换会把它整块卸载重挂；
   * 因此这里必须允许重复调用：画布换了只重新取上下文，已建立的 WS/解码器不动。
   * WebCodecs 不可用时直接进入降级模式，由页面回退到 JPEG 轮询。
   */
  function attach(videoElement) {
    if (!videoElement) return          // 插槽尚未渲染，等下一次触发
    videoCanvas = videoElement
    videoContext = videoCanvas.getContext('2d', { alpha: false, desynchronized: true })

    if (mode.value === 'webcodecs') {
      if (rafId === null) {
        lastSampleAt = performance.now()
        renderLoop()
      }
      return
    }

    const reason = cameraStreamBlockReason()
    if (reason) {
      blockReason.value = reason
      mode.value = 'fallback'
      phase.value = 'stopped'
      return
    }
    mode.value = 'webcodecs'
    phase.value = 'connecting'
    lastSampleAt = performance.now()
    renderLoop()
    connect()
  }

  function detach() {
    closeSocket()
    if (framePending) {
      try { framePending.close() } catch { /* 已释放 */ }
      framePending = null
    }
    if (decoder) {
      try { decoder.close() } catch { /* 已关闭 */ }
      decoder = null
    }
    if (rafId) {
      window.cancelAnimationFrame(rafId)
      rafId = null
    }
    videoContext = null
    videoCanvas = null
  }

  function dispose() {
    disposed = true
    detach()
  }

  /** 手动重连（页面「刷新」按钮用）；降级模式下为空操作。 */
  function reconnect() {
    if (mode.value !== 'webcodecs') return
    reconnectAttempts = 0
    connect()
  }

  /** 注册「非画面类」服务端消息的处理器（如录像状态变化）。 */
  function onMessage(handler) {
    onServerMessage = typeof handler === 'function' ? handler : null
  }

  onBeforeUnmount(dispose)

  return {
    mode,
    phase,
    statusText,
    statusType,
    errorText: readonly(errorText),
    blockReason: readonly(blockReason),
    codec: readonly(codec),
    resolution,
    metrics,
    attach,
    detach,
    dispose,
    reconnect,
    onMessage
  }
}
