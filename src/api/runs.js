// 运行数据接口层：任务执行记录与断点续跑。
//   GET    /api/v1/runs                    执行记录列表
//   POST   /api/v1/runs/{taskRunId}/resume 断点续跑
//   DELETE /api/v1/runs/{taskRunId}        删除执行记录
import request from '@/utils/request'
import { unwrapRows } from './envelope'

export const RUN_STATUS_LABELS = {
  1: '执行中',
  2: '待续跑',
  3: '失败',
  100: '已中断'
}

export const RUN_STATUS_TAG_TYPES = {
  1: 'success',
  2: 'warning',
  3: 'danger',
  100: 'info'
}

export function runStatusLabel(status) {
  return RUN_STATUS_LABELS[Number(status)] || String(status ?? '—')
}

export function runStatusTagType(status) {
  return RUN_STATUS_TAG_TYPES[Number(status)] || 'info'
}

export function canResumeRun(run) {
  return Number(run?.status) !== 1
}

export async function listRuns(params = {}) {
  return unwrapRows(await request({ url: '/api/v1/runs', method: 'get', params }), [])
}

export function resumeRun(taskRunId, payload = {}) {
  return request({
    url: `/api/v1/runs/${encodeURIComponent(taskRunId)}/resume`,
    method: 'post',
    data: payload
  })
}

export function deleteRun(taskRunId) {
  return request({ url: `/api/v1/runs/${encodeURIComponent(taskRunId)}`, method: 'delete' })
}