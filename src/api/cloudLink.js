// 云端接入：状态、配置、凭据、注册与进程操作。
// 所有接口都经 backend 转发到 cloud-agent 的 UDS 控制面，前端不直连任何进程。
import request from '@/utils/request'

const BASE = '/api/v1/cloud-link'

export function getCloudStatus() {
  return request({ url: `${BASE}/status`, method: 'get' })
}

export function getCloudLogs(params) {
  return request({ url: `${BASE}/logs`, method: 'get', params })
}

export function getCloudConfig() {
  return request({ url: `${BASE}/config`, method: 'get' })
}

export function updateCloudConfig(data) {
  return request({ url: `${BASE}/config`, method: 'put', data })
}

export function reloadCloudConfig() {
  return request({ url: `${BASE}/config/reload`, method: 'post' })
}

export function listCloudCredentials() {
  return request({ url: `${BASE}/credentials`, method: 'get' })
}

export function putCloudCredential(data) {
  return request({ url: `${BASE}/credentials`, method: 'post', data })
}

export function activateCloudCredential(server) {
  return request({ url: `${BASE}/credentials/activate`, method: 'post', params: { server } })
}

export function deleteCloudCredential(server) {
  return request({ url: `${BASE}/credentials`, method: 'delete', params: server ? { server } : {} })
}

export function startCloudEnroll(data) {
  return request({ url: `${BASE}/enroll`, method: 'post', data: data || {} })
}

export function cancelCloudEnroll() {
  return request({ url: `${BASE}/enroll/cancel`, method: 'post' })
}

export function reconnectCloud() {
  return request({ url: `${BASE}/reconnect`, method: 'post' })
}

export function pauseCloud() {
  return request({ url: `${BASE}/pause`, method: 'post' })
}

export function resumeCloud() {
  return request({ url: `${BASE}/resume`, method: 'post' })
}

export function rotateCloudToken() {
  return request({ url: `${BASE}/rotate`, method: 'post' })
}

export function cancelCloudUpload(uploadId) {
  return request({ url: `${BASE}/uploads/${encodeURIComponent(uploadId)}/cancel`, method: 'post' })
}

export function restartCloudAgent() {
  return request({ url: `${BASE}/restart`, method: 'post' })
}
