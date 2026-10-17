// 球形摄像头低延迟实时画面：WebSocket 二进制通道 + 浏览器 WebCodecs。
//
// 帧协议与后端 app/video 严格一致：
//   文本 JSON  {"t":"config","codec":"avc1.64001F","t0":<epoch_ms>,"size":[w,h]}
//              {"t":"record", ...}                        录像状态变化
//              {"t":"error","code":"stream_disabled",...} 未启用（收到后应回退）
//              {"t":"stop","code":1012}                   服务端主动停止
//   二进制帧   <B I I> flags(1) + ptsMs(4) + seq(4) + Annex-B 载荷
//
// 与既有 /api/v1/cam/stream（1fps JPEG 轮询）的分工：
//   WebCodecs 可用且后端已启用 → 走本模块；否则由调用方回退到 JPEG 轮询。
import request from '@/utils/request'

export const FRAME_FLAG = {
  KEY: 0x01,    // 关键帧，可在收到时重建解码器
  CONFIG: 0x02, // 配置帧（预留）
  RESET: 0x04   // 服务端丢过帧，必须先 reset 解码器
}

/** 二进制帧头长度：flags(1) + ptsMs(4) + seq(4)。 */
export const FRAME_HEADER_LENGTH = 9

function serverBaseUrl() {
  const configured = import.meta.env.VITE_SERVER_URL
  const base = configured ? String(configured) : (typeof window !== 'undefined' ? window.location.origin : '')
  return base.replace(/\/$/, '')
}

function websocketUrl(path) {
  const base = serverBaseUrl().replace(/^http/i, (scheme) => (scheme.toLowerCase() === 'https' ? 'wss' : 'ws'))
  const url = `${base}${path}`
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('access_token') : ''
  // 浏览器 WebSocket 无法设置 Authorization 头，令牌只能走查询参数
  // （后端 app.api.ws.routes._authorize 同时接受 accessToken 与 Authorization）。
  return token ? `${url}${url.includes('?') ? '&' : '?'}accessToken=${encodeURIComponent(token)}` : url
}

/** 球形摄像头低延迟预览的 WebSocket 地址。 */
export function getCameraPreviewUrl() {
  if (!serverBaseUrl() && typeof window === 'undefined') return ''
  return websocketUrl('/ws/camera/preview')
}

/** 低延迟预览诊断快照（是否启用 / 编码 / 分辨率 / 订阅者 / 录像状态）。 */
export function getCameraStreamStatus() {
  return request({ url: '/api/v1/cam/stream/status', method: 'get' })
}

/* ------------------------------ 录像 ------------------------------ */

/** 录像分段列表（新→旧）。响应含 { rows, dir }，dir 是后端配置的绝对目录。 */
export function listRecordings() {
  return request({ url: '/api/v1/cam/recordings', method: 'get' })
}

/**
 * 让**后端主机**打开录像目录（资源管理器 / Finder）。
 * 浏览器不允许 http 页面跳 file://，所以这一步只能由服务端执行；
 * 返回 { opened, dir, detail? }，opened=false 时调用方退回「复制路径」。
 */
export function openRecordingsFolder() {
  return request({ url: '/api/v1/cam/recordings/open', method: 'post' })
}

/** 开始 / 停止录像；停止时排空写盘队列并立即收尾。 */
export function controlRecording(action) {
  return request({ url: '/api/v1/cam/recordings', method: 'post', data: { action } })
}

/** 使用统一请求实例携带 Bearer 令牌下载。 */
export async function downloadRecording(name) {
  const response = await request({
    url: `/api/v1/cam/recordings/${encodeURIComponent(name)}`,
    method: 'get', responseType: 'blob', timeout: 120000
  })
  const url = URL.createObjectURL(response.data)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 删除某一段录像。 */
export function deleteRecording(name) {
  return request({ url: `/api/v1/cam/recordings/${encodeURIComponent(name)}`, method: 'delete' })
}

/** 浏览器是否具备解码条件：安全上下文（HTTPS/localhost）+ WebCodecs。 */
export function cameraStreamBlockReason() {
  if (typeof window === 'undefined') return '当前环境不支持浏览器解码'
  if (typeof window.VideoDecoder !== 'function') {
    return '当前浏览器不支持 WebCodecs，请使用较新版 Chrome / Edge'
  }
  if (!window.isSecureContext) {
    return '页面不是安全上下文，WebCodecs 已被浏览器禁用：请用 HTTPS 或 localhost 访问'
  }
  return ''
}

/** 快照降级仍通过请求实例鉴权，不把令牌暴露在 URL 中。 */
export function getCameraPreviewFrame() {
  return request({ url: '/api/v1/cam/stream', method: 'get',
    params: { frame: Date.now() }, responseType: 'blob' })
}
