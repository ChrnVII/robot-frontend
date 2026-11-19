// 运行数据接口层：全局采集会话记录（mission_runs）。
//
// 历史包袱：这里原来读 /api/v1/runs（ui_runs 影子表），只有「移动底盘 → 开始任务」会写，
// 真正的采集会话记录在 mission_runs。结果页面长期为空，且「结束时间 / 执行描述 / 当前站点」
// 这些列后端从不上报，永远是横杠或 0。现在改读 GET /api/v1/mission-runs（与任务管理同源），
// 所有列都来自真实记录。
import request from '@/utils/request'
import { unwrapPage } from './envelope'

/** 运行状态：对应 services/mission_runner.py 的 STATE_* 常量。 */
export const RUN_STATES = [
  { value: 'queued', label: '排队中', tag: 'info' },
  { value: 'executing', label: '执行中', tag: 'primary' },
  { value: 'completed', label: '已完成', tag: 'success' },
  { value: 'failed', label: '失败', tag: 'danger' },
  { value: 'aborted', label: '已中止', tag: 'warning' },
  { value: 'interrupted', label: '已中断', tag: 'info' }
]

export function runStateMeta(state) {
  return RUN_STATES.find((item) => item.value === state)
    || { value: state, label: String(state ?? '—'), tag: 'info' }
}

export async function fetchRunsPage(params = {}) {
  return unwrapPage(await request({ url: '/api/v1/mission-runs', method: 'get', params }))
}

/** 执行中/排队中的会话不允许重跑：要先结束，否则同一个任务会有两个会话抢设备。 */
export function canResumeRun(run) {
  return !['queued', 'executing'].includes(String(run?.state || ''))
}

/** 中断/失败后重跑：后端新开一次会话，旧目录保留。 */
export function resumeRun(taskRunId, speed = 1) {
  return request({
    // 用 /restart 而非 /resume：后者被旧工作台（workbench）占用，会截获请求
    url: `/api/v1/runs/${encodeURIComponent(taskRunId)}/restart`,
    method: 'post',
    data: { speed }
  })
}
