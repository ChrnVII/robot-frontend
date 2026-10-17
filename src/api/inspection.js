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

export function getInspectionFiles(taskRunId) {
  return request({ url: '/api/v1/inspections/' + encodeURIComponent(taskRunId) + '/files', method: 'get' })
}

export async function downloadInspectionFile(taskRunId, name) {
  const response = await request({ url: '/api/v1/inspections/' + encodeURIComponent(taskRunId) + '/files/' + encodeURIComponent(name),
    method: 'get', responseType: 'blob', timeout: 0 })
  const url = URL.createObjectURL(response.data)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
