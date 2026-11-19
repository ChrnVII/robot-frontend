// 运行总览接口层：把首屏需要的多路数据聚合成一个快照。
// 某一路接口失败不会让整页空白，失败信息会汇总在 errors 中由页面提示。
import { unwrap } from './envelope'
import { getHealth, getPlatformInfo, getVersion } from './system'
import { getRobotState, robotStateToTelemetry } from './telemetry'
import { fetchMissionsPage } from './missions'
import { listAlerts } from './alerts'

/** 首页功能模块入口，App 侧边栏与首页卡片共用同一份定义。 */
export const DASHBOARD_MODULES = [
  { key: 'detect', path: '/detect', label: '智能检测', description: '模型、摄像头与结果管理' },
  { key: 'capture', path: '/capture', label: '手动采集', description: '推着走随手录，存到本机' },
  { key: 'tasks', path: '/tasks', label: '任务管理', description: '巡检采集会话与启停' },
  { key: 'cam', path: '/cam', label: '球形摄像', description: '实时画面与云台控制' },
  { key: 'lift', path: '/lift', label: '升降控制', description: '高度与限位控制' },
  { key: 'agv', path: '/agv', label: '移动底盘', description: '遥测与底盘控制' },
  { key: 'map', path: '/map', label: '地图站点', description: '站点与动作配置' },
  { key: 'params', path: '/params', label: '运行环境', description: '模式、模型与设备清单' },
  { key: 'runs', path: '/runs', label: '运行数据', description: '任务执行记录' },
  { key: 'alerts', path: '/alerts', label: '告警数据', description: '异常事件处置' },
  { key: 'task-tmpl', path: '/task-tmpl', label: '默认任务', description: '路线模板维护' },
  { key: 'cloud', path: '/cloud-link', label: '云端接入', description: '连接、注册与凭据' }
]

export async function loadDashboard() {
  // 任务统计必须读 /missions（任务管理页管的就是这张表）。
  // 以前读的是 /tasks（ui_tasks 影子表），于是首页的「启用任务」和任务页里
  // 看到的条数是两个互不相干的数字。这里只取 total，不拉整表。
  const [platformResult, healthResult, versionResult, stateResult, tasksResult, alertsResult] = await Promise.allSettled([
    getPlatformInfo(),
    getHealth(),
    getVersion(),
    getRobotState(),
    Promise.all([
      fetchMissionsPage({ page: 1, pageSize: 1 }),
      fetchMissionsPage({ state: 'enabled', page: 1, pageSize: 1 })
    ]),
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
  const missionCounts = read(tasksResult, null, '任务统计')
  const alerts = read(alertsResult, [], '告警列表')

  // /healthz 在 robot-core 不可达时仍返回 200，只是 status=degraded、coreStatus=unavailable。
  // 所以「在线」必须看字段值，不能看对象是否存在（那会把降级误判成健康）。
  const coreStatus = String(health?.coreStatus || '')
  const healthStatus = String(health?.status || '')
  const online = Boolean(health) && (coreStatus ? coreStatus === 'ok' : healthStatus === 'ok')
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
      degraded: Boolean(health) && !online,
      version: version?.version || '',
      status: healthStatus,
      coreStatus
    },
    // 设备清单（robot-core 的 health 原样透出）：首页「设备状态」表用它，
    // 每项含 deviceId / health / source / sampledAt / quality。
    // source 是判断"真设备还是模拟器"的唯一依据（串口为 ttyS0@9600，模拟为 simulator）。
    devices: state?.devices || state?.deviceStates || {},
    telemetry: robotStateToTelemetry(state || {}, null, {}),
    tasks: missionCounts
      ? { total: missionCounts[0].total, enabled: missionCounts[1].total }
      : null,
    alerts: {
      total: alerts.length,
      open: alerts.filter((alert) => alert.status === 'open').length,
      recent: alerts.slice(0, 5)
    }
  }
}