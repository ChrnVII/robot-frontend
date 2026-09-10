<script setup>
import { computed } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'

const route = useRoute()
const navigation = [
  { label: '运行中心', items: [
    { label: '运行总览', path: '/home', icon: '⌂' },
    { label: '智能检测', path: '/detect', icon: '◉' },
    { label: '任务管理', path: '/tasks', icon: '≡' },
  ] },
  { label: '设备与资源', items: [
    { label: '摄像头', path: '/cam', icon: '▣' },
    { label: '升降控制', path: '/lift', icon: '↕' },
    { label: '移动底盘', path: '/agv', icon: '▰' },
    { label: '地图站点', path: '/map', icon: '⌖' },
  ] },
  { label: '系统管理', items: [
    { label: '参数设置', path: '/params', icon: '⚙' },
    { label: '运行数据', path: '/runs', icon: '◫' },
    { label: '告警数据', path: '/alerts', icon: '△' },
    { label: '默认任务', path: '/task-tmpl', icon: '✦' },
  ] },
]
const pageTitle = computed(() => {
  for (const group of navigation) {
    const item = group.items.find((entry) => entry.path === route.path)
    if (item) return item.label
  }
  return '运行总览'
})
</script>

<template>
  <div class="app-shell">
    <aside class="app-sidebar">
      <div class="brand"><div class="brand-mark">IR</div><div><strong>INSPECTION</strong><span>ROBOT CONTROL</span></div></div>
      <nav class="sidebar-nav" aria-label="主导航">
        <div v-for="group in navigation" :key="group.label" class="nav-group">
          <div class="nav-group-title">{{ group.label }}</div>
          <RouterLink v-for="item in group.items" :key="item.path" :to="item.path" class="nav-item">
            <span class="nav-icon">{{ item.icon }}</span><span>{{ item.label }}</span>
          </RouterLink>
        </div>
      </nav>
      <div class="sidebar-footer"><span class="online-dot"></span><div><strong>系统在线</strong><small>Inspection Robot</small></div></div>
    </aside>
    <section class="app-main">
      <header class="app-header"><div><span class="header-kicker">CONTROL CENTER / 2026</span><h1>{{ pageTitle }}</h1></div><div class="header-meta"><span>实时控制台</span><span class="header-user">管理员</span></div></header>
      <main class="page-content"><RouterView /></main>
    </section>
  </div>
</template>
