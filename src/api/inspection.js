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

export function getDetections(taskRunId, params) {
  return request({
    url: `/api/v1/inspections/${encodeURIComponent(taskRunId)}/detections`,
    method: 'get',
    params
  })
}

/**
 * 证据图地址，前缀取 VITE_SERVER_URL。
 * imageId 形如 cam01:00000001_result.jpg，冒号属于 ID 本身，
 * 后端按解码后的值校验，所以这里保留冒号不转义。
 */
export function getInspectionImageUrl(taskRunId, imageId) {
  if (!taskRunId || !imageId) return ''
  const encoded = encodeURIComponent(imageId).replace(/%3A/gi, ':')
  return `${serverBaseUrl()}/api/v1/inspections/${encodeURIComponent(taskRunId)}/images/${encoded}`
}

/** 巡检实时流：状态、检测页和最新标注帧。 */
export function getInspectionStreamUrl(taskRunId) {
  if (!taskRunId) return ''
  return `${wsBaseUrl()}/ws/inspections/${encodeURIComponent(taskRunId)}`
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
    data
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
