<script setup>
// 运行数据：全局采集会话记录（mission_runs）的服务端筛选 / 分页 + 中断后重跑。
// 与「任务管理」同一数据源：任务管理看单个任务的会话，这里看所有任务的会话。
import { computed, onMounted, ref, watch } from 'vue'
import { Refresh, RefreshRight, Search, VideoPlay } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import AsyncSection from '@/components/AsyncSection.vue'
import DataTable from '@/components/DataTable.vue'
import {
  RUN_STATES, canResumeRun, fetchRunsPage, resumeRun, runStateMeta
} from '@/api/runs'
import { useServerTable } from '@/composables/useServerTable'
import { useAsyncTask } from '@/composables/useAsyncTask'
import { useRefreshFeedback } from '@/composables/useRefreshFeedback'
import { formatTime } from '@/utils/format'

const keyword = ref('')
const statusFilter = ref('')
const interruptedTotal = ref(0)

const { pendingKey, run } = useAsyncTask()
const { refresh: refreshWithFeedback } = useRefreshFeedback()

const {
  rows, total, page, pageSize, loading, error, load, search, reload, setPage, setPageSize
} = useServerTable(fetchRunsPage, { pageSize: 10 })

// 列只保留后端真实返回的字段：
// 原来的「结束时间 / 执行描述 / 当前位置 / 站点总数」在 ui_runs 里根本不存在，
// 前三列恒为横杠、后两列恒为 0，看着像数据坏了。
const columns = [
  { prop: 'taskRunId', label: '执行 ID', minWidth: 180, fixed: 'left', slot: 'id' },
  { prop: 'missionName', label: '任务', minWidth: 160, formatter: (row) => row.missionName || row.missionId || '—' },
  { prop: 'startedAt', label: '开始时间', width: 175, formatter: (row) => (row.startedAt ? formatTime(row.startedAt) : '—') },
  { prop: 'finishedAt', label: '结束时间', width: 175, formatter: (row) => (row.finishedAt ? formatTime(row.finishedAt) : '—') },
  { prop: 'state', label: '执行状态', width: 110, slot: 'status' },
  { prop: 'currentStep', label: '当前步骤', width: 140, formatter: (row) => row.currentStep || '—' },
  { prop: 'failureCode', label: '失败码', width: 150, formatter: (row) => row.failureCode || '—' },
  { prop: 'actions', label: '操作', width: 120, fixed: 'right', slot: 'actions' }
]

const headerDescription = computed(() => {
  const scope = keyword.value || statusFilter.value ? '筛选结果' : '全部'
  return `${scope} ${total.value} 条运行记录 · 中断 ${interruptedTotal.value} 条`
})

let filterTimer = null
watch([keyword, statusFilter], () => {
  if (filterTimer) window.clearTimeout(filterTimer)
  filterTimer = window.setTimeout(() => {
    search({ keyword: keyword.value, state: statusFilter.value })
  }, 300)
})

onMounted(async () => {
  await load()
  await refreshInterruptedTotal()
})

/** 中断数是全局口径，分页后本地没有全量数据，单独取一次 total。 */
async function refreshInterruptedTotal() {
  try {
    const result = await fetchRunsPage({ state: 'interrupted', page: 1, pageSize: 1 })
    interruptedTotal.value = result.total
  } catch {
    interruptedTotal.value = 0
  }
}

async function resume(row) {
  try {
    await ElMessageBox.confirm(
      `重新开始一次采集（原会话 ${row.taskRunId}）？机器人与相机将重新进入采集状态，旧目录保留。`,
      '重跑确认',
      { type: 'warning', confirmButtonText: '重新开始', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const result = await run(`resume-${row.taskRunId}`, () => resumeRun(row.taskRunId), { success: '已重新开始一次采集' })
  if (result === undefined) return
  await reload()
  await refreshInterruptedTotal()
}

async function refresh() {
  await refreshWithFeedback(async () => {
    const ok = await reload()
    await refreshInterruptedTotal()
    return ok && !error.value
  }, { success: '运行记录已刷新', isError: () => error.value })
}

function resetFilters() {
  keyword.value = ''
  statusFilter.value = ''
}
</script>

<template>
  <div class="view">
    <PageHeader title="运行数据" :description="headerDescription">
      <template #extra>
        <el-button :icon="Refresh" :loading="loading" @click="refresh">刷新</el-button>
      </template>
    </PageHeader>

    <AsyncSection :loading="loading && !rows.length" :error="error" loading-text="正在加载运行记录…" @retry="load">
      <section class="view-panel">
        <div class="view-toolbar">
          <div class="view-toolbar__actions">
            <el-input v-model="keyword" class="filter-search" placeholder="按执行 ID / 任务 ID / 任务名搜索" :prefix-icon="Search" clearable />
            <el-select v-model="statusFilter" class="filter-select" placeholder="执行状态" clearable>
              <el-option v-for="item in RUN_STATES" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
            <el-button text :icon="RefreshRight" @click="resetFilters">重置</el-button>
          </div>
          <span class="view-toolbar__hint">共 {{ total }} 条</span>
        </div>

        <DataTable
          :rows="rows"
          :columns="columns"
          :loading="loading"
          row-key="taskRunId"
          :page="page"
          :page-size="pageSize"
          :total="total"
          empty-text="暂无运行记录，去「任务管理」启动一次采集"
          @page-change="setPage"
          @size-change="setPageSize"
        >
          <template #cell-id="{ row }">
            <span class="text-mono">{{ row.taskRunId }}</span>
          </template>
          <template #cell-status="{ row }">
            <el-tag :type="runStateMeta(row.state).tag" effect="light" size="small">{{ runStateMeta(row.state).label }}</el-tag>
          </template>
          <template #cell-actions="{ row }">
            <el-button
              text
              type="primary"
              size="small"
              :icon="VideoPlay"
              :disabled="!canResumeRun(row)"
              :loading="pendingKey === `resume-${row.taskRunId}`"
              @click="resume(row)"
            >
              重跑
            </el-button>
          </template>
        </DataTable>
      </section>
    </AsyncSection>
  </div>
</template>

<style scoped>
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
