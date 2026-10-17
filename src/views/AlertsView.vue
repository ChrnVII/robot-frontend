<script setup>
// 告警数据：服务端筛选 / 分页 + 定时自动刷新 + 登记处理结果。
// 告警是"需要立刻知道"的数据，所以这里除了列表本身，还负责：
//   1. 15s 自动刷新（页面可见时才跑）；
//   2. 数量增加时在页面顶部提示「有 N 条新告警」；
//   3. 侧栏角标与桌面通知由 usePlatformStatus 统一负责，避免重复弹两次。
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Check, Delete, Refresh, RefreshRight, Search, Warning } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import AsyncSection from '@/components/AsyncSection.vue'
import DataTable from '@/components/DataTable.vue'
import {
  ALERT_LEVELS, ALERT_STATUSES, alertLevelMeta, alertStatusMeta,
  deleteAlert, fetchAlertsPage, handleAlert
} from '@/api/alerts'
import { useServerTable } from '@/composables/useServerTable'
import { useAsyncTask } from '@/composables/useAsyncTask'
import { useRefreshFeedback } from '@/composables/useRefreshFeedback'
import { formatTime } from '@/utils/format'

//: 自动刷新间隔：比侧栏角标（20s）快一点，保证停留在此页时列表跟得上。
const AUTO_REFRESH_MS = 15000

const keyword = ref('')
const levelFilter = ref('')
const statusFilter = ref('')
const autoRefresh = ref(true)
const newAlertCount = ref(0)

const handleVisible = ref(false)
const handleForm = reactive({ alertId: '', status: 'handled', result: '' })

const { pendingKey, run } = useAsyncTask()
const { refresh: refreshWithFeedback } = useRefreshFeedback()

const {
  rows, total, page, pageSize, loading, error, load, search, reload, setPage, setPageSize
} = useServerTable(fetchAlertsPage, { pageSize: 10 })

const columns = [
  { prop: 'createdAt', label: '告警时间', width: 170, formatter: (row) => formatTime(row.createdAt) },
  { prop: 'level', label: '等级', width: 90, slot: 'level' },
  { prop: 'type', label: '告警类型', width: 130, formatter: (row) => row.type || '—' },
  { prop: 'status', label: '处理状态', width: 110, slot: 'status' },
  { prop: 'station', label: '站点', width: 80 },
  { prop: 'cage', label: '鸡笼', width: 80 },
  { prop: 'layer', label: '层', width: 70 },
  { prop: 'content', label: '告警内容', minWidth: 220, showOverflowTooltip: true },
  { prop: 'result', label: '处理结果', minWidth: 160, formatter: (row) => row.result || '—' },
  { prop: 'taskRunId', label: '执行 ID', width: 180, slot: 'run' },
  { prop: 'imageName', label: '图片名称', width: 200, showOverflowTooltip: true },
  { prop: 'actions', label: '操作', width: 170, fixed: 'right', slot: 'actions' }
]

// 顶部概览改为按状态各取一次 total：分页之后本地已没有全量数据可统计。
const summary = reactive({ open: 0, handled: 0, critical: 0 })

const headerDescription = computed(() => {
  const scope = keyword.value || levelFilter.value || statusFilter.value ? '筛选结果' : '全部'
  return `${scope} ${total.value} 条告警 · 待处理 ${summary.open} 条 · 严重 ${summary.critical} 条`
})

let filterTimer = null
watch([keyword, levelFilter, statusFilter], () => {
  if (filterTimer) window.clearTimeout(filterTimer)
  filterTimer = window.setTimeout(() => {
    search({ keyword: keyword.value, level: levelFilter.value, status: statusFilter.value })
  }, 300)
})

let autoTimer = null

onMounted(async () => {
  await load()
  await refreshSummary()
  startAuto()
  document.addEventListener('visibilitychange', handleVisibility)
})

onBeforeUnmount(() => {
  stopAuto()
  document.removeEventListener('visibilitychange', handleVisibility)
})

function startAuto() {
  stopAuto()
  if (!autoRefresh.value) return
  autoTimer = window.setInterval(silentRefresh, AUTO_REFRESH_MS)
}

function stopAuto() {
  if (autoTimer) {
    window.clearInterval(autoTimer)
    autoTimer = null
  }
}

function handleVisibility() {
  if (document.hidden) {
    stopAuto()
    return
  }
  silentRefresh()
  startAuto()
}

function toggleAuto(value) {
  autoRefresh.value = value
  if (value) startAuto()
  else stopAuto()
}

/** 自动刷新：只更新数据，不弹 toast，也不显示整页骨架。 */
async function silentRefresh() {
  if (loading.value) return
  const before = total.value
  const ok = await reload()
  if (!ok) return
  // 只有翻在第一页时才提示新增数量，否则用户正在看历史记录，提示无意义
  if (page.value === 1 && total.value > before && !keyword.value && !levelFilter.value && !statusFilter.value) {
    newAlertCount.value += total.value - before
  }
  await refreshSummary()
}

async function refreshSummary() {
  const [open, handled, critical] = await Promise.allSettled([
    fetchAlertsPage({ status: 'open', page: 1, pageSize: 1 }),
    fetchAlertsPage({ status: 'handled', page: 1, pageSize: 1 }),
    fetchAlertsPage({ level: 'critical', page: 1, pageSize: 1 })
  ])
  const pick = (result) => (result.status === 'fulfilled' ? result.value.total : 0)
  summary.open = pick(open)
  summary.handled = pick(handled)
  summary.critical = pick(critical)
}

function openHandle(row) {
  handleForm.alertId = row.alertId
  handleForm.status = row.status === 'open' ? 'handled' : row.status
  handleForm.result = row.result || ''
  handleVisible.value = true
}

/** 通知应用外壳立即刷新侧栏待处理角标，不用等下一轮轮询。 */
function notifyAlertsChanged() {
  window.dispatchEvent(new CustomEvent('alerts:changed'))
}

async function submitHandle() {
  if (!handleForm.result.trim()) {
    ElMessage.warning('请填写处理说明')
    return
  }
  const result = await run('handle', () => handleAlert(handleForm.alertId, {
    status: handleForm.status,
    result: handleForm.result.trim()
  }), { success: '处理结果已登记' })
  if (result === undefined) return
  handleVisible.value = false
  await reload()
  await refreshSummary()
  notifyAlertsChanged()
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`删除告警 ${row.alertId}？删除后不再出现在列表中。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  const result = await run(`delete-${row.alertId}`, () => deleteAlert(row.alertId), { success: '告警已删除' })
  if (result === undefined) return
  await reload()
  await refreshSummary()
  notifyAlertsChanged()
}

async function refresh() {
  await refreshWithFeedback(async () => {
    const ok = await reload()
    await refreshSummary()
    newAlertCount.value = 0
    return ok && !error.value
  }, { success: '告警列表已刷新', isError: () => error.value })
}

function resetFilters() {
  keyword.value = ''
  levelFilter.value = ''
  statusFilter.value = ''
}
</script>

<template>
  <div class="view">
    <PageHeader
      title="告警数据"
      :description="headerDescription"
      :status-text="summary.open ? '有待处理告警' : '暂无待处理'"
      :status-type="summary.open ? 'warning' : 'success'"
    >
      <template #extra>
        <label class="auto-refresh" :title="`每 ${AUTO_REFRESH_MS / 1000} 秒自动刷新；页面切到后台时暂停`">
          <el-switch :model-value="autoRefresh" size="small" @update:model-value="toggleAuto" />
          <span>自动刷新</span>
        </label>
        <el-button :icon="Refresh" :loading="loading" @click="refresh">刷新</el-button>
      </template>
    </PageHeader>

    <!-- 新告警横幅：只在页面上主动发现数量增长时出现，点掉即消失 -->
    <el-alert
      v-if="newAlertCount > 0"
      class="new-alert-bar"
      type="warning"
      show-icon
      :closable="true"
      :title="`新增 ${newAlertCount} 条待处理告警`"
      @close="newAlertCount = 0"
    >
      <template #default>
        <span class="new-alert-bar__text">列表已自动刷新。如需查看最新记录，请回到第一页或点击刷新。</span>
        <el-button
          size="small"
          type="warning"
          plain
          :icon="Warning"
          @click="setPage(1); newAlertCount = 0"
        >
          查看最新
        </el-button>
      </template>
    </el-alert>

    <AsyncSection :loading="loading && !rows.length" :error="error" loading-text="正在加载告警数据…" @retry="load">
      <section class="view-panel">
        <div class="view-toolbar">
          <div class="view-toolbar__actions">
            <el-input v-model="keyword" class="filter-search" placeholder="按内容、告警 ID 或执行 ID 搜索" :prefix-icon="Search" clearable />
            <el-select v-model="levelFilter" class="filter-select" placeholder="告警等级" clearable>
              <el-option v-for="item in ALERT_LEVELS" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
            <el-select v-model="statusFilter" class="filter-select" placeholder="处理状态" clearable>
              <el-option v-for="item in ALERT_STATUSES" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
            <el-button text :icon="RefreshRight" @click="resetFilters">重置</el-button>
          </div>
          <span class="view-toolbar__hint">共 {{ total }} 条 · 已处理 {{ summary.handled }} 条</span>
        </div>

        <DataTable
          :rows="rows"
          :columns="columns"
          :loading="loading"
          row-key="alertId"
          :page="page"
          :page-size="pageSize"
          :total="total"
          empty-text="暂无告警，设备与任务运行正常"
          @page-change="setPage"
          @size-change="setPageSize"
        >
          <template #cell-level="{ row }">
            <el-tag :type="alertLevelMeta(row.level).tag" effect="light" size="small">{{ alertLevelMeta(row.level).label }}</el-tag>
          </template>
          <template #cell-status="{ row }">
            <el-tag :type="alertStatusMeta(row.status).tag" effect="plain" size="small">{{ alertStatusMeta(row.status).label }}</el-tag>
          </template>
          <template #cell-run="{ row }">
            <span class="text-mono">{{ row.taskRunId || '—' }}</span>
          </template>
          <template #cell-actions="{ row }">
            <el-button
              text
              type="primary"
              size="small"
              :icon="Check"
              :disabled="row.status === 'closed'"
              @click="openHandle(row)"
            >
              登记处理
            </el-button>
            <el-button
              text
              type="danger"
              size="small"
              :icon="Delete"
              :loading="pendingKey === `delete-${row.alertId}`"
              @click="remove(row)"
            >
              删除
            </el-button>
          </template>
        </DataTable>
      </section>
    </AsyncSection>

    <el-dialog v-model="handleVisible" title="登记处理结果" width="520px">
      <el-form label-width="90px">
        <el-form-item label="告警 ID">
          <span class="text-mono">{{ handleForm.alertId }}</span>
        </el-form-item>
        <el-form-item label="处理状态">
          <el-radio-group v-model="handleForm.status">
            <el-radio v-for="item in ALERT_STATUSES" :key="item.value" :value="item.value">{{ item.label }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="处理说明">
          <el-input v-model="handleForm.result" type="textarea" :rows="3" placeholder="记录现场处理方式，便于后续追溯" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="handleVisible = false">取消</el-button>
        <el-button type="primary" :loading="pendingKey === 'handle'" @click="submitHandle">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.auto-refresh {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--app-text-secondary);
  font-size: 13px;
  cursor: pointer;
  user-select: none;
}

.new-alert-bar__text {
  margin-right: 12px;
  font-size: 13px;
}

.filter-search {
  width: 260px;
}

.filter-select {
  width: 140px;
}

@media (max-width: 900px) {
  .filter-search {
    width: 100%;
  }
}
</style>
