// 遥测接口层：机器人状态、环境数据与实时通道。
//   GET /api/v1/robot/state     机器人及设备摘要
//   GET /api/v1/environment     环境采集值
//   WS  /ws/state               机器人状态推送
//   WS  /ws/environment         环境数据推送
import request from '@/utils/request'
import { unwrap } from './envelope'

function finiteNumber(...values) {
  const value = values.find((item) => item !== undefined && item !== null && item !== '')
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

/** 从设备摘要里挑出指定设备的读数，设备名不一致时按顺序回退。 */
export function deviceValues(state, ...keys) {
  const devices = state?.devices || state?.deviceStates || {}
  for (const key of keys) {
    const device = devices[key]
    if (device) return device.values || device
  }
  return {}
}

/** 把后端可能出现的多种字段命名收敛成页面使用的扁平结构。 */
export function robotStateToTelemetry(state = {}, environment = {}, fallback = {}) {
  const source = state && typeof state === 'object' ? state : {}
  const motion = deviceValues(source, 'motion', 'chassis', 'agv')
  const battery = deviceValues(source, 'battery', 'power')
  const lift = deviceValues(source, 'lift')
  const envDevice = deviceValues(source, 'environment', 'env')
  const system = source.system || {}
  const env = environment?.values || environment || envDevice.values || envDevice || {}
  const position = source.pose || source.position || motion.pose || {}
  const task = source.task || source.taskState || {}

  return {
    ...fallback,
    robotId: source.robotId ?? fallback.robotId,
    name: source.name ?? fallback.name,
    firmware: source.firmwareVersion ?? source.firmware ?? fallback.firmware,
    sdk: source.sdkVersion ?? source.apiVersion ?? fallback.sdk,
    battery: finiteNumber(source.batteryPercent, battery.batteryPercent, battery.percent, battery.level, fallback.battery),
    cpu: finiteNumber(source.cpuPercent, system.cpuPercent, fallback.cpu),
    disk: finiteNumber(source.diskPercent, system.diskPercent, fallback.disk),
    yaw: finiteNumber(position.yaw, source.yaw, fallback.yaw),
    x: finiteNumber(position.x, source.x, fallback.x),
    y: finiteNumber(position.y, source.y, fallback.y),
    status: source.status ?? source.state ?? source.health ?? fallback.status,
    position: source.positionLabel ?? position.label ?? motion.positionM ?? fallback.position,
    station: source.station ?? position.station ?? fallback.station,
    lift: finiteNumber(lift.height, lift.position, lift.positionM, source.liftHeight, fallback.lift),
    temperature: finiteNumber(env.temperatureC, env.temperature, fallback.temperature),
    humidity: finiteNumber(env.humidityPercent, env.humidity, fallback.humidity),
    light: finiteNumber(env.illuminanceLux, env.light, fallback.light),
    co2: finiteNumber(env.co2Ppm, env.co2, fallback.co2),
    ammonia: finiteNumber(env.ammoniaPpm, env.ammonia, fallback.ammonia),
    wind: finiteNumber(env.windSpeedMps, env.windSpeed, env.wind, fallback.wind),
    task: task.id ?? source.taskId ?? fallback.task,
    paused: Number(task.paused ?? source.paused ?? fallback.paused ?? 0),
    currentStation: task.currentStation ?? source.currentStation ?? fallback.currentStation,
    cage: task.cage ?? source.cage ?? fallback.cage,
    offset: finiteNumber(task.offset, source.offset, fallback.offset),
    total: finiteNumber(task.total, source.total, fallback.total),
    sampledAt: source.sampledAt ?? fallback.sampledAt
  }
}

export function normalizeTelemetry(response) {
  return unwrap(response, null)
}

export function normalizeEnvironment(response) {
  return unwrap(response, null)
}

export function getRobotState(params) {
  return request({ url: '/api/v1/robot/state', method: 'get', params })
}

export function getEnvironmentState(params) {
  return request({ url: '/api/v1/environment', method: 'get', params })
}

export function getDeviceState(deviceId, params) {
  return request({ url: `/api/v1/devices/${encodeURIComponent(deviceId)}/state`, method: 'get', params })
}

function websocketUrl(path = '') {
  const configured = import.meta.env.VITE_SERVER_URL || (typeof window !== 'undefined' ? window.location.origin : '')
  const base = String(configured).replace(/\/$/, '').replace(/^http/, 'ws')
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

export function getStateStreamUrl() {
  return websocketUrl('/ws/state')
}

export function getEnvironmentStreamUrl() {
  return websocketUrl('/ws/environment')
}

function openStream(path, onMessage, handlers = {}) {
  const url = websocketUrl(path)
  if (!url || typeof WebSocket === 'undefined') return null
  try {
    const socket = new WebSocket(url)
    socket.onopen = () => handlers.onOpen?.()
    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data)
        onMessage(payload?.data ?? payload)
      } catch (reason) {
        console.warn('实时消息解析失败', reason)
      }
    }
    socket.onerror = (error) => handlers.onError?.(error)
    socket.onclose = () => handlers.onClose?.()
    return socket
  } catch (reason) {
    handlers.onError?.(reason)
    handlers.onClose?.()
    return null
  }
}

export function openStateStream(onMessage, handlers) {
  return openStream('/ws/state', onMessage, handlers)
}

export function openEnvironmentStream(onMessage, handlers) {
  return openStream('/ws/environment', onMessage, handlers)
}