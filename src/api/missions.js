// 巡检任务（采集会话）接口层。
//   GET    /api/v1/missions                     列表（分页 / 搜索 / 状态筛选）
//   POST   /api/v1/missions                     新建
//   GET    /api/v1/missions/{id}                详情
//   PUT    /api/v1/missions/{id}                修改（revision 自增）
//   DELETE /api/v1/missions/{id}                归档（软删除）
//   GET    /api/v1/missions/{id}/points         站点序列（二期用）
//
// 与 api/tasks.js 的区别：tasks 走 ui_tasks（旧工作台影子表，payload JSON），
// missions 走 missions 表（强类型 + 采集配置 JSON），两者互不写入。
import request from '@/utils/request'
import { unwrapPage } from './envelope'

/** 任务状态。 */
export const MISSION_STATES = [
  { value: 'enabled', label: '启用', tag: 'success' },
  { value: 'disabled', label: '停用', tag: 'info' },
  { value: 'draft', label: '草稿', tag: 'warning' },
  { value: 'archived', label: '已归档', tag: 'info' }
]

/** 8 路相机通道，与后端 inspection 的 camNN 命名保持一致。 */
export const CAMERA_OPTIONS = Array.from({ length: 8 }, (_, index) => {
  const id = `cam${String(index + 1).padStart(2, '0')}`
  return { value: id, label: `通道 ${index + 1}（${id}）` }
})

export const DEFAULT_MAX_DURATION_SECONDS = 3600

export function stateLabel(value) {
  return MISSION_STATES.find((item) => item.value === value)?.label || String(value ?? '—')
}

export function stateTagType(value) {
  return MISSION_STATES.find((item) => item.value === value)?.tag || 'info'
}

/** 结束方式：0 表示不定时，靠手动结束。 */
export function endModeLabel(row) {
  const seconds = Number(row?.durationSeconds) || 0
  if (seconds <= 0) return '手动结束'
  return `${Math.round(seconds / 60)} 分钟`
}

/**
 * 新建任务的默认值：视频 + 长录音 + 分段全开，不定时，上限 1 小时。
 * 嵌套对象必须深拷贝，否则多个弹窗会共用同一份引用。
 */
export function createMissionDraft(seed = {}) {
  const draft = {
    missionId: '',
    name: '',
    state: 'enabled',
    video: { enabled: true, cameras: ['cam01', 'cam02', 'cam03', 'cam04'] },
    audio: {
      enabled: true,
      continuous: { enabled: true },
      segments: { enabled: true, segmentSeconds: 60 },
      channels: 1,
      sampleRate: 44100
    },
    durationSeconds: 0,
    maxDurationSeconds: DEFAULT_MAX_DURATION_SECONDS,
    infer: { enabled: false, capability: 'heat_stress_detection' }
  }
  return mergeDraft(draft, seed)
}

/** 只覆盖 seed 里出现过的字段，避免后端返回的扁平结构冲掉嵌套默认值。 */
function mergeDraft(draft, seed) {
  Object.keys(seed || {}).forEach((key) => {
    const value = seed[key]
    if (value === undefined || value === null) return
    if (value && typeof value === 'object' && !Array.isArray(value) && draft[key] && typeof draft[key] === 'object') {
      draft[key] = { ...draft[key], ...value }
    } else {
      draft[key] = value
    }
  })
  return draft
}

/** 提交前整理：后端只认它定义的字段。 */
export function toPayload(draft) {
  return {
    name: String(draft.name || '').trim(),
    state: draft.state,
    video: { enabled: !!draft.video?.enabled, cameras: draft.video?.cameras || [] },
    audio: {
      enabled: !!draft.audio?.enabled,
      continuous: { enabled: !!draft.audio?.continuous?.enabled },
      segments: {
        enabled: !!draft.audio?.segments?.enabled,
        segmentSeconds: Number(draft.audio?.segments?.segmentSeconds || 60)
      },
      channels: Number(draft.audio?.channels || 1),
      sampleRate: Number(draft.audio?.sampleRate || 44100)
    },
    durationSeconds: Number(draft.durationSeconds || 0),
    maxDurationSeconds: Number(draft.maxDurationSeconds || DEFAULT_MAX_DURATION_SECONDS),
    infer: { enabled: !!draft.infer?.enabled, capability: draft.infer?.capability || 'heat_stress_detection' }
  }
}

export async function fetchMissionsPage(params = {}) {
  return unwrapPage(await request({ url: '/api/v1/missions', method: 'get', params }))
}

/**
 * 启动一次采集会话。
 * overrides 只影响本次运行（如临时关分段）；speed 是模拟加速倍数，接真机后固定为 1。
 */
export function runMission(missionId, { overrides = {}, speed = 1 } = {}) {
  return request({
    url: `/api/v1/missions/${encodeURIComponent(missionId)}/run`,
    method: 'post',
    data: { overrides, speed }
  })
}

export function stopRun(taskRunId, reason = 'operator') {
  return request({
    url: `/api/v1/runs/${encodeURIComponent(taskRunId)}/stop`,
    method: 'post',
    data: { reason }
  })
}

export function getRun(taskRunId) {
  return request({ url: `/api/v1/runs/${encodeURIComponent(taskRunId)}`, method: 'get' })
}

/** 中断/失败后重跑（新开会话，旧目录保留）。 */
export function resumeRun(taskRunId, speed = 1) {
  return request({
    // 用 /restart 而非 /resume：后者被旧工作台（workbench）占用，会截获请求
    url: `/api/v1/runs/${encodeURIComponent(taskRunId)}/restart`,
    method: 'post',
    data: { speed }
  })
}

// ---- 详情与产物（P3）----

const SERVER_BASE = String(import.meta.env.VITE_SERVER_URL || '').replace(/\/$/, '')

/** 任务 + 最近运行 + 最近一次产物，详情页一次拿全。 */
export async function fetchMissionDetail(missionId) {
  return unwrap(await request({
    url: `/api/v1/missions/${encodeURIComponent(missionId)}/detail`,
    method: 'get'
  }), {})
}

/** 指定运行的产物清单（含 manifest）。 */
export async function fetchRunArtifacts(taskRunId) {
  return unwrap(await request({
    url: `/api/v1/runs/${encodeURIComponent(taskRunId)}/artifacts`,
    method: 'get'
  }), {})
}

/** 产物文件地址；同源部署时 SERVER_BASE 为空，走 Vite 代理。 */
export function artifactUrl(taskRunId, path) {
  return `${SERVER_BASE}/api/v1/runs/${encodeURIComponent(taskRunId)}/file?path=${encodeURIComponent(path)}`
}

/**
 * 以 Blob 方式取产物。
 * 为什么不用 `<audio src>`：生产开启鉴权后，媒体标签发出的请求带不上 Authorization 头，
 * 会直接 401。走 axios 拿二进制再转 objectURL，鉴权由拦截器统一处理。
 */
export async function fetchArtifactBlob(taskRunId, path) {
  const response = await request({
    url: `/api/v1/runs/${encodeURIComponent(taskRunId)}/file`,
    method: 'get',
    params: { path },
    responseType: 'blob'
  })
  return response.data
}

export function formatBytes(size) {
  const value = Number(size) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

export function createMission(payload) {
  return request({ url: '/api/v1/missions', method: 'post', data: payload })
}

export function updateMission(missionId, payload) {
  return request({ url: `/api/v1/missions/${encodeURIComponent(missionId)}`, method: 'put', data: payload })
}

export function archiveMission(missionId) {
  return request({ url: `/api/v1/missions/${encodeURIComponent(missionId)}`, method: 'delete' })
}
