// 后端统一信封 { code, message, data, traceId, timestamp } 的解析工具。
// 真实后端成功时 code 为 OK；所有接口都通过 utils/request 抛出统一的 ApiError。

export function createId(prefix = 'ui') {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${random}`.slice(0, 120)
}

/** 取出 axios 响应或后端信封中的业务数据。 */
export function unwrap(response, fallback = null) {
  if (response === undefined || response === null) return fallback
  const body = response.data !== undefined ? response.data : response
  if (body && typeof body === 'object' && !Array.isArray(body)
    && body.data !== undefined && ('code' in body || 'traceId' in body)) {
    return body.data ?? fallback
  }
  return body ?? fallback
}

/** 列表接口统一取行数据：兼容 data、rows、items、list、records。 */
export function unwrapRows(response, fallback = []) {
  const body = unwrap(response, null)
  if (Array.isArray(body)) return body
  if (Array.isArray(body?.rows)) return body.rows
  if (Array.isArray(body?.items)) return body.items
  if (Array.isArray(body?.list)) return body.list
  if (Array.isArray(body?.records)) return body.records
  return fallback
}

/**
 * 分页列表接口取值：兼容 {rows,total,page,pageSize} 与直接返回数组两种形态。
 * 后端 `page` 缺省时仍返回数组（旧契约），因此两种形态都要能吃。
 */
export function unwrapPage(response, fallback = { rows: [], total: 0 }) {
  const body = unwrap(response, null)
  if (Array.isArray(body)) return { rows: body, total: body.length }
  const rows = unwrapRows(response, fallback.rows)
  const total = Number(body?.total)
  return {
    rows,
    total: Number.isFinite(total) ? total : rows.length
  }
}

export function apiErrorMessage(error, fallback = '请求失败') {
  const body = error?.response?.data
  if (body?.message) return body.code ? `${body.message}（${body.code}）` : body.message
  if (error?.message) return error.message
  return fallback
}