<script setup>
// 运行数据：服务端筛选 / 分页 + 断点续跑 + 删除记录。
import { computed, onMounted, ref, watch } from 'vue'
import { Delete, Refresh, RefreshRight, Search, VideoPlay } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import AsyncSection from '@/components/AsyncSection.vue'
import DataTable from '@/components/DataTable.vue'
import {
  canResumeRun, deleteRun, fetchRunsPage, resumeRun, runStatusLabel, runStatusTagType
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

const columns = [
  { prop: 'taskRunId', label: '执行 ID', minWidth: 180, fixed: 'left', slot: 'id' },
  { prop: 'startTime', label: '开始时间', width: 175, formatter: (row) => formatTime(row.startTime) },
  { prop: 'endTime', label: '结束时间', width: 175, formatter: (row) => formatTime(row.endTime) },
  { prop: 'status', label: '执行状态', width: 110, slot: 'status' },
  { prop: 'description', label: '执行描述', width: 150, formatter: (row) => row.description || '—' },
  { prop: 'taskId', label: '任务 ID', width: 100 },
  { prop: 'currentPosition', label: '当前位置', width: 110 },
  { prop: 'stationTotal', label: '站点总数', width: 100 },
  { prop: 'actions', label: '操作', width: 160, fixed: 'right', slot: 'actions' }
]

const headerDescription = computed(() => {
  const scope = keyword.value || statusFilter.value !== '' ? '筛选结果' : '全部'
  return `${scope} ${total.value} 条执行记录 · 中断 ${interruptedTotal.value} 条`
})

let filterTimer = null
watch([keyword, statusFilter], () => {
  if (filterTimer) window.clearTimeout(filterTimer)
  filterTimer = window.setTimeout(() => {
    search({ keyword: keyword.value, status: statusFilter.value })
  }, 300)
})

onMounted(async () => {
  await load()
  await refreshInterruptedTotal()
})

/** 中断数是全局口径，分页后本地没有全量数据，单独取一次 total。 */
async function refreshInterruptedTotal() {
  try {
    const result = await fetchRunsPage({ status: 100, page: 1, pageSize: 1 })
    interruptedTotal.value = result.total
  } catch {
    interruptedTotal.value = 0
  }
}

function routePreview(route) {
  const text = String(route || '')
  if (text.length <= 60) return text
  return `${text.slice(0, 60)}…`
}

async function resume(row) {
  try {
    await ElMessageBox.confirm(`从当前站点继续执行 ${row.taskRunId}？机器人会恢复移动。`, '续跑确认', {
      type: 'warning',
      confirmButtonText: '继续执行',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  const result = await run(`resume-${row.taskRunId}`, () => resumeRun(row.taskRunId), { success: `执行 ${row.taskRunId} 已续跑` })
  if (result === undefined) return
  await reload()
  await refreshInterruptedTotal()
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`删除执行记录 ${row.taskRunId}？该操作不可撤销。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  const result = await run(`delete-${row.taskRunId}`, () => deleteRun(row.taskRunId), { success: '执行记录已删除' })
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
            <el-input v-model="keyword" class="filter-search" placeholder="按执行 ID 或任务 ID 搜索" :prefix-icon="Search" clearable />
            <el-select v-model="statusFilter" class="filter-select" placeholder="执行状态" clearable>
              <el-option label="执行中" :value="1" />
              <el-option label="待续跑" :value="2" />
              <el-option label="失败" :value="3" />
              <el-option label="已中断" :value="100" />
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
          empty-text="暂无执行记录"
          @page-change="setPage"
          @size-change="setPageSize"
        >
          <template #cell-id="{ row }">
            <span class="text-mono">{{ row.taskRunId }}</span>
          </template>
          <template #cell-status="{ row }">
            <el-tag :type="runStatusTagType(row.status)" effect="light" size="small">{{ runStatusLabel(row.status) }}</el-tag>
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
              续跑
            </el-button>
            <el-button
              text
              type="danger"
              size="small"
              :icon="Delete"
              :loading="pendingKey === `delete-${row.taskRunId}`"
              @click="remove(row)"
            >
              删除
            </el-button>
          </template>
        </DataTable>

        <el-divider content-position="left">执行路线</el-divider>
        <el-scrollbar max-height="220px">
          <el-descriptions v-for="row in rows" :key="row.taskRunId" :column="1" border size="small" class="run-route">
            <el-descriptions-item :label="row.taskRunId">
              <span class="text-mono">{{ routePreview(row.route) || '未记录路线' }}</span>
            </el-descriptions-item>
          </el-descriptions>
        </el-scrollbar>
      </section>
    </AsyncSection>
  </div>
</template>

<style scoped>
.filter-search {
  width: 240px;
}

.filter-select {
  width: 140px;
}

.run-route + .run-route {
  margin-top: 8px;
}

@media (max-width: 900px) {
  .filter-search {
    width: 100%;
  }
}
</style>
