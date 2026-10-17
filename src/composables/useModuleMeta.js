// 模块元数据：侧边栏与首页功能模块共用同一份图标 / 标签定义。
// 此前 App.vue 和 HomeView.vue 各写了一份 MODULE_ICONS，
// 且「运行总览」和「智能检测」都用了 Odometer、「任务管理」和「默认任务」都用 Document，
// 侧栏出现两个一模一样的图标。这里统一收敛并给每个入口配唯一图标。
import {
  Bell, Cpu, DataLine, Document, Files, Guide, MapLocation, Monitor,
  Operation, Setting, Van, VideoCamera
} from '@element-plus/icons-vue'

/** 侧边栏分组：把 11 个入口按「看 / 控 / 数 / 配」切开，避免一长条平铺。 */
export const NAV_GROUPS = [
  { key: 'overview', label: '总览' },
  { key: 'control', label: '设备控制' },
  { key: 'data', label: '数据' },
  { key: 'config', label: '配置' }
]

/** 每个导航项的图标与分组，key 与 api/dashboard.js 的 DASHBOARD_MODULES 一一对应。 */
export const MODULE_META = {
  home: { icon: Monitor, group: 'overview' },
  detect: { icon: Cpu, group: 'overview' },
  cam: { icon: VideoCamera, group: 'control' },
  lift: { icon: Operation, group: 'control' },
  agv: { icon: Van, group: 'control' },
  track: { icon: Guide, group: 'control' },
  tasks: { icon: Document, group: 'config' },
  'task-tmpl': { icon: Files, group: 'config' },
  map: { icon: MapLocation, group: 'config' },
  params: { icon: Setting, group: 'config' },
  runs: { icon: DataLine, group: 'data' },
  alerts: { icon: Bell, group: 'data' }
}

/** 取图标，未登记的 key 回退到 Document，保证侧栏不会渲染空白。 */
export function moduleIcon(key) {
  return MODULE_META[key]?.icon || Document
}

/** 取分组 key，未登记的归到「配置」。 */
export function moduleGroup(key) {
  return MODULE_META[key]?.group || 'config'
}
