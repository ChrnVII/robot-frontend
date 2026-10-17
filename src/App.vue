<script setup>
// 应用外壳：左侧固定导航 + 右侧页面内容。
// 导航项与 api/dashboard.js 的模块定义同源，新增页面只需改一处；
// 侧栏的在线状态由 usePlatformStatus 轮询得到，不再是"挂载时查一次"的假灯。
import { computed, onMounted } from 'vue'
import { RouterView } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import AppSidebar from '@/components/AppSidebar.vue'
import { usePlatformStatus } from '@/composables/usePlatformStatus'

const platform = usePlatformStatus()

// 健康检查与平台信息失败时原因通常相同（都在连同一个后端），
// 横幅只取第一条，完整信息挂在 title 上，避免条带占两行把内容往下推。
const shortError = computed(() => String(platform.error || '健康检查未通过').split('；')[0])

onMounted(platform.start)

async function retry() {
  await platform.refresh()
  // platform 是 reactive 对象，属性已解包，直接读布尔值
  ElMessage[platform.online ? 'success' : 'error'](
    platform.online ? '后端已恢复连接' : '仍然无法连接后端，请检查服务'
  )
}
</script>

<template>
  <div class="app-shell">
    <AppSidebar
      :status="platform.status"
      :status-text="platform.statusText"
      :status-hint="platform.statusHint"
      :robot-id="platform.robotId"
      :open-alerts="platform.openAlerts"
      :checked-at="platform.checkedAt"
    />

    <section class="app-main">
      <div v-if="platform.status === 'offline'" class="offline-banner" role="alert">
        <span class="offline-banner__dot" aria-hidden="true" />
        <span class="offline-banner__text" :title="platform.error || shortError">
          后端连接中断：{{ shortError }}。页面数据可能不是最新的。
        </span>
        <el-button size="small" type="primary" plain :icon="Refresh" @click="retry">重新检测</el-button>
      </div>

      <main class="page-content">
        <RouterView v-slot="{ Component, route }">
          <transition name="route-fade" mode="out-in">
            <component :is="Component" :key="route.path" />
          </transition>
        </RouterView>
      </main>
    </section>
  </div>
</template>

<style scoped>
.app-shell {
  height: 100%;
  display: flex;
  overflow: hidden;
  background: var(--app-bg);
}

.app-main {
  min-width: 0;
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  /* 内容自身的横向滚动交给表格内部处理，外层不再整体横移 */
  overflow-x: hidden;
  overflow-y: auto;
}

.page-content {
  padding: 24px var(--app-page-gutter) 36px;
  flex: 1;
  min-width: 0;
  max-width: 100%;
}

/* 离线条常驻在内容顶部：比只在侧栏点一个小红点更容易被注意到 */
.offline-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 16px;
  background: rgb(214 69 69 / 8%);
  border-bottom: 1px solid rgb(214 69 69 / 22%);
  color: var(--app-danger);
  font-size: 13px;
}

/* 深色背景下 8% 的红色几乎看不见，提高不透明度 */
:global(html.dark) .offline-banner {
  background: rgb(240 115 111 / 14%);
  border-bottom-color: rgb(240 115 111 / 32%);
  color: #ffa8a4;
}

.offline-banner__dot {
  width: 8px;
  height: 8px;
  flex: 0 0 8px;
  border-radius: 50%;
  background: var(--app-danger);
}

.offline-banner__text {
  flex: 1;
  min-width: 0;
  /* 单行省略：不换行时按钮才有位置留在一行内；完整信息在 title 里 */
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

@media (max-width: 900px) {
  .page-content {
    padding: 16px var(--app-page-gutter) 28px;
  }

  .offline-banner {
    font-size: 12px;
    gap: 8px;
  }

  /* 窄屏文案截一半就够了，按钮必须完整可见 */
  .offline-banner__text {
    flex: 1 1 120px;
  }
}
</style>
