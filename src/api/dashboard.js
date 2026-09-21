// 运行总览接口层：把首屏需要的多路数据聚合成一个快照。
// 某一路接口失败不会让整页空白，失败信息会汇总在 errors 中由页面提示。
import { unwrap } from './envelope'
import { getHealth, getPlatformInfo, getVersion } from './system'
import { getRobotState, robotStateToTelemetry } from './telemetry'
import { listTasks } from './tasks'
import { listAlerts } from './alerts'

/** 首页功能模块入口，App 侧边栏与首页卡片共用同一份定义。 */
export const DASHBOARD_MODULES = [
  { key: 'detect', path: '/detect', label: '智能检测', description: '模型、摄像头与结果管理' },
  { key: 'tasks', path: '/tasks', label: '任务管理', description: '巡检计划与 CRON 调度' },
  { key: 'cam', path: '/cam', label: '球形摄像', description: '实时画面与云台控制' },
  { key: 'lift', path: '/lift', label: '升降控制', description: '高度与限位控制' },
  { key: 'agv', path: '/agv', label: '移动底盘', description: '遥测与底盘控制' },
  { key: 'map', path: '/map', label: '地图站点', description: '站点与动作配置' },
  { key: 'params', path: '/params', label: '参数设置', description: '通信与服务配置' },
  { key: 'runs', path: '/runs', label: '运行数据', description: '任务执行记录' },
  { key: 'alerts', path: '/alerts', label: '告警数据', description: '异常事件处置' },
  { key: 'task-tmpl', path: '/task-tmpl', label: '默认任务', description: '路线模板维护' }
]

export async function loadDashboard() {
  const [platformResult, healthResult, versionResult, stateResult, tasksResult, alertsResult] = await Promise.allSettled([
    getPlatformInfo(),
    getHealth(),
    getVersion(),
    getRobotState(),
    listTasks(),
    listAlerts({ limit: 50 })
  ])

  const errors = []
  const read = (result, fallback, label) => {
    if (result.status === 'fulfilled') return result.value
    errors.push(`${label}：${result.reason?.message || '接口不可用'}`)
    return fallback
  }

  const platform = unwrap(read(platformResult, null, '平台信息'), {}) || {}
  const health = unwrap(read(healthResult, null, '健康检查'), null)
  const version = versionResult.status === 'fulfilled' ? unwrap(versionResult.value, {}) || {} : {}
  const state = unwrap(read(stateResult, null, '机器人状态'), null)
  const tasks = read(tasksResult, [], '任务列表')
  const alerts = read(alertsResult, [], '告警列表')

  const online = Boolean(health && (health.status || health.coreStatus))
  return {
    errors,
    platform: {
      robotId: platform?.robotId || state?.robotId || '',
      name: platform?.name || state?.name || '',
      mode: platform?.mode || '',
      apiVersion: platform?.apiVersion || version?.apiVersion || ''
    },
    health: {
      online,
      version: version?.version || '',
      status: health?.status || '',
      coreStatus: health?.coreStatus || ''
    },
    telemetry: robotStateToTelemetry(state || {}, null, {}),
    tasks: {
      total: tasks.length,
      enabled: tasks.filter((task) => task.enabled !== false).length
    },
    alerts: {
      total: alerts.length,
      open: alerts.filter((alert) => alert.status === 'open').length,
      recent: alerts.slice(0, 5)
    }
  }
}