<script setup>
// 应用外壳：左侧固定导航 + 右侧页面内容。
// 导航项与 api/dashboard.js 的模块定义同源，新增页面只需改一处。
import { computed, onMounted, ref } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import {
  Bell, DataLine, Document, Guide, MapLocation, Odometer, Operation, Setting, Van, VideoCamera
} from '@element-plus/icons-vue'
import { DASHBOARD_MODULES } from '@/api/dashboard'
import { getHealth, getPlatformInfo } from '@/api/system'
import { unwrap } from '@/api/envelope'

const route = useRoute()
const isPlatformOnline = ref(false)
const platform = ref({ robotId: '' })
const platformError = ref('')

// 模块图标按 key 映射，键与 api/dashboard.js 的 DASHBOARD_MODULES 一致。
const MODULE_ICONS = {
  detect: Odometer,
  tasks: Document,
  cam: VideoCamera,
  lift: Operation,
  agv: Van,
  map: MapLocation,
  params: Setting,
  runs: DataLine,
  alerts: Bell,
  'task-tmpl': Document
}

// 首页单独放在导航最上面，其余模块与 dashboard 定义保持一致。
// 底盘循迹对接的是独立后端，不属于 dashboard 模块，只在侧边栏挂在「移动底盘」之后。
const TRACK_NAV_ITEM = { key: 'track', path: '/track', label: '底盘循迹', icon: Guide }

const navigation = computed(() => {
  const items = [
    { key: 'home', path: '/home', label: '运行总览', icon: Odometer },
    ...DASHBOARD_MODULES.map((module) => ({
      key: module.key,
      path: module.path,
      label: module.label,
      icon: MODULE_ICONS[module.key] || Document
    }))
  ]
  const agvIndex = items.findIndex((item) => item.key === 'agv')
  items.splice(agvIndex === -1 ? items.length : agvIndex + 1, 0, TRACK_NAV_ITEM)
  return items
})

const activePath = computed(() => route.path)
// 侧边栏底部只留一行短文案：后端报错时也用「后端连接异常」占位，
// 完整错误挂到 title 上，避免长错误文案撑破 248px 的侧栏。
const footerText = computed(() => (
  platformError.value ? '后端连接异常' : platform.value.robotId || 'Inspection Robot'
))
const footerTitle = computed(() => platformError.value || footerText.value)

async function fetchReady() {
  platformError.value = ''
  const [healthResult, platformResult] = await Promise.allSettled([
    getHealth(),
    getPlatformInfo()
  ])
  const health = healthResult.status === 'fulfilled' ? unwrap(healthResult.value, null) : null
  const info = platformResult.status === 'fulfilled' ? unwrap(platformResult.value, {}) : {}
  isPlatformOnline.value = Boolean(health)
  platform.value = { robotId: info?.robotId || health?.robotId || '' }
  const failed = [
    healthResult.status === 'rejected' ? `健康检查：${healthResult.reason?.message || '失败'}` : '',
    platformResult.status === 'rejected' ? `平台信息：${platformResult.reason?.message || '失败'}` : ''
  ].filter(Boolean)
  if (failed.length) {
    platformError.value = failed.join('；')
    console.error('平台状态读取失败：', failed.join('；'))
  }
}

onMounted(fetchReady)
</script>

<template>
  <div class="app-shell">
    <aside class="app-sidebar">
      <div class="brand">
        <div class="brand-mark">IR</div>
        <div>
          <strong>巡检机器人</strong>
          <span>ROBOT CONTROL</span>
        </div>
      </div>

      <el-scrollbar class="sidebar-scroll">
        <nav class="sidebar-nav" aria-label="主导航">
          <RouterLink
            v-for="item in navigation"
            :key="item.path"
            :to="item.path"
            class="nav-item"
            :class="{ 'nav-item--active': activePath === item.path }"
          >
            <el-icon class="nav-icon"><component :is="item.icon" /></el-icon>
            <span>{{ item.label }}</span>
          </RouterLink>
        </nav>
      </el-scrollbar>

      <div class="sidebar-footer">
        <span :class="isPlatformOnline ? 'dot dot--online' : 'dot dot--offline'" />
        <div>
          <strong>{{ isPlatformOnline ? '系统在线' : '系统离线' }}</strong>
          <small :title="footerTitle">{{ footerText }}</small>
        </div>
      </div>
    </aside>

    <section class="app-main">
      <main class="page-content">
        <RouterView />
      </main>
    </section>
  </div>
</template>

<style scoped>
.app-shell {
  height: 100%;
  display: flex;
  overflow: hidden;
}

.app-sidebar {
  width: 248px;
  flex: 0 0 248px;
  height: 100%;
  padding: 22px 14px 16px;
  display: flex;
  flex-direction: column;
  background: #fff;
  color: #606266;
  border-right: 1px solid #e4e7ed;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 11px 22px;
}

.brand-mark {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  background: #409eff;
  color: #fff;
  font-weight: 800;
  letter-spacing: -1px;
}

.brand strong,
.brand span {
  display: block;
  line-height: 1.2;
}

.brand strong {
  color: #303133;
  font-size: 14px;
  letter-spacing: 1.4px;
}

.brand span {
  margin-top: 4px;
  color: #a8abb2;
  font-size: 9px;
  letter-spacing: 2px;
}

.sidebar-scroll {
  flex: 1;
  min-height: 0;
}

.sidebar-nav {
  padding-right: 4px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 13px;
  margin: 3px 0;
  border-radius: 4px;
  color: #606266;
  font-size: 14px;
  transition: 0.2s;
}

.nav-item:hover {
  color: #409eff;
  background: #f5f7fa;
}

.nav-item--active {
  color: #409eff;
  background: #ecf5ff;
  font-weight: 600;
}

.nav-icon {
  font-size: 17px;
}

.sidebar-footer {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 14px 12px 3px;
  border-top: 1px solid #f0f2f5;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.dot--online {
  background: #67c23a;
  box-shadow: 0 0 0 4px rgb(103 194 58 / 13%);
}

.dot--offline {
  background: #969696;
  box-shadow: 0 0 0 4px rgb(126 126 126 / 13%);
}

.sidebar-footer > div {
  min-width: 0;
}

.sidebar-footer strong,
.sidebar-footer small {
  display: block;
}

.sidebar-footer small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar-footer strong {
  color: #606266;
  font-size: 12px;
  font-weight: 600;
}

.sidebar-footer small {
  margin-top: 2px;
  color: #a8abb2;
  font-size: 10px;
}

.app-main {
  min-width: 0;
  min-height: 0;
  flex: 1;
  overflow-y: auto;
}

.page-content {
  padding: 26px 40px 40px;
}

@media (max-width: 900px) {
  .app-sidebar {
    width: 76px;
    flex-basis: 76px;
    padding: 18px 10px;
  }

  .brand {
    justify-content: center;
    padding: 0 0 20px;
  }

  .brand > div:last-child,
  .nav-item span,
  .sidebar-footer > div {
    display: none;
  }

  .nav-item {
    justify-content: center;
    padding: 11px 8px;
  }

  .sidebar-footer {
    justify-content: center;
    padding-left: 0;
    padding-right: 0;
  }

  .page-content {
    padding: 20px 22px 30px;
  }
}
</style>
