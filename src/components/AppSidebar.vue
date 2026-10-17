<script setup>
// 侧边栏：分组导航、真实状态灯、告警角标、主题与提醒开关。
//
// 状态灯的改造重点：以前 App.vue 只在挂载时查一次 /healthz，绿点永远亮着，
// 后端挂了界面还显示「系统在线」。现在状态由 usePlatformStatus 每 30s 轮询，
// 并区分「检测中 / 在线 / 离线」三态。
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  ArrowLeft, ArrowRight, Bell, MuteNotification, Sunny, Moon
} from '@element-plus/icons-vue'
import { DASHBOARD_MODULES } from '@/api/dashboard'
import { NAV_GROUPS, moduleGroup, moduleIcon } from '@/composables/useModuleMeta'
import { useTheme } from '@/composables/useTheme'
import { useAlertNotifier } from '@/composables/useAlertNotifier'

const props = defineProps({
  status: { type: String, default: 'checking' }, // checking | online | offline
  statusText: { type: String, default: '正在检测后端' },
  statusHint: { type: String, default: '' },
  robotId: { type: String, default: '' },
  openAlerts: { type: Number, default: 0 },
  checkedAt: { type: String, default: '' }
})

const route = useRoute()
const { isDark, toggle: toggleTheme } = useTheme()
const { permission, muted, requestPermission, toggleMute } = useAlertNotifier()

const COLLAPSE_KEY = 'app-sidebar-collapsed'
const collapsed = ref(readCollapsed())

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch {
    return false
  }
}

watch(collapsed, (value) => {
  try {
    localStorage.setItem(COLLAPSE_KEY, value ? '1' : '0')
  } catch {
    /* 隐私模式忽略 */
  }
  // 把折叠状态同步到 <html>：其他页面（如底盘循迹的登录遮罩）需要知道
  // 侧栏当前实际占多宽，才能让开正确的距离。
  syncSidebarFlag(value)
})

function syncSidebarFlag(value) {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.sidebar = value ? 'collapsed' : 'expanded'
}

syncSidebarFlag(collapsed.value)

// 底盘循迹对接的是独立后端，不属于 dashboard 模块，单独挂在「设备控制」组。
const TRACK_NAV_ITEM = { key: 'track', path: '/track', label: '底盘循迹' }

const navigation = computed(() => {
  const items = [
    { key: 'home', path: '/home', label: '运行总览' },
    ...DASHBOARD_MODULES.map((module) => ({
      key: module.key,
      path: module.path,
      label: module.label
    })),
    TRACK_NAV_ITEM
  ].map((item) => ({
    ...item,
    icon: moduleIcon(item.key),
    group: moduleGroup(item.key)
  }))

  return NAV_GROUPS
    .map((group) => ({ ...group, items: items.filter((item) => item.group === group.key) }))
    .filter((group) => group.items.length)
})

// 折叠时给每个图标配 tooltip，否则用户只能看到一排无语义的图标。
const showTooltip = computed(() => collapsed.value)

const statusLabel = computed(() => {
  if (props.status === 'checking') return '检测中'
  return props.status === 'online' ? '在线' : '离线'
})

const alertCountText = computed(() => (props.openAlerts > 99 ? '99+' : String(props.openAlerts)))

function isActive(path) {
  return route.path === path
}

function toggleCollapse() {
  collapsed.value = !collapsed.value
}

async function handleAlertAction() {
  if (permission.value === 'unsupported') {
    ElMessage.warning('当前浏览器不支持桌面通知，仍会使用侧栏角标与提示音提醒')
    return
  }
  if (permission.value === 'granted') {
    toggleMute()
    ElMessage.success(muted.value ? '已静音告警提示音' : '已开启告警提示音')
    return
  }
  if (permission.value === 'denied') {
    ElMessage.warning('通知权限已被浏览器拒绝，请在站点设置里重新允许')
    return
  }
  const result = await requestPermission()
  if (result === 'granted') {
    ElMessage.success('已开启桌面通知，新告警会同时提示声音')
  } else {
    ElMessage.info('未获得通知权限，将只使用侧栏角标提醒')
  }
}

const alertActionLabel = computed(() => {
  if (permission.value === 'granted') return muted.value ? '开启提示音' : '静音提示音'
  return '开启桌面通知'
})
</script>

<template>
  <aside class="app-sidebar" :class="{ 'is-collapsed': collapsed }">
    <!-- 品牌行 + 折叠按钮：按钮固定在顶行右侧，展开/折叠都停在同一位置，
         用户不用去找它跑到哪里去了 -->
    <div class="sidebar-head">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">IR</div>
        <div class="brand-copy">
          <strong>巡检机器人</strong>
          <span>ROBOT CONTROL</span>
        </div>
      </div>
      <button
        type="button"
        class="collapse-toggle"
        :aria-label="collapsed ? '展开侧栏' : '收起侧栏'"
        :aria-expanded="!collapsed"
        @click="toggleCollapse"
      >
        <el-icon><ArrowRight v-if="collapsed" /><ArrowLeft v-else /></el-icon>
      </button>
    </div>

    <el-scrollbar class="sidebar-scroll">
      <nav class="sidebar-nav" aria-label="主导航">
        <div v-for="group in navigation" :key="group.key" class="nav-group">
          <p class="group-label">{{ group.label }}</p>
          <el-tooltip
            v-for="item in group.items"
            :key="item.path"
            :content="item.label"
            placement="right"
            :disabled="!showTooltip"
            :show-after="150"
          >
            <RouterLink
              :to="item.path"
              class="nav-item"
              :class="{ 'nav-item--active': isActive(item.path) }"
              :aria-current="isActive(item.path) ? 'page' : undefined"
            >
              <el-icon class="nav-icon"><component :is="item.icon" /></el-icon>
              <span class="nav-label">{{ item.label }}</span>
              <!-- 告警角标：待处理数量直接挂在入口上，不用点进去才知道 -->
              <span
                v-if="item.key === 'alerts' && openAlerts > 0"
                class="nav-badge"
                :aria-label="`${openAlerts} 条待处理告警`"
              >{{ alertCountText }}</span>
            </RouterLink>
          </el-tooltip>
        </div>
      </nav>
    </el-scrollbar>

    <div class="sidebar-footer">
      <div
        class="status-line"
        :class="`status-line--${status}`"
        :title="statusHint"
        role="status"
        aria-live="polite"
      >
        <span class="status-dot" aria-hidden="true" />
        <div class="status-copy">
          <strong>{{ statusText }}</strong>
          <small>{{ statusHint }}</small>
        </div>
        <span class="status-badge">{{ statusLabel }}</span>
      </div>

      <div class="footer-actions">
        <el-tooltip :content="alertActionLabel" placement="top" :show-after="150">
          <button type="button" class="ghost-btn" :aria-label="alertActionLabel" @click="handleAlertAction">
            <el-icon><MuteNotification v-if="permission === 'granted' && muted" /><Bell v-else /></el-icon>
          </button>
        </el-tooltip>
        <el-tooltip :content="isDark ? '切换到浅色' : '切换到深色'" placement="top" :show-after="150">
          <button type="button" class="ghost-btn" :aria-label="isDark ? '切换到浅色' : '切换到深色'" @click="toggleTheme">
            <el-icon><Sunny v-if="isDark" /><Moon v-else /></el-icon>
          </button>
        </el-tooltip>
      </div>
    </div>
  </aside>
</template>

<style scoped>
/* 侧栏视觉参考 1Panel：浅蓝底 + 半透明白卡片导航，
   选中项为白底 + 主色描边 + 左侧短竖条；折叠按钮常驻品牌行右侧。 */
.app-sidebar {
  width: var(--app-sidebar-width);
  flex: 0 0 var(--app-sidebar-width);
  height: 100%;
  /* 左右内边距单独留成变量：折叠按钮要让圆心落在侧栏边界上，
     需要按这个 padding 做补偿，否则按钮会整个缩在栏内。 */
  --sidebar-pad-x: 12px;

  padding: 18px var(--sidebar-pad-x) 14px;
  display: flex;
  flex-direction: column;
  /* 左上角一层柔和白光，避免整块纯色显得发死（与参考图一致） */
  background:
    radial-gradient(120% 55% at 8% 0%, var(--app-sidebar-glow), transparent 62%),
    var(--app-sidebar-bg);
  border-right: 1px solid var(--app-border);
  transition: width 0.2s ease, flex-basis 0.2s ease, padding 0.2s ease;
}

.app-sidebar.is-collapsed {
  --sidebar-pad-x: 8px;

  width: var(--app-sidebar-width-collapsed);
  flex-basis: var(--app-sidebar-width-collapsed);
}

/* ------------------------------ 品牌行 ------------------------------ */

.sidebar-head {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 2px 18px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
}

.brand-mark {
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  background: linear-gradient(135deg, #2b7fe4, #4a9bf7);
  color: #fff;
  font-weight: 700;
  font-size: 13px;
  letter-spacing: -0.5px;
  box-shadow: 0 2px 8px rgb(43 127 228 / 28%);
}

.brand-copy strong,
.brand-copy span {
  display: block;
  line-height: 1.25;
  white-space: nowrap;
}

.brand-copy strong {
  color: var(--app-text);
  font-size: 14px;
  font-weight: 600;
}

.brand-copy span {
  color: var(--app-text-muted);
  font-size: 10px;
  letter-spacing: 1.6px;
}

/* 折叠按钮：圆形、带描边与轻投影。
   绝对定位，right = 按钮半径(14) + 侧栏内边距，圆心正好压在侧栏边界上，
   一半在栏内、一半盖住内容区（与参考图一致）；品牌文字也不必为它让位。 */
.collapse-toggle {
  position: absolute;
  top: 50%;
  right: calc(-14px - var(--sidebar-pad-x));
  transform: translateY(-50%);
  z-index: 3;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1px solid var(--app-border-strong);
  background: var(--app-surface);
  color: var(--app-text-secondary);
  font-size: 12px;
  cursor: pointer;
  box-shadow: var(--app-shadow-sm);
  transition: color 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
}

.collapse-toggle:hover {
  color: var(--app-primary);
  border-color: var(--app-primary);
}

.collapse-toggle:active {
  transform: translateY(-50%) scale(0.94);
}

/* 折叠态：只留图标，按钮仍在右侧同一行 */
.app-sidebar.is-collapsed .sidebar-head {
  gap: 6px;
  padding: 0 0 14px;
  justify-content: center;
}

.app-sidebar.is-collapsed .brand {
  flex: 0 0 auto;
  gap: 0;
}

.app-sidebar.is-collapsed .brand-mark {
  width: 28px;
  height: 28px;
  flex-basis: 28px;
  border-radius: 8px;
  font-size: 11px;
}

.app-sidebar.is-collapsed .brand-copy {
  display: none;
}

/* ------------------------------ 导航 ------------------------------ */

.sidebar-scroll {
  flex: 1;
  min-height: 0;
}

.nav-group + .nav-group {
  margin-top: 12px;
}

.group-label {
  padding: 0 10px;
  margin-bottom: 6px;
  color: var(--app-text-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
}

/* 导航项：卡片式，默认半透明白，hover 更实 */
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 42px;
  padding: 10px 12px;
  margin-bottom: 6px;
  border-radius: 9px;
  border: 1.5px solid transparent;
  background: var(--app-sidebar-item);
  color: var(--app-text-secondary);
  font-size: 13.5px;
  transition: background 0.15s ease, color 0.15s ease,
    border-color 0.15s ease, box-shadow 0.15s ease;
}

.nav-item:hover {
  background: var(--app-sidebar-item-hover);
  color: var(--app-text);
}

/* 选中：白底 + 主色描边 + 左侧短竖条 */
.nav-item--active,
.nav-item--active:hover {
  background: var(--app-sidebar-active);
  border-color: var(--app-primary);
  color: var(--app-primary);
  font-weight: 600;
  box-shadow: var(--app-shadow-sm);
}

.nav-item--active::before {
  content: '';
  position: absolute;
  left: 5px;
  top: 50%;
  width: 3px;
  height: 16px;
  border-radius: 2px;
  background: var(--app-primary);
  transform: translateY(-50%);
}

.nav-icon {
  font-size: 18px;
  flex: 0 0 auto;
}

.nav-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 折叠态：卡片变成方形的纯图标块，分组之间用细分隔线代替标题 */
.app-sidebar.is-collapsed .group-label {
  display: none;
}

.app-sidebar.is-collapsed .nav-group + .nav-group {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--app-border-strong);
}

.app-sidebar.is-collapsed .nav-item {
  justify-content: center;
  min-height: 40px;
  padding: 10px 0;
  margin-bottom: 6px;
}

.app-sidebar.is-collapsed .nav-label {
  display: none;
}

.nav-badge {
  margin-left: auto;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: var(--app-danger);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

/* 折叠时角标缩成小红点，钉在图标卡片右上角 */
.app-sidebar.is-collapsed .nav-badge {
  position: absolute;
  top: 6px;
  right: 8px;
  min-width: 8px;
  width: 8px;
  height: 8px;
  padding: 0;
  font-size: 0;
}

/* ------------------------------ 底部状态 ------------------------------ */

.sidebar-footer {
  padding-top: 10px;
  border-top: 1px solid var(--app-border);
}

.status-line {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border-radius: 9px;
  background: var(--app-sidebar-item);
}

/* 折叠态：状态卡只留指示灯，避免看起来像第 13 个导航项 */
.app-sidebar.is-collapsed .status-line {
  justify-content: center;
  padding: 10px 0;
  background: transparent;
}

.status-dot {
  width: 8px;
  height: 8px;
  flex: 0 0 8px;
  border-radius: 50%;
  background: var(--app-text-muted);
}

.status-line--online .status-dot {
  background: var(--app-success);
  box-shadow: 0 0 0 3px rgb(47 158 95 / 18%);
}

.status-line--offline .status-dot {
  background: var(--app-danger);
  box-shadow: 0 0 0 3px rgb(214 69 69 / 18%);
}

/* 检测中：呼吸动画，明确表达"还没得出结论"而不是"在线" */
.status-line--checking .status-dot {
  background: var(--app-warning);
  animation: pulse 1.4s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}

.status-copy {
  min-width: 0;
  flex: 1;
}

.status-copy strong,
.status-copy small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-copy strong {
  color: var(--app-text);
  font-size: 12px;
  font-weight: 600;
}

.status-copy small {
  color: var(--app-text-muted);
  font-size: 11px;
}

.app-sidebar.is-collapsed .status-copy,
.app-sidebar.is-collapsed .status-badge {
  display: none;
}

.status-badge {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--app-surface);
  color: var(--app-text-muted);
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
}

.status-line--online .status-badge {
  background: rgb(47 158 95 / 12%);
  color: var(--app-success);
}

.status-line--offline .status-badge {
  background: rgb(214 69 69 / 12%);
  color: var(--app-danger);
}

.footer-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  margin-top: 6px;
}

.app-sidebar.is-collapsed .footer-actions {
  justify-content: center;
  gap: 2px;
}

.ghost-btn {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--app-text-muted);
  font-size: 15px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.ghost-btn:hover {
  background: var(--app-sidebar-item-hover);
  color: var(--app-text);
}

/* ------------------------------ 深色模式 ------------------------------
   线性图标在深色底上的视觉重量天然低于文字，如果只靠继承色会比文字
   暗一档、看起来"糊"在背景里。这里把导航图标单独提亮，并保证选中项
   仍然是主色，不被下面的通用规则覆盖。 */
html.dark .nav-item {
  color: #bfccda;
}

html.dark .nav-item .nav-icon {
  color: #d5e1ee;
}

html.dark .nav-item--active,
html.dark .nav-item--active .nav-icon {
  color: var(--app-primary);
}

html.dark .group-label {
  color: #8593a3;
}

html.dark .brand-copy span {
  color: #93a1b0;
}

html.dark .ghost-btn {
  color: #9dabba;
}

/* <900px：强制收起为图标栏，保证内容区宽度 */
@media (max-width: 900px) {
  .app-sidebar,
  .app-sidebar.is-collapsed {
    --sidebar-pad-x: 8px;

    width: var(--app-sidebar-width-collapsed);
    flex-basis: var(--app-sidebar-width-collapsed);
  }

  .sidebar-head {
    gap: 6px;
    padding: 0 0 14px;
    justify-content: center;
  }

  .brand {
    flex: 0 0 auto;
    gap: 0;
  }

  .brand-mark {
    width: 28px;
    height: 28px;
    flex-basis: 28px;
    border-radius: 8px;
    font-size: 11px;
  }

  .brand-copy,
  .group-label,
  .nav-label,
  .status-copy,
  .status-badge {
    display: none;
  }

  .nav-group + .nav-group {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--app-border-strong);
  }

  /* 窄屏是强制折叠：此时折叠按钮点了也不会展开，直接隐藏，避免无效交互 */
  .collapse-toggle {
    display: none;
  }

  .nav-item {
    justify-content: center;
    min-height: 40px;
    padding: 10px 0;
    margin-bottom: 6px;
  }

  .nav-badge {
    position: absolute;
    top: 6px;
    right: 8px;
    min-width: 8px;
    width: 8px;
    height: 8px;
    padding: 0;
    font-size: 0;
  }

  .status-line {
    justify-content: center;
    padding: 10px 0;
  }

  .footer-actions {
    justify-content: center;
    gap: 2px;
  }
}
</style>
