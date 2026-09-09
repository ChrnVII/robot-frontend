import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    redirect: '/home',
  },
  {
    path: '/home', // 运行总览
    name: 'home',
    component: () => import('../views/HomeView.vue'),
  },
  {
    path: '/params', // 参数设置
    name: 'parameters',
    component: () => import('../views/ParametersView.vue'),
  },
  {
    path: '/lift', // 升降控制
    name: 'lift',
    component: () => import( '../views/LiftView.vue'),
  },
  {
    path: '/tasks', // 任务管理
    name: 'tasks',
    component: () => import('../views/TasksView.vue'),
  },


  {
    path: '/map', // 地图站点
    name: 'map',
    component: () => import('../views/MapView.vue'),
  },
  {
    path: '/agv', // 移动地盘
    name: 'agv',
    component: () => import('../views/AgvView.vue'),
  },
  {
    path: '/runs', // 运行数据
    name: 'runs',
    component: () => import('../views/RunsView.vue'),
  },
  {
    path: '/alerts', // 告警数据
    name: 'alerts',
    component: () => import('../views/AlertsView.vue'),
  },
  {
    path: '/task-tmpl', // 默认任务
    name: 'taskTemplates',
    component: () => import('../views/TaskTmplView.vue'),
  },
  {
    path: '/cam', // 球形摄像
    name: 'camera',
    component: () => import('../views/CameraView.vue'),
  },
  {
    path: '/detect', // 智能检测
    name: 'detections',
    component: () => import('../views/DetectionsView.vue'),
  },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior(to, from, savedPosition) { // 切换路由滚动到顶部
    if (savedPosition) return savedPosition
    return { top: 0 }
  }
})

export default router
