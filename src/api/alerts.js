// 告警数据接口层。
//   GET    /api/v1/alerts                告警列表（支持 page/pageSize/keyword/level/status）
//   POST   /api/v1/alerts/{alertId}      登记处理结果
//   DELETE /api/v1/alerts/{alertId}      删除告警
import request from '@/utils/request'
import { unwrapPage, unwrapRows } from './envelope'

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

/** 服务端分页 + 筛选：返回 { rows, total }。筛选与分页都由后端完成。 */
export async function fetchAlertsPage(params = {}) {
  return unwrapPage(await request({ url: '/api/v1/alerts', method: 'get', params }))
}

/** 待处理告警数量：只取一页一条，用 total 拿数，不把整表拉到前端。 */
export async function countOpenAlerts() {
  const { total } = await fetchAlertsPage({ status: 'open', page: 1, pageSize: 1 })
  return total
}

/** 登记处理结果：状态 + 处理说明。 */
export function handleAlert(alertId, payload = {}) {
  return request({ url: `/api/v1/alerts/${encodeURIComponent(alertId)}`, method: 'post', data: payload })
}

export function deleteAlert(alertId) {
  return request({ url: `/api/v1/alerts/${encodeURIComponent(alertId)}`, method: 'delete' })
}