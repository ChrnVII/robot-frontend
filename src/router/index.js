import { createRouter, createWebHistory } from 'vue-router'

// 每条路由带 meta.title：浏览器标签页标题随路由变化，
// 多开几个标签（总览 / 告警 / 摄像头）时才分得清谁是谁。
const routes = [
  {
    path: '/',
    redirect: '/home'
  },
  {
    path: '/home', // 运行总览
    name: 'home',
    meta: { title: '运行总览' },
    component: () => import('../views/HomeView.vue')
  },
  {
    path: '/params', // 参数设置
    name: 'parameters',
    meta: { title: '参数设置' },
    component: () => import('../views/ParametersView.vue')
  },
  {
    path: '/lift', // 升降控制
    name: 'lift',
    meta: { title: '升降控制' },
    component: () => import('../views/LiftView.vue')
  },
  {
    path: '/tasks', // 任务管理
    name: 'tasks',
    meta: { title: '任务管理' },
    component: () => import('../views/TasksView.vue')
  },
  {
    path: '/map', // 地图站点
    name: 'map',
    meta: { title: '地图站点' },
    component: () => import('../views/MapView.vue')
  },
  {
    path: '/agv', // 移动底盘
    name: 'agv',
    meta: { title: '移动底盘' },
    component: () => import('../views/AgvView.vue')
  },
  {
    path: '/track', // 底盘循迹（独立后端）
    name: 'track',
    meta: { title: '底盘循迹' },
    component: () => import('../views/track.vue')
  },
  {
    path: '/runs', // 运行数据
    name: 'runs',
    meta: { title: '运行数据' },
    component: () => import('../views/RunsView.vue')
  },
  {
    path: '/alerts', // 告警数据
    name: 'alerts',
    meta: { title: '告警数据' },
    component: () => import('../views/AlertsView.vue')
  },
  {
    path: '/task-tmpl', // 默认任务
    name: 'taskTemplates',
    meta: { title: '默认任务' },
    component: () => import('../views/TaskTmplView.vue')
  },
  {
    path: '/cam', // 球形摄像
    name: 'camera',
    meta: { title: '球形摄像' },
    component: () => import('../views/CameraView.vue')
  },
  {
    path: '/detect', // 智能检测
    name: 'detections',
    meta: { title: '智能检测' },
    component: () => import('../views/DetectionsView.vue')
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    meta: { title: '页面不存在' },
    redirect: '/home'
  }
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior(to, from, savedPosition) {
    // 切换路由滚动到顶部
    if (savedPosition) return savedPosition
    return { top: 0 }
  }
})

const APP_NAME = '巡检机器人控制系统'

router.afterEach((to) => {
  const title = to.meta?.title
  document.title = title ? `${title} · ${APP_NAME}` : APP_NAME
})

export default router
