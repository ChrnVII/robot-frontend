import request from '@/utils/request'

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
export function getDetections(taskRunId, params) {
  return request({
    url: `/api/v1/inspections/${encodeURIComponent(taskRunId)}/detections`,
    method: 'get',
    params
  })
}
export function getDetectionImage(taskRunId, imageId) {
  return request({
    url: `/api/v1/inspections/${encodeURIComponent(taskRunId)}/images/${encodeURIComponent(imageId)}`,
    method: 'get',
    responseType: 'blob'
  })
}
