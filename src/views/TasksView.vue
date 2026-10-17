<script setup>
// 任务管理：巡检计划的增删改查与立即执行。
// 列表数据、字段枚举、CRON 校验都来自 api/tasks.js，页面只负责交互。
// 筛选与分页走服务端：改造前是拉全量再在浏览器 filter + slice，
// 任务与告警涨到几千条时首屏会明显变慢。
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { Delete, Plus, Refresh, RefreshRight, Search, VideoPlay } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import AsyncSection from '@/components/AsyncSection.vue'
import DataTable from '@/components/DataTable.vue'
import {
  RUN_TYPE_OPTIONS, createTaskDraft, deleteTask, fetchTasksPage, isValidCron, runTask, saveTask
} from '@/api/tasks'
import { useServerTable } from '@/composables/useServerTable'
import { useAsyncTask } from '@/composables/useAsyncTask'
import { useRefreshFeedback } from '@/composables/useRefreshFeedback'
import { formatTime } from '@/utils/format'

const keyword = ref('')
const enabledFilter = ref('')
const expanded = ref([])
const enabledTotal = ref(0)

const dialogVisible = ref(false)
const editing = ref(false)
const draft = reactive(createTaskDraft())
const draftRef = ref(null)

const { pendingKey, run } = useAsyncTask()
const { refresh: refreshWithFeedback } = useRefreshFeedback()

const {
  rows, total, page, pageSize, loading, error, load, search, reload, setPage, setPageSize
} = useServerTable(fetchTasksPage, { pageSize: 10 })

const columns = [
  { prop: 'taskName', label: '任务名称', minWidth: 180, fixed: 'left' },
  { prop: 'runType', label: '运行方式', width: 120 },
  { prop: 'enabled', label: '发布状态', width: 110, slot: 'enabled' },
  { prop: 'runParams', label: '运行参数', width: 150, slot: 'params' },
  { prop: 'cron', label: 'CRON', width: 150, slot: 'cron' },
  { prop: 'createdAt', label: '创建时间', width: 170, formatter: (row) => formatTime(row.createdAt) },
  { prop: 'updatedAt', label: '更新时间', width: 170, formatter: (row) => formatTime(row.updatedAt) },
  { prop: 'taskId', label: '任务ID', width: 100 },
  { prop: 'actions', label: '操作', width: 210, fixed: 'right', slot: 'actions' }
]

const rules = {
  taskName: [{ required: true, message: '请输入任务名称', trigger: 'blur' }],
  cron: [
    { required: true, message: '请输入 CRON 表达式', trigger: 'blur' },
    {
      validator: (rule, value, callback) => (isValidCron(value) ? callback() : callback(new Error('CRON 需要 6 或 7 段，例如 0 30 4 * * ?'))),
      trigger: 'blur'
    }
  ],
  route: [{ required: true, message: '请输入任务站点序列', trigger: 'blur' }]
}

const headerDescription = computed(() => {
  const scope = keyword.value || enabledFilter.value ? '筛选结果' : '全部'
  return `${scope} ${total.value} 个巡检任务 · 已启用 ${enabledTotal.value} 个`
})

// 输入防抖：逐字触发请求没有意义，300ms 内的连续输入合并成一次。
let filterTimer = null
watch([keyword, enabledFilter], () => {
  if (filterTimer) window.clearTimeout(filterTimer)
  filterTimer = window.setTimeout(() => {
    search({ keyword: keyword.value, enabled: enabledFilter.value })
  }, 300)
})

onMounted(async () => {
  await load()
  await refreshEnabledTotal()
})

/** 已启用数量是全局口径（不受当前筛选影响），单独取一次 total。 */
async function refreshEnabledTotal() {
  try {
    const result = await fetchTasksPage({ enabled: 'on', page: 1, pageSize: 1 })
    enabledTotal.value = result.total
  } catch {
    enabledTotal.value = 0
  }
}

function openCreate() {
  editing.value = false
  Object.assign(draft, createTaskDraft())
  dialogVisible.value = true
}

function openEdit(row) {
  editing.value = true
  Object.assign(draft, createTaskDraft(row))
  dialogVisible.value = true
}

async function submitDraft() {
  if (!draftRef.value) return
  const valid = await draftRef.value.validate().catch(() => false)
  if (!valid) return
  const result = await run('save', () => saveTask({ ...draft }), { success: editing.value ? '任务已更新' : '任务已创建' })
  if (result === undefined) return
  dialogVisible.value = false
  await reload()
  await refreshEnabledTotal()
}

async function removeTask(row) {
  try {
    await ElMessageBox.confirm(`删除后该计划不再执行，确认删除「${row.taskName || row.taskId}」？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  const result = await run(`delete-${row.taskId}`, () => deleteTask(row.taskId), { success: '任务已删除' })
  if (result === undefined) return
  await reload()
  await refreshEnabledTotal()
}

async function executeTask(row) {
  try {
    await ElMessageBox.confirm(
      `立即执行任务「${row.taskName || row.taskId}」会让机器人开始移动，确认执行？`,
      '执行确认',
      { type: 'warning', confirmButtonText: '立即执行', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await run(`run-${row.taskId}`, () => runTask(row.taskId), { success: `任务「${row.taskName || row.taskId}」已下发执行` })
}

async function toggleEnabled(row) {
  const next = !(row.enabled !== false)
  const result = await run(`toggle-${row.taskId}`, () => saveTask({ ...row, enabled: next }), {
    success: next ? '任务已开启' : '任务已关闭',
    silentError: true
  })
  if (result === undefined) {
    ElMessage.error('发布状态修改失败')
    return
  }
  row.enabled = next
  await refreshEnabledTotal()
}

function resetFilters() {
  keyword.value = ''
  enabledFilter.value = ''
}

async function refresh() {
  await refreshWithFeedback(async () => {
    const ok = await reload()
    await refreshEnabledTotal()
    return ok && !error.value
  }, { success: '任务列表已刷新', isError: () => error.value })
}
</script>

<template>
  <div class="view">
    <PageHeader title="任务管理" :description="headerDescription">
      <template #extra>
        <el-button :icon="Refresh" :loading="loading" @click="refresh">刷新</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新建任务</el-button>
      </template>
    </PageHeader>

    <AsyncSection :loading="loading && !rows.length" :error="error" loading-text="正在加载任务列表…" @retry="load">
      <section class="view-panel">
        <div class="view-toolbar">
          <div class="view-toolbar__actions">
            <el-input
              v-model="keyword"
              class="filter-search"
              placeholder="按任务名称或任务 ID 搜索"
              :prefix-icon="Search"
              clearable
            />
            <el-select v-model="enabledFilter" class="filter-select" placeholder="发布状态" clearable>
              <el-option label="开启" value="on" />
              <el-option label="关闭" value="off" />
            </el-select>
            <el-button text :icon="RefreshRight" @click="resetFilters">重置</el-button>
          </div>
          <span class="view-toolbar__hint">共 {{ total }} 条</span>
        </div>

        <DataTable
          :rows="rows"
          :columns="columns"
          :loading="loading"
          row-key="taskId"
          :page="page"
          :page-size="pageSize"
          :total="total"
          empty-text="暂无巡检任务"
          @page-change="setPage"
          @size-change="setPageSize"
        >
          <!-- 空状态带引导动作，而不是只留一句「暂无数据」 -->
          <template #empty>
            <el-empty :description="keyword || enabledFilter ? '没有符合筛选条件的任务' : '还没有巡检任务'">
              <el-button v-if="keyword || enabledFilter" @click="resetFilters">清空筛选</el-button>
              <el-button v-else type="primary" :icon="Plus" @click="openCreate">新建任务</el-button>
            </el-empty>
          </template>

          <template #cell-enabled="{ row }">
            <el-switch
              :model-value="row.enabled !== false"
              :loading="pendingKey === `toggle-${row.taskId}`"
              @change="toggleEnabled(row)"
            />
          </template>
          <template #cell-params="{ row }">
            <span class="text-mono">{{ row.runParams || '--' }}</span>
          </template>
          <template #cell-cron="{ row }">
            <span class="text-mono">{{ row.cron || '--' }}</span>
          </template>
          <template #cell-actions="{ row }">
            <el-button text type="primary" size="small" @click.stop="openEdit(row)">编辑</el-button>
            <el-button
              text
              type="success"
              size="small"
              :icon="VideoPlay"
              :loading="pendingKey === `run-${row.taskId}`"
              @click.stop="executeTask(row)"
            >
              执行
            </el-button>
            <el-button
              text
              type="danger"
              size="small"
              :icon="Delete"
              :loading="pendingKey === `delete-${row.taskId}`"
              @click.stop="removeTask(row)"
            >
              删除
            </el-button>
          </template>
        </DataTable>

        <el-divider content-position="left">任务站点序列</el-divider>
        <el-collapse v-model="expanded">
          <el-collapse-item v-for="row in rows" :key="row.taskId" :name="row.taskId">
            <template #title>
              <strong>{{ row.taskName || row.taskId }}</strong>
              <span class="text-muted route-title">（{{ row.route ? `${row.route.split(',').length} 个点位` : '未配置路线' }}）</span>
            </template>
            <p class="text-mono route-body">{{ row.route || '未配置任务站点' }}</p>
          </el-collapse-item>
        </el-collapse>
      </section>
    </AsyncSection>

    <el-dialog v-model="dialogVisible" :title="editing ? '编辑任务' : '新建任务'" width="640px" destroy-on-close>
      <el-form ref="draftRef" :model="draft" :rules="rules" label-width="110px">
        <el-form-item label="任务名称" prop="taskName">
          <el-input v-model="draft.taskName" placeholder="例如：上午 4 点 30 巡检" />
        </el-form-item>
        <el-form-item label="任务 ID">
          <el-input v-model="draft.taskId" :disabled="editing" placeholder="留空由后端生成" />
        </el-form-item>
        <el-form-item label="运行方式">
          <el-select v-model="draft.runType" class="dialog-control">
            <el-option v-for="item in RUN_TYPE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="发布状态">
          <el-radio-group v-model="draft.enabled">
            <el-radio :value="true">开启</el-radio>
            <el-radio :value="false">关闭</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="CRON" prop="cron">
          <el-input v-model="draft.cron" placeholder="0 30 4 * * ?" />
        </el-form-item>
        <el-form-item label="运行参数">
          <el-input v-model="draft.runParams" type="textarea" :rows="2" placeholder='例如 {"mode": 0}' />
        </el-form-item>
        <el-form-item label="任务站点" prop="route">
          <el-input v-model="draft.route" type="textarea" :rows="4" placeholder="逗号分隔的站点 / 动作序列" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="pendingKey === 'save'" @click="submitDraft">保存</el-button>
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

.dialog-control {
  width: 100%;
}

.route-title {
  margin-left: 6px;
  font-size: 12px;
  font-weight: 400;
}

.route-body {
  margin: 0;
  line-height: 1.7;
}

@media (max-width: 900px) {
  .filter-search {
    width: 100%;
  }
}
</style>
