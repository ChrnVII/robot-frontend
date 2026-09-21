// 告警数据接口层。
//   GET    /api/v1/alerts                告警列表
//   POST   /api/v1/alerts/{alertId}      登记处理结果
//   DELETE /api/v1/alerts/{alertId}      删除告警
import request from '@/utils/request'
import { unwrapRows } from './envelope'

export const ALERT_LEVELS = [
  { value: 'info', label: '提示', tag: 'info' },
  { value: 'warning', label: '告警', tag: 'warning' },
  { value: 'critical', label: '严重', tag: 'danger' },
  { value: 'emergency', label: '紧急', tag: 'danger' }
]

export const ALERT_STATUSES = [
  { value: 'open', label: '待处理', tag: 'danger' },
  { value: 'acknowledged', label: '已确认', tag: 'warning' },
  { value: 'handled', label: '已处理', tag: 'success' },
  { value: 'closed', label: '已关闭', tag: 'info' }
]

export function alertLevelMeta(level) {
  return ALERT_LEVELS.find((item) => item.value === level) || { value: level, label: String(level ?? '—'), tag: 'info' }
}

export function alertStatusMeta(status) {
  return ALERT_STATUSES.find((item) => item.value === status) || { value: status, label: String(status ?? '—'), tag: 'info' }
}

export async function listAlerts(params = {}) {
  return unwrapRows(await request({ url: '/api/v1/alerts', method: 'get', params }), [])
}

/** 登记处理结果：状态 + 处理说明。 */
export function handleAlert(alertId, payload = {}) {
  return request({ url: `/api/v1/alerts/${encodeURIComponent(alertId)}`, method: 'post', data: payload })
}

export function deleteAlert(alertId) {
  return request({ url: `/api/v1/alerts/${encodeURIComponent(alertId)}`, method: 'delete' })
}