import axios from 'axios'

// 统一 Axios 实例：真实后端地址由 VITE_SERVER_URL 提供；开发环境建议留空并走 Vite 代理。
const rawBaseUrl = import.meta.env.VITE_SERVER_URL
const baseURL = rawBaseUrl ? String(rawBaseUrl).replace(/\/$/, '') : ''
const timeout = Number(import.meta.env.VITE_REQUEST_TIMEOUT) || 10000

const SUCCESS_CODES = new Set(['OK', 'ok', 'SUCCESS', 'success', 0, '0', 200, '200'])

let lastTraceId = ''

export function createRequestId(prefix = 'trace') {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${random}`.slice(0, 128)
}

export class ApiError extends Error {
  constructor(message, { type = 'http', status = 0, code = '', traceId = '', cause } = {}) {
    super(message, { cause })
    this.name = 'ApiError'
    this.type = type
    this.status = status
    this.code = code
    this.traceId = traceId
    // 兼容 axios / Element Plus 组件里常见的 error.response 读取方式。
    this.response = { status, data: { code, message, traceId } }
  }
}

/** 从任意错误中提炼用户可读的错误文案。 */
export function getErrorMessage(error, fallback = '操作失败，请稍后重试') {
  if (!error) return fallback
  if (error instanceof ApiError && error.message) return error.message
  const body = error?.response?.data
  if (body?.message) return body.code ? `${body.message}（${body.code}）` : body.message
  if (error?.code === 'ECONNABORTED' || /timeout/i.test(error?.message || '')) {
    return '请求超时，请检查后端服务或网络连接'
  }
  if (!error?.response && error?.message) return `无法连接后端服务：${error.message}`
  if (error?.message) return error.message
  return fallback
}

function httpStatusMessage(status) {
  if (status === 401) return '登录状态已失效，请重新登录'
  if (status === 403) return '当前账号没有执行该操作的权限'
  if (status === 404) return '后端未提供该接口或资源不存在'
  if (status === 409) return '设备或后端拒绝了本次操作'
  if (status === 422) return '请求参数不合法'
  if (status >= 500) return '后端服务异常'
  return `请求失败（HTTP ${status}）`
}

const service = axios.create({
  baseURL,
  timeout,
  headers: { 'Content-Type': 'application/json' }
})

service.interceptors.request.use(
  (config) => {
    const traceId = config.headers['X-Trace-Id'] || createRequestId('trace')
    config.headers['X-Trace-Id'] = traceId
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('access_token') : ''
    if (token) config.headers.Authorization = `Bearer ${token}`
    return config
  },
  (error) => Promise.reject(new ApiError(getErrorMessage(error), { type: 'request', cause: error }))
)

service.interceptors.response.use(
  (response) => {
    const traceId = response.headers?.['x-trace-id'] || response.headers?.['X-Trace-Id'] || ''
    lastTraceId = traceId
    const body = response.data
    if (body && typeof body === 'object' && !Array.isArray(body) && 'code' in body
      && !SUCCESS_CODES.has(body.code)) {
      const message = body.message || body.msg || '后端返回了业务失败'
      return Promise.reject(new ApiError(
        body.code ? `${message}（${body.code}）` : message,
        { type: 'business', status: response.status, code: body.code, traceId: body.traceId || traceId }
      ))
    }
    return response
  },
  (error) => {
    if (axios.isCancel(error) || error?.code === 'ERR_CANCELED') {
      return Promise.reject(new ApiError('请求已取消', { type: 'cancelled', cause: error }))
    }
    const status = Number(error?.response?.status) || 0
    const body = error?.response?.data
    const traceId = body?.traceId || error?.response?.headers?.['x-trace-id'] || lastTraceId
    if (error?.code === 'ECONNABORTED' || /timeout/i.test(error?.message || '')) {
      return Promise.reject(new ApiError('请求超时，请检查后端服务或网络连接', {
        type: 'timeout', status, code: body?.code, traceId, cause: error
      }))
    }
    if (!error?.response) {
      return Promise.reject(new ApiError('无法连接后端服务，请检查服务是否启动或 VITE_SERVER_URL 配置', {
        type: 'network', code: body?.code, traceId, cause: error
      }))
    }
    const message = body?.message || body?.msg || httpStatusMessage(status)
    return Promise.reject(new ApiError(
      body?.code ? `${message}（${body.code}）` : message,
      { type: 'http', status, code: body?.code, traceId, cause: error }
    ))
  }
)

export default service