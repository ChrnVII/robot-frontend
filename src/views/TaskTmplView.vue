<script setup>
// 默认任务：可复用任务模板维护（新增 / 编辑 / 保存 / 删除）。
// 补光灯模式等枚举来自 api/tasks.js，页面不写死选项。
import { computed, onMounted, reactive, ref } from 'vue'
import { Delete, Plus, Refresh, Select } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import AsyncSection from '@/components/AsyncSection.vue'
import { LIGHT_MODE_OPTIONS, deleteTaskTemplate, listTaskTemplates, saveTaskTemplate } from '@/api/tasks'
import { useAsyncData } from '@/composables/useAsyncData'
import { useAsyncTask } from '@/composables/useAsyncTask'

const TASK_MODE_OPTIONS = [
  { value: 0, label: '正常' },
  { value: 1, label: '演示' }
]

const selected = ref([])
const { pendingKey, run } = useAsyncTask()
const { data: rows, loading, error, load } = useAsyncData(() => listTaskTemplates(), { initialData: [] })

const selectedCount = computed(() => selected.value.length)
const namedCount = computed(() => (rows.value || []).filter((row) => String(row.taskName || '').trim()).length)

onMounted(load)

function handleSelectionChange(selection) {
  selected.value = selection
}

function createDraftRow() {
  return { templateId: '', taskName: '', currentRoute: '', previousRoute: '', taskMode: 0, lightMode: 0 }
}

function addRow() {
  rows.value = [...(rows.value || []), createDraftRow()]
  ElMessage.info('已新增一行，请填写任务名称与路线后保存')
}

async function saveRow(row) {
  if (!String(row.taskName || '').trim()) {
    ElMessage.warning('请先填写任务名称')
    return
  }
  const result = await run(`save-${row.templateId || 'new'}`, () => saveTaskTemplate({ ...row }), { success: '默认任务已保存' })
  if (result === undefined) return
  await load()
}

async function removeRow(row) {
  if (!row.templateId) {
    rows.value = (rows.value || []).filter((item) => item !== row)
    return
  }
  try {
    await ElMessageBox.confirm(`删除默认任务「${row.taskName || row.templateId}」？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  const result = await run(`delete-${row.templateId}`, () => deleteTaskTemplate(row.templateId), { success: '默认任务已删除' })
  if (result !== undefined) await load()
}

async function removeSelected() {
  if (!selected.value.length) return
  try {
    await ElMessageBox.confirm(`确认删除选中的 ${selected.value.length} 条默认任务？`, '批量删除', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  const result = await run('batch-delete', () => Promise.all(selected.value.filter((row) => row.templateId).map((row) => deleteTaskTemplate(row.templateId))),
    { success: '选中默认任务已删除' })
  if (result === undefined) return
  selected.value = []
  await load()
}

async function refresh() {
  await load()
  if (!error.value) ElMessage.success('默认任务已刷新')
}
</script>

<template>
  <div class="view">
    <PageHeader
      title="默认任务"
      :description="`共 ${rows.length} 条模板 · 已命名 ${namedCount} 条`"
    >
      <template #extra>
        <el-button :icon="Refresh" :loading="loading" @click="refresh">刷新</el-button>
        <el-button type="primary" :icon="Plus" @click="addRow">新增任务</el-button>
      </template>
    </PageHeader>

    <AsyncSection :loading="loading" :error="error" loading-text="正在加载默认任务…" @retry="load">
      <section class="view-panel">
        <div class="view-toolbar">
          <span class="view-toolbar__hint">
            当前任务 / 上一次任务为逗号分隔的站点序列；补光灯模式对应原平台的 0 / 2 / 3 / 9
          </span>
          <div class="view-toolbar__actions">
            <el-button type="danger" plain :icon="Delete" :disabled="!selectedCount" @click="removeSelected">
              删除选中（{{ selectedCount }}）
            </el-button>
          </div>
        </div>

        <el-table
          :data="rows"
          border
          stripe
          row-key="templateId"
          @selection-change="handleSelectionChange"
        >
          <template #empty>
            <el-empty description="暂无默认任务模板" :image-size="72" />
          </template>

          <el-table-column type="selection" width="50" />
          <el-table-column label="任务 ID" width="120">
            <template #default="{ row }">
              <el-input v-model="row.templateId" size="small" placeholder="自动生成" :disabled="Boolean(row.templateId)" />
            </template>
          </el-table-column>
          <el-table-column label="任务名称" min-width="160">
            <template #default="{ row }">
              <el-input v-model="row.taskName" size="small" placeholder="任务名称" />
            </template>
          </el-table-column>
          <el-table-column label="当前任务" min-width="240">
            <template #default="{ row }">
              <el-input v-model="row.currentRoute" size="small" type="textarea" :rows="2" placeholder="例如 603,604" />
            </template>
          </el-table-column>
          <el-table-column label="上一次任务" min-width="240">
            <template #default="{ row }">
              <el-input v-model="row.previousRoute" size="small" type="textarea" :rows="2" placeholder="可为空" />
            </template>
          </el-table-column>
          <el-table-column label="任务模式" width="130">
            <template #default="{ row }">
              <el-select v-model="row.taskMode" size="small">
                <el-option v-for="item in TASK_MODE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="补光灯模式" width="140">
            <template #default="{ row }">
              <el-select v-model="row.lightMode" size="small">
                <el-option v-for="item in LIGHT_MODE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="160" fixed="right">
            <template #default="{ row }">
              <el-button
                text
                type="primary"
                size="small"
                :icon="Select"
                :loading="pendingKey === `save-${row.templateId || 'new'}`"
                @click="saveRow(row)"
              >
                保存
              </el-button>
              <el-button
                text
                type="danger"
                size="small"
                :icon="Delete"
                :loading="pendingKey === `delete-${row.templateId}`"
                @click="removeRow(row)"
              >
                删除
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </AsyncSection>
  </div>
</template>
