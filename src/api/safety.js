// 控制类接口层：控制租约、设备命令、急停、媒体采集、摄像头与升降。
//   POST   /api/v1/control/leases                申请控制租约
//   DELETE /api/v1/control/leases/{leaseId}      释放控制租约
//   POST   /api/v1/devices/commands              统一下发设备命令
//   POST   /api/v1/emergency-stop                急停
//   POST   /api/v1/media/captures                抓图 / 录音
//   GET    /api/v1/devices/lift/state            升降设备状态
// 普通设备命令携带有效租约；停止动作无租约，且只在租约失效时刷新重试一次。
import request, { ApiError } from '@/utils/request'
import { createId, unwrap, unwrapRows } from './envelope'
import { cameraCommandError } from '@/utils/cameraControl'
import { createControlLeaseCache } from '@/utils/controlLease'

const ISSUER = import.meta.env.VITE_CONTROL_HOLDER || 'robot-console'
const STOP_LEASE_ID = 'stop-without-lease'
const CAMERA_EMERGENCY_LEASE_ID = 'camera-emergency-bypass'

const controlLease = createControlLeaseCache({
  acquire: async (mode) => {
    const response = await request({
      url: '/api/v1/control/leases',
      method: 'post',
      data: { holder: ISSUER, mode }
    })
    const lease = unwrap(response, {})
    if (!lease?.leaseId && !lease?.id) {
      throw new ApiError('后端未返回控制租约 leaseId，无法下发设备命令', {
        type: 'business', code: 'LEASE_MISSING'
      })
    }
    return lease
  },
  release: (leaseId, reason) => request({
    url: `/api/v1/control/leases/${encodeURIComponent(leaseId)}`,
    method: 'delete',
    params: { reason }
  }),
  defaultTtlMs: 3000
})

function finiteNumber(...values) {
  const value = values.find((item) => item !== undefined && item !== null && item !== '')
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

export function ensureLease(mode = 'manual_local') {
  return controlLease.ensure(mode)
}

export function releaseControlLease(reason = 'released') {
  return controlLease.release(reason)
}

/**
 * 是否是「租约失配」导致的拒绝——只有这一类才值得刷新租约后重试。
 *
 * 后端把 rejected 统一回 409，其中也包含设备自己拒绝（相机 401/400 等）：
 * 那类重发一次同样会失败，还会让设备多收一条命令，因此必须排除。
 */
function isLeaseRejection(error) {
  const status = Number(error?.status ?? error?.response?.status)
  if (status !== 409) return false
  return /lease/i.test(String(error?.message || ''))
}

/**
 * 下发统一设备命令。
 * @param {string} target motion / lift / light / camera / battery 等。
 * @param {string} action 设备能力允许的动作名。
 * @param {object} payload 动作参数。
 * @param {string} mode 控制模式，默认 manual_local。
 */
export async function sendDeviceCommand(target, action, payload = {}, mode = 'manual_local') {
  const stop = action === 'stop' || (
    target === 'camera' && action === 'camera.ptz'
    && String(payload?.direct || '').toLowerCase() === 'stop'
  )
  const traceId = createId('trace')

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let activeLease = STOP_LEASE_ID
    if (!stop) {
      try {
        activeLease = await ensureLease(mode)
      } catch (error) {
        if (target !== 'camera') throw error
        // 急停期间普通租约已被抢占：交给 robot-core 决定无租约的相机命令是否放行。
        activeLease = CAMERA_EMERGENCY_LEASE_ID
      }
    }
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
          traceId,
          payload
          // issuedAt / expiresAt 不传：由服务端盖章，避免浏览器与机器人时钟漂移
          // 导致所有命令以 command_expired 被拒。
        }
      })
    } catch (error) {
      if (!isLeaseRejection(error)) throw error
      if (!stop) await controlLease.invalidate(activeLease)
      if (attempt === 1) throw error
    }
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

/**
 * 解除急停锁。
 *
 * 急停是**锁存**语义：不清除之前，robot-core 会一直拒绝升降/底盘/任务命令
 * （云台是唯一豁免的设备）。复位本身不依赖普通租约——急停期间普通租约已被抢占。
 */
export function resetEmergency(reason = 'operator_reset') {
  return request({
    url: '/api/v1/control/emergency-reset',
    method: 'post',
    data: { traceId: createId('trace-reset'), reason }
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
  const id = Number(presetId)
  return sendDeviceCommand('camera', 'camera.save_preset', { preset: id }).then(async (response) => {
    await request({
      url: '/api/v1/cam/presets',
      method: 'post',
      data: { id }
    })
    return response
  })
}

export function deleteCameraPreset(presetId) {
  const id = Number(presetId)
  return sendDeviceCommand('camera', 'camera.delete_preset', { preset: id }).then(async (response) => {
    await request({
      url: `/api/v1/cam/presets/${encodeURIComponent(id)}`,
      method: 'delete'
    })
    return response
  })
}

export function gotoCameraPreset(presetId) {
  return sendDeviceCommand('camera', 'camera.goto_preset', { preset: Number(presetId) })
}

export function ptzContinuous(direction, speed = 1) {
  return sendDeviceCommand('camera', 'camera.ptz', { direct: direction, speed: Number(speed) })
    .then((response) => {
      const failure = cameraCommandError(unwrap(response, {}))
      if (failure) throw new ApiError(failure, { type: 'business', code: 'COMMAND_REJECTED' })
      return response
    })
}

export function rebootCamera(presetId) {
  return sendDeviceCommand('camera', 'camera.reboot', { preset: Number(presetId) })
}
