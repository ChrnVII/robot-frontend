<script setup>
// 告警数据：按等级 / 处理状态筛选，登记处理结果或删除告警。
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { Check, Delete, Refresh, RefreshRight, Search } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import AsyncSection from '@/components/AsyncSection.vue'
import DataTable from '@/components/DataTable.vue'
import { ALERT_LEVELS, ALERT_STATUSES, alertLevelMeta, alertStatusMeta, deleteAlert, handleAlert, listAlerts } from '@/api/alerts'
import { useAsyncData } from '@/composables/useAsyncData'
import { useAsyncTask } from '@/composables/useAsyncTask'
import { formatTime } from '@/utils/format'

const keyword = ref('')
const levelFilter = ref('')
const statusFilter = ref('')
const page = ref(1)
const pageSize = ref(10)

const handleVisible = ref(false)
const handleForm = reactive({ alertId: '', status: 'handled', result: '' })

const { pendingKey, run } = useAsyncTask()
const { data: rows, loading, error, load } = useAsyncData(() => listAlerts(), { initialData: [] })

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

const filteredRows = computed(() => {
  const text = keyword.value.trim().toLowerCase()
  return (rows.value || []).filter((row) => {
    const matchesText = !text
      || String(row.content || '').toLowerCase().includes(text)
      || String(row.alertId || '').toLowerCase().includes(text)
      || String(row.taskRunId || '').toLowerCase().includes(text)
    const matchesLevel = levelFilter.value === '' || row.level === levelFilter.value
    const matchesStatus = statusFilter.value === '' || row.status === statusFilter.value
    return matchesText && matchesLevel && matchesStatus
  })
})

const pagedRows = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filteredRows.value.slice(start, start + pageSize.value)
})

// 顶部概览：按处理状态和等级统计，值随筛选前的全量数据计算。
const summary = computed(() => ({
  open: (rows.value || []).filter((row) => row.status === 'open').length,
  handled: (rows.value || []).filter((row) => row.status === 'handled').length,
  critical: (rows.value || []).filter((row) => row.level === 'critical').length
}))

watch([keyword, levelFilter, statusFilter], () => { page.value = 1 })
onMounted(load)

function openHandle(row) {
  handleForm.alertId = row.alertId
  handleForm.status = row.status === 'open' ? 'handled' : row.status
  handleForm.result = row.result || ''
  handleVisible.value = true
}

async function submitHandle() {
  if (!handleForm.result.trim()) {
    ElMessage.warning('请填写处理说明')
    return
  }
  const result = await run('handle', () => handleAlert(handleForm.alertId, { status: handleForm.status, result: handleForm.result.trim() }),
    { success: '处理结果已登记' })
  if (result === undefined) return
  handleVisible.value = false
  await load()
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
  if (result !== undefined) await load()
}

async function refresh() {
  await load()
  if (!error.value) ElMessage.success('告警列表已刷新')
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
      :description="`共 ${rows.length} 条告警 · 待处理 ${summary.open} 条 · 严重 ${summary.critical} 条`"
      :status-text="summary.open ? '有待处理告警' : '暂无待处理'"
      :status-type="summary.open ? 'warning' : 'success'"
    >
      <template #extra>
        <el-button :icon="Refresh" :loading="loading" @click="refresh">刷新</el-button>
      </template>
    </PageHeader>

    <AsyncSection :loading="loading" :error="error" loading-text="正在加载告警数据…" @retry="load">
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
          <span class="view-toolbar__hint">筛选结果 {{ filteredRows.length }} 条 · 已处理 {{ summary.handled }} 条</span>
        </div>

        <DataTable
          v-model:page="page"
          v-model:page-size="pageSize"
          :rows="pagedRows"
          :columns="columns"
          :loading="loading"
          row-key="alertId"
          :total="filteredRows.length"
          empty-text="暂无告警，设备与任务运行正常"
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
.filter-search {
  width: 260px;
}

.filter-select {
  width: 140px;
}
</style>
