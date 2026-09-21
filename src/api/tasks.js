// 任务与默认任务模板接口层。
//   GET    /api/v1/tasks                 任务列表
//   POST   /api/v1/tasks                 新增或更新任务
//   DELETE /api/v1/tasks/{taskId}        删除任务
//   POST   /api/v1/tasks/{taskId}/run    立即执行任务
//   GET    /api/v1/task-templates        默认任务模板列表
//   POST   /api/v1/task-templates        新增或更新模板
//   DELETE /api/v1/task-templates/{id}   删除模板
import request from '@/utils/request'
import { unwrapRows } from './envelope'
import { sendDeviceCommand } from './safety'

export const TASK_ENABLED_OPTIONS = [
  { value: true, label: '开启' },
  { value: false, label: '关闭' }
]

export const LIGHT_MODE_OPTIONS = [
  { value: 0, label: '正常' },
  { value: 2, label: '上补光' },
  { value: 3, label: '下补光' },
  { value: 9, label: '关灯' }
]

export function lightModeLabel(value) {
  return LIGHT_MODE_OPTIONS.find((item) => item.value === Number(value))?.label || String(value ?? '')
}

export const RUN_TYPE_OPTIONS = [
  { value: '开补光灯', label: '开补光灯' },
  { value: '关补光灯', label: '关补光灯' },
  { value: '仅巡检', label: '仅巡检' }
]

export function createTaskDraft(seed = {}) {
  return {
    taskId: '',
    taskName: '',
    runType: '开补光灯',
    enabled: true,
    runParams: '',
    cron: '0 0 8 * * ?',
    route: '',
    createdAt: '',
    updatedAt: '',
    ...seed
  }
}

export function cronSegments(cron) {
  return String(cron || '').trim().split(/\s+/).filter(Boolean).length
}

export function isValidCron(cron) {
  const segments = cronSegments(cron)
  return segments === 6 || segments === 7
}

export async function listTasks(params = {}) {
  return unwrapRows(await request({ url: '/api/v1/tasks', method: 'get', params }), [])
}

export function saveTask(task) {
  const payload = { ...task, enabled: task.enabled !== false }
  return request({ url: '/api/v1/tasks', method: 'post', data: payload })
}

export function deleteTask(taskId) {
  return request({ url: `/api/v1/tasks/${encodeURIComponent(taskId)}`, method: 'delete' })
}

/** 立即执行任务：复用设备任务的开始动作，携带任务 ID。 */
export function runTask(taskId, payload = {}) {
  return sendDeviceCommand('motion', 'motion.start_task', { task: String(taskId), ...payload })
}

export async function listTaskTemplates(params = {}) {
  return unwrapRows(await request({ url: '/api/v1/task-templates', method: 'get', params }), [])
}

export function saveTaskTemplate(template) {
  return request({ url: '/api/v1/task-templates', method: 'post', data: template })
}

export function deleteTaskTemplate(templateId) {
  return request({ url: `/api/v1/task-templates/${encodeURIComponent(templateId)}`, method: 'delete' })
}