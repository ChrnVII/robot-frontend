<script setup>
import { computed, onMounted, ref } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import { getPlatformInfo } from '@/api/system'

const route = useRoute()

const isPlatformOnline = ref(false)

const navigation = [

  { label: '运行总览', path: '/home', icon: '⌂' },
  { label: '智能检测', path: '/detect', icon: '◉' },
  { label: '任务管理', path: '/tasks', icon: '≡' },


  { label: '摄像头', path: '/cam', icon: '▣' },
  { label: '升降控制', path: '/lift', icon: '↕' },
  { label: '移动底盘', path: '/agv', icon: '▰' },
  { label: '地图站点', path: '/map', icon: '⌖' },


  { label: '参数设置', path: '/params', icon: '⚙' },
  { label: '运行数据', path: '/runs', icon: '◫' },
  { label: '告警数据', path: '/alerts', icon: '△' },
  { label: '默认任务', path: '/task-tmpl', icon: '✦' },

]


const pageTitle = computed(() => {
  return navigation.find((item) => item.path === route.path)?.label ?? '运行总览'
})

async function fetchPlatformInfo(){
  try {
    const resp = await getPlatformInfo()
    isPlatformOnline.value = resp?.status === 200
  } catch (error) {
    console.error('请求失败：', error)
    isPlatformOnline.value = false
  }
}

onMounted(() => {
  requestAnimationFrame(() => {
    fetchPlatformInfo()
  })
})

</script>




<template>
  <div class="app-shell">

    <aside class="app-sidebar">

      <div class="brand">
        <div class="brand-mark">IR</div><div><strong>巡检机器人</strong><span>ROBOT CONTROL</span></div>
      </div>

      <nav class="sidebar-nav" aria-label="主导航">
          <RouterLink v-for="item in navigation" :key="item.path" :to="item.path" class="nav-item">
            <span class="nav-icon">{{ item.icon }}</span><span>{{ item.label }}</span>
          </RouterLink>
      </nav>

      <div class="sidebar-footer">

          <template v-if="isPlatformOnline">
            <span class="online-dot"></span><div><strong>系统在线</strong><small>Inspection Robot</small></div>
          </template>
          <template v-else>
            <span class="offline-dot"></span><div><strong>系统离线</strong><small>Inspection Robot</small></div>
          </template>


        
      </div>

    </aside>

    <section class="app-main">

      <!-- <header class="app-header">
        <div><span class="header-kicker">CONTROL CENTER / 2026</span><h1>{{ pageTitle }}</h1></div>
        <div class="header-meta"><span>实时控制台</span><span class="header-user">管理员</span></div>
      </header> -->

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
  padding: 0 11px 28px;
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

.sidebar-nav {
  flex: 1;
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
  transition: .2s;
}

.nav-item:hover {
  color: #409eff;
  background: #f5f7fa;
}

.nav-item.router-link-active {
  color: #409eff;
  background: #ecf5ff;
  font-weight: 600;
}

.nav-icon {
  width: 18px;
  text-align: center;
  color: inherit;
  font-size: 17px;
  opacity: .9;
}

.sidebar-footer {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 14px 12px 3px;
  border-top: 1px solid #f0f2f5;
}

.online-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #67c23a;
  box-shadow: 0 0 0 4px rgba(103, 194, 58, .13);
}
.offline-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #969696;
  box-shadow: 0 0 0 4px rgba(126, 126, 126, 0.13);
}

.sidebar-footer strong,
.sidebar-footer small {
  display: block;
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

.app-header {
  height: 82px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 40px;
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
}

.header-kicker {
  color: #409eff;
  font-size: 10px;
  letter-spacing: 1.7px;
  font-weight: 700;
}

.app-header h1 {
  margin: 5px 0 0;
  color: #303133;
  font-size: 24px;
  letter-spacing: -.4px;
}

.header-meta {
  display: flex;
  align-items: center;
  gap: 20px;
  color: #909399;
  font-size: 12px;
}

.header-user {
  padding: 7px 12px;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  background: #fff;
  color: #606266;
}

.page-content {
  padding: 26px 40px 40px;
}

@media (max-width:900px) {
  .app-sidebar {
    width: 76px;
    flex-basis: 76px;
    padding: 18px 10px;
  }

  .brand {
    justify-content: center;
    padding: 0 0 26px;
  }

  .brand>div:last-child,
  .nav-item span:last-child,
  .sidebar-footer>div {
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

  .app-header {
    padding: 0 22px;
  }

  .page-content {
    padding: 20px 22px 30px;
  }
}
</style>
