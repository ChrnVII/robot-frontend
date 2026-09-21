<script setup>
// 参数设置：机器人与服务连接参数。字段定义与只读规则全部来自 api/config.js，
// 页面只负责渲染表单和调用保存接口，不硬编码任何默认值。
import { onMounted, reactive, ref } from 'vue'
import { Refresh, Select } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import AsyncSection from '@/components/AsyncSection.vue'
import { PARAM_FIELDS, fetchParams, saveParams } from '@/api/config'
import { useAsyncData } from '@/composables/useAsyncData'
import { useAsyncTask } from '@/composables/useAsyncTask'

const formRef = ref(null)
const form = reactive({})
const snapshot = ref({})
const { pendingKey, run } = useAsyncTask()

// 必填：机器人标识与名称；其余字段按后端约定可选。
const rules = {
  robotId: [{ required: true, message: 'robot_id 由后端下发，不能为空', trigger: 'blur' }],
  name: [{ required: true, message: '请输入机器人名称', trigger: 'blur' }]
}

const { loading, error, load } = useAsyncData(async () => {
  const values = await fetchParams()
  Object.keys(form).forEach((key) => { delete form[key] })
  Object.assign(form, values)
  snapshot.value = { ...values }
  return values
})

onMounted(load)

async function submit() {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  await run('save', () => saveParams({ ...form }), { success: '参数保存成功' })
  snapshot.value = { ...form }
}

function resetForm() {
  Object.assign(form, snapshot.value)
  formRef.value?.clearValidate()
  ElMessage.info('已恢复为最近一次读取的参数')
}
</script>

<template>
  <div class="view">
    <PageHeader
      title="参数设置"
      description="机器人与服务连接参数，robot_id 由后端下发，页面只读"
    >
      <template #extra>
        <el-button :icon="Refresh" :loading="loading" @click="load">重新读取</el-button>
      </template>
    </PageHeader>

    <AsyncSection :loading="loading" :error="error" loading-text="正在读取机器人参数…" @retry="load">
      <section class="view-panel">
        <div class="view-panel__head">
          <h2>连接参数</h2>
          <small>密文字段回显为空表示后端未下发，留空即不修改</small>
        </div>

        <el-form ref="formRef" :model="form" :rules="rules" label-width="120px" class="param-form">
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
                  clearable
                />
              </el-form-item>
            </el-col>
          </el-row>

          <div class="param-form__actions">
            <el-button type="primary" :icon="Select" :loading="pendingKey === 'save'" @click="submit">保存参数</el-button>
            <el-button @click="resetForm">撤销修改</el-button>
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
