// 控制类接口层：控制租约、设备命令、急停、媒体采集、摄像头与升降。
//   POST   /api/v1/control/leases                申请控制租约
//   DELETE /api/v1/control/leases/{leaseId}      释放控制租约
//   POST   /api/v1/devices/commands              统一下发设备命令
//   POST   /api/v1/emergency-stop                急停
//   POST   /api/v1/media/captures                抓图 / 录音
//   GET    /api/v1/devices/lift/state            升降设备状态
// 所有设备命令都携带未过期租约；409 时作废租约并由下一次命令重试。
import request from '@/utils/request'
import { createId, unwrap, unwrapRows } from './envelope'

const ISSUER = import.meta.env.VITE_CONTROL_HOLDER || 'robot-console'
const COMMAND_TTL_MS = 1000
let leaseId = ''
let leaseMode = ''

function finiteNumber(...values) {
  const value = values.find((item) => item !== undefined && item !== null && item !== '')
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

async function acquireLease(mode = 'manual_local') {
  const response = await request({
    url: '/api/v1/control/leases',
    method: 'post',
    data: { holder: ISSUER, mode }
  })
  const lease = unwrap(response, {})
  const id = lease?.leaseId || lease?.id || ''
  if (!id) throw new Error('后端未返回控制租约 leaseId，无法下发设备命令')
  leaseId = id
  leaseMode = mode
  return leaseId
}

export async function ensureLease(mode = 'manual_local') {
  if (leaseId && leaseMode === mode) return leaseId
  if (leaseId) await releaseControlLease('mode_changed')
  return acquireLease(mode)
}

export function releaseControlLease(reason = 'released') {
  if (!leaseId) return Promise.resolve(null)
  const current = leaseId
  leaseId = ''
  leaseMode = ''
  return request({
    url: `/api/v1/control/leases/${encodeURIComponent(current)}`,
    method: 'delete',
    params: { reason }
  })
}

/**
 * 下发统一设备命令。
 * @param {string} target motion / lift / light / camera / battery 等。
 * @param {string} action 设备能力允许的动作名。
 * @param {object} payload 动作参数。
 * @param {string} mode 控制模式，默认 manual_local。
 */
export async function sendDeviceCommand(target, action, payload = {}, mode = 'manual_local') {
  const activeLease = await ensureLease(mode)
  const now = Date.now()
  try {
    return await request({
      url: '/api/v1/devices/commands',
      method: 'post',
      data: {
        target,
        action,
        issuer: ISSUER,
        leaseId: activeLease,
        idempotencyKey: createId('ui-command'),
        traceId: createId('trace'),
        payload,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + COMMAND_TTL_MS).toISOString()
      }
    })
  } catch (error) {
    if (Number(error?.status ?? error?.response?.status) === 409) {
      leaseId = ''
      leaseMode = ''
    }
    throw error
  }
}

/** 急停不依赖普通控制租约：robot-core 会抢占控制权并停止运动/升降。 */
export function emergencyStop(reason = 'operator_pressed_stop') {
  return request({
    url: '/api/v1/emergency-stop',
    method: 'post',
    data: { traceId: createId('trace-estop'), reason }
  })
}

/* ------------------------------ 升降 ------------------------------ */

function normalizeLiftState(device = {}) {
  const values = device.values && typeof device.values === 'object' ? device.values : device
  return {
    deviceId: device.deviceId || 'lift',
    health: device.health,
    quality: device.quality,
    sampledAt: device.sampledAt,
    source: device.source,
    height: finiteNumber(values.height, values.position, values.positionM),
    faultCode: finiteNumber(values.faultCode, values.rawFaultCode, device.rawFaultCode),
    enabled: values.enabled,
    motion: values.motion ?? values.state ?? 'idle',
    speed: finiteNumber(values.speed),
    accel: finiteNumber(values.accel, values.delay, values.acceleration),
    downLimit: finiteNumber(values.downLimit, values.down),
    upLimit: finiteNumber(values.upLimit, values.up)
  }
}

export async function getLiftState() {
  const response = await request({ url: '/api/v1/devices/lift/state', method: 'get' })
  return normalizeLiftState(unwrap(response, {}) || {})
}

export function setLiftParams(params) {
  return sendDeviceCommand('lift', 'lift.set_params', params)
}

export function moveLiftTo(height) {
  return sendDeviceCommand('lift', 'lift.move_to', { height: Number(height) })
}

export function moveLift(direction) {
  return sendDeviceCommand('lift', direction === 'down' ? 'lift.down' : 'lift.up', { reason: 'operator_manual' })
}

export function homeLift() {
  return sendDeviceCommand('lift', 'lift.home', { reason: 'operator_home' })
}

export function clearLiftFault() {
  return sendDeviceCommand('lift', 'lift.clear_fault', { reason: 'operator_clear_fault' })
}

export function enableLift(enabled = true) {
  return sendDeviceCommand('lift', 'lift.enable', { enabled: Boolean(enabled) })
}

export function stopLift() {
  return emergencyStop('operator_pressed_lift_stop')
}

/* ----------------------------- 摄像头 ----------------------------- */

function apiUrl(path = '') {
  const base = String(import.meta.env.VITE_SERVER_URL || '').replace(/\/$/, '')
  return `${base}${path}`
}

/** 摄像头预览地址；后端未提供流接口时，img 会触发错误事件并由页面提示。 */
export function cameraStreamUrl(presetId, frameId) {
  const params = new URLSearchParams()
  if (presetId !== undefined && presetId !== null && presetId !== '') params.set('preset', String(presetId))
  params.set('frame', String(frameId ?? Date.now()))
  params.set('t', String(Date.now()))
  return apiUrl(`/api/v1/cam/stream?${params.toString()}`)
}

/** 页面画面上游。真实后端环境统一返回实时流地址，不做本地假帧。 */
export function getCameraFeed(presetId, frameId = 1) {
  return {
    url: cameraStreamUrl(presetId, frameId),
    label: 'LIVE',
    statusText: '实时画面',
    statusType: 'success'
  }
}

export async function listCameraPresets(params = {}) {
  const response = await request({ url: '/api/v1/cam/presets', method: 'get', params })
  const rows = unwrapRows(response, [])
  return rows
    .map((item) => {
      const presetId = Number(item?.presetId ?? item?.id)
      return { ...item, presetId, name: item?.name || (Number.isFinite(presetId) ? `预置点 ${presetId}` : '') }
    })
    .filter((item) => Number.isFinite(item.presetId) && item.presetId > 0)
}

export function saveCameraPreset(presetId) {
  return request({
    url: '/api/v1/cam/presets',
    method: 'post',
    data: { id: Number(presetId) }
  })
}

export function deleteCameraPreset(presetId) {
  return request({
    url: `/api/v1/cam/presets/${encodeURIComponent(presetId)}`,
    method: 'delete'
  })
}

export function gotoCameraPreset(presetId) {
  return sendDeviceCommand('camera', 'camera.goto_preset', { preset: Number(presetId) })
}

export function ptzContinuous(direction, speed = 1) {
  return sendDeviceCommand('camera', 'camera.ptz', { direct: direction, speed: Number(speed) })
}

export function rebootCamera(presetId) {
  return sendDeviceCommand('camera', 'camera.reboot', { preset: Number(presetId) })
}

export function cameraSnapshot(presetId, taskRunId = '') {
  return request({
    url: '/api/v1/media/captures',
    method: 'post',
    data: {
      taskRunId: taskRunId || null,
      waypointId: String(presetId ?? 'manual'),
      deviceId: 'camera',
      mediaType: 'image',
      parameters: presetId === undefined || presetId === null ? {} : { preset: Number(presetId) }
    }
  })
}