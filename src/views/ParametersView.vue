<script setup>
// 参数设置：机器人与服务连接参数。字段定义与只读规则全部来自 api/config.js，
// 页面只负责渲染表单和调用保存接口，不硬编码任何默认值。
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { Refresh, Select } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import AsyncSection from '@/components/AsyncSection.vue'
import { PARAM_FIELDS, fetchParams, saveParams } from '@/api/config'
import { useAsyncData } from '@/composables/useAsyncData'
import { useAsyncTask } from '@/composables/useAsyncTask'
import { useRefreshFeedback } from '@/composables/useRefreshFeedback'

const formRef = ref(null)
const form = reactive({})
const snapshot = ref({})
const { pendingKey, run } = useAsyncTask()
const { refresh: refreshWithFeedback } = useRefreshFeedback()

// 必填：机器人标识与名称；其余字段按后端约定可选。
const rules = {
  robotId: [{ required: true, message: 'robot_id 由后端下发，不能为空', trigger: 'blur' }],
  name: [{ required: true, message: '请输入机器人名称', trigger: 'blur' }]
}

const dirty = computed(() => JSON.stringify({ ...form }) !== JSON.stringify(snapshot.value))

const { loading, error, load } = useAsyncData(async () => {
  const values = await fetchParams()
  Object.keys(form).forEach((key) => { delete form[key] })
  Object.assign(form, values)
  snapshot.value = { ...values }
  return values
})

// 密钥类字段：留空表示「不修改」，提交前必须剔除，
// 否则一次「什么都没改」的保存就会把后端已下发的密钥覆盖成空串。
const SECRET_KEYS = PARAM_FIELDS.filter((field) => field.secret).map((field) => field.key)

function buildPayload() {
  const payload = { ...form }
  SECRET_KEYS.forEach((key) => {
    if (!String(payload[key] ?? '').trim()) delete payload[key]
  })
  return payload
}

onMounted(() => {
  load()
  window.addEventListener('beforeunload', handleBeforeUnload)
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload)
})

function handleBeforeUnload(event) {
  if (!dirty.value) return
  event.preventDefault()
  event.returnValue = ''
}

// 参数里有连接地址和服务密钥，误刷新后重新填一遍成本很高，
// 所以与地图页一致：有未保存的修改就拦一下。
onBeforeRouteLeave(async () => {
  if (!dirty.value) return true
  try {
    await ElMessageBox.confirm(
      '参数有未保存的修改，离开后这些修改会丢失。',
      '有未保存的修改',
      { type: 'warning', confirmButtonText: '放弃修改并离开', cancelButtonText: '留在本页' }
    )
    return true
  } catch {
    return false
  }
})

async function submit() {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  const result = await run('save', () => saveParams(buildPayload()), { success: '参数保存成功' })
  if (result === undefined) return
  snapshot.value = { ...form }
}

function resetForm() {
  Object.assign(form, snapshot.value)
  formRef.value?.clearValidate()
  ElMessage.info('已恢复为最近一次读取的参数')
}

async function reload() {
  await refreshWithFeedback(async () => {
    await load()
    return !error.value
  }, { success: '已重新读取机器人参数', isError: () => error.value })
}
</script>

<template>
  <div class="view">
    <PageHeader
      title="参数设置"
      description="机器人与服务连接参数，robot_id 由后端下发，页面只读"
      :status-text="dirty ? '有未保存修改' : '已同步'"
      :status-type="dirty ? 'warning' : 'success'"
    >
      <template #extra>
        <el-button :icon="Refresh" :loading="loading" @click="reload">重新读取</el-button>
        <el-button type="primary" :icon="Select" :loading="pendingKey === 'save'" :disabled="!dirty" @click="submit">
          保存参数
        </el-button>
      </template>
    </PageHeader>

    <AsyncSection :loading="loading" :error="error" loading-text="正在读取机器人参数…" @retry="load">
      <section class="view-panel">
        <div class="view-panel__head">
          <h2>连接参数</h2>
          <small>密文字段留空表示保持后端原值，不会被覆盖</small>
        </div>

        <el-form
          ref="formRef"
          :model="form"
          :rules="rules"
          label-width="120px"
          class="param-form"
          @submit.prevent="submit"
        >
          <el-row :gutter="20">
            <el-col v-for="field in PARAM_FIELDS" :key="field.key" :xs="24" :sm="24" :md="12" :lg="8">
              <el-form-item :label="field.label" :prop="field.key">
                <el-input
                  v-model="form[field.key]"
                  :readonly="field.readonly"
                  :disabled="field.readonly"
                  :type="field.secret ? 'password' : 'text'"
                  :show-password="Boolean(field.secret)"
                  :placeholder="field.readonly ? '后端下发' : `请输入 ${field.label}`"
                  :autocomplete="field.secret ? 'new-password' : 'off'"
                  clearable
                />
              </el-form-item>
            </el-col>
          </el-row>

          <div class="param-form__actions">
            <el-button type="primary" :icon="Select" :loading="pendingKey === 'save'" :disabled="!dirty" @click="submit">
              保存参数
            </el-button>
            <el-button :disabled="!dirty" @click="resetForm">撤销修改</el-button>
          </div>
        </el-form>
      </section>
    </AsyncSection>
  </div>
</template>

<style scoped>
.param-form__actions {
  display: flex;
  gap: 10px;
  padding-top: 6px;
}
</style>
