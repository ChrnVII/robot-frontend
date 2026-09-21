// 展示层的小工具：时间格式化、数值兜底、设备健康度字典。
// 只做纯函数转换，不依赖任何接口，方便每个页面按需引入。

/** 时间格式化，兼容 ISO 字符串、时间戳和原平台的 "YYYY-MM-DD HH:mm:ss"。 */
export function formatTime(value, { withSeconds = true, fallback = '—' } = {}) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'string' && /^1970-01-01/.test(value)) return fallback
  const date = value instanceof Date ? value : new Date(typeof value === 'string' ? value.replace(' ', 'T') : value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString('zh-CN', {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {})
  })
}

/** 当前时间，页面标题栏用。 */
export function nowText() {
  return formatTime(new Date(), { withSeconds: false })
}

/** 数值展示兜底：null / undefined / NaN / 负数哨兵（如 -1）统一显示占位符。 */
export function displayNumber(value, { unit = '', fallback = '—', allowNegative = true } = {}) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  if (!allowNegative && number < 0) return fallback
  return `${number}${unit}`
}

/** 百分比数值转 Element Plus 进度条颜色。 */
export function percentStatus(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 'info'
  if (number >= 60) return 'success'
  if (number >= 25) return 'warning'
  return 'danger'
}

export const HEALTH_LABELS = {
  ok: '正常',
  healthy: '正常',
  degraded: '降级',
  warning: '告警',
  error: '故障',
  unavailable: '不可用'
}

export const QUALITY_LABELS = {
  valid: '有效',
  invalid: '无效',
  uncertain: '不确定',
  degraded: '降级'
}

export function healthLabel(health) {
  return HEALTH_LABELS[String(health || '').toLowerCase()] || String(health || '未知')
}

export function healthTagType(health) {
  const key = String(health || '').toLowerCase()
  if (['ok', 'healthy'].includes(key)) return 'success'
  if (['degraded', 'warning', 'uncertain'].includes(key)) return 'warning'
  if (['error', 'unavailable'].includes(key)) return 'danger'
  return 'info'
}

export function qualityLabel(quality) {
  return QUALITY_LABELS[String(quality || '').toLowerCase()] || String(quality || '—')
}
