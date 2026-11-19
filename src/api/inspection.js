import request from '@/utils/request'
import { createId, unwrap } from './envelope'

// 后端统一返回 { code, message, data, traceId, timestamp }，解包统一走 envelope 的工具。

function serverBaseUrl() {
  return String(import.meta.env.VITE_SERVER_URL || '').replace(/\/$/, '')
}

function wsBaseUrl() {
  const base = serverBaseUrl() || (typeof window !== 'undefined' ? window.location.origin : '')
  return base.replace(/^http/, 'ws')
}

/** 启动热应激巡检：mode 为 single / four / eight，durationSeconds 为 0 表示持续运行。 */
export function startInspection(data) {
  return request({
    url: '/api/v1/inspections',
    method: 'post',
    data
  })
}

export function stopInspection(taskRunId) {
  return request({
    url: `/api/v1/inspections/${encodeURIComponent(taskRunId)}/stop`,
    method: 'post'
  })
}

export function getInspectionStatus(taskRunId) {
  return request({
    url: `/api/v1/inspections/${encodeURIComponent(taskRunId)}`,
    method: 'get'
  })
}

/** 每路视频独立解码，使用与球形摄像头相同的二进制帧协议。 */
export function getInspectionCameraUrl(taskRunId, cameraId) {
  const path = '/ws/inspections/' + encodeURIComponent(taskRunId) + '/cameras/' + encodeURIComponent(cameraId)
  const token = localStorage.getItem('access_token')
  return wsBaseUrl() + path + (token ? '?accessToken=' + encodeURIComponent(token) : '')
}

/** 任务状态推送（与 GET /inspections/{id} 同一份 status，省掉轮询）。 */
export function getInspectionStatusUrl(taskRunId) {
  const path = '/ws/inspections/' + encodeURIComponent(taskRunId)
  const token = localStorage.getItem('access_token')
  return wsBaseUrl() + path + (token ? '?accessToken=' + encodeURIComponent(token) : '')
}

/** 机器人和全部设备摘要，页面用它读取 8 路摄像头和麦克风的真实状态。 */
export function getRobotState() {
  return request({
    url: '/api/v1/robot/state',
    method: 'get'
  })
}

/** 媒体采集：摄像头抓图、热成像和麦克风录音走同一个接口。 */
export function captureMedia(data) {
  return request({
    url: '/api/v1/media/captures',
    method: 'post',
    data,
    // 录音默认 10 秒 + 编码/落库，必须放宽前端默认的 10s 超时。
    timeout: 60000
  })
}

/** 运行配置：虚拟环境、模型权重、配置文件和结果目录由后端配置接口提供。 */
export function getInspectionConfig(params) {
  return request({
    url: '/api/v1/config',
    method: 'get',
    params
  })
}

/**
 * 当前正在跑的检测/采集任务（没有则 data.state === 'idle'）。
 *
 * inspection-worker 同时只允许一个任务：前端靠它显示"正在跑什么"，并拦截第二个启动请求。
 * 刷新页面、换标签页都不会丢状态——状态在 worker 进程里，不在浏览器里。
 */
export function getActiveInspection() {
  return request({ url: '/api/v1/inspections/active', method: 'get' })
}

/** 任务目录内单个产物的下载地址（相对路径，如 cam01/video.mkv）。 */
export function inspectionFileUrl(taskRunId, path) {
  const base = String(import.meta.env.VITE_SERVER_URL || '').replace(/\/$/, '')
  return `${base}/api/v1/inspections/${encodeURIComponent(taskRunId)}/file?path=${encodeURIComponent(path)}`
}

/**
 * 以 Blob 方式取任务产物。
 * 生产开启鉴权后 `<video src>`/`<a href>` 带不上 Authorization 头，必须走 axios。
 */
export async function fetchInspectionFileBlob(taskRunId, path) {
  const response = await request({
    url: `/api/v1/inspections/${encodeURIComponent(taskRunId)}/file`,
    method: 'get',
    params: { path },
    responseType: 'blob',
    timeout: 120000
  })
  return response.data
}

/**
 * MKV 预览地址：后端只转封装不重编码，返回浏览器可播的 MP4（支持 Range）。
 * 只有受管目录（cams / adhoc / missions / dome-cam）内的文件允许预览。
 */
export async function fetchPreviewBlob(absolutePath) {
  const response = await request({
    url: '/api/v1/media/preview',
    method: 'get',
    params: { path: absolutePath },
    responseType: 'blob',
    // 首次预览要等后端转封装，给足时间；命中缓存时是毫秒级。
    timeout: 180000
  })
  return response.data
}

function acquireControlLease(data) {
  return request({
    url: '/api/v1/control/leases',
    method: 'post',
    data
  })
}

function sendDeviceCommand(data) {
  return request({
    url: '/api/v1/devices/commands',
    method: 'post',
    data
  })
}

/** 急停：不依赖普通控制租约，由 robot-core 抢占控制权并停止运动/升降。 */
function emergencyStop(data) {
  return request({
    url: '/api/v1/emergency-stop',
    method: 'post',
    data
  })
}

// 设备命令必须带未过期租约；租约在模块作用域缓存，409 时自动作废重取。
let leaseId = ''

async function ensureLease(mode = 'manual_local') {
  if (leaseId) return leaseId
  const lease = unwrap(await acquireControlLease({ holder: import.meta.env.VITE_CONTROL_HOLDER || 'inspection-console', mode }), {})
  leaseId = lease?.leaseId || lease?.id || ''
  if (!leaseId) throw new Error('后端未返回控制租约 leaseId')
  return leaseId
}

async function dispatchDeviceCommand(target, action, payload = {}) {
  const activeLease = await ensureLease()
  try {
    return await sendDeviceCommand({
      target,
      action,
      issuer: import.meta.env.VITE_CONTROL_HOLDER || 'inspection-console',
      leaseId: activeLease,
      idempotencyKey: createId('ui-command'),
      traceId: createId('trace'),
      payload
    })
  } catch (error) {
    if (error?.response?.status === 409) leaseId = ''
    throw error
  }
}

/**
 * 检测升降：动作名沿用设备命令协议（lift/up、lift/down），
 * 具体可用动作最终以设备能力接口返回值为准，后端拒绝时原样上报错误。
 */
export function moveInspectionLift(action) {
  return dispatchDeviceCommand('lift', action, { reason: 'inspection_alignment' })
}

/** 检测升降停止使用急停通道：robot-core 会同时停止运动和升降设备。 */
export function stopInspectionLift() {
  return emergencyStop({ traceId: createId('trace-estop'), reason: 'operator_pressed_lift_stop' })
}

/** 在后端所在主机的系统文件管理器中打开本次任务目录。 */
export function openInspectionFolder(taskRunId) {
  return request({ url: '/api/v1/inspections/' + encodeURIComponent(taskRunId) + '/open', method: 'post' })
}
