<script setup>
// 地图站点：可编辑站点表格，整张地图一次性保存（带版本号，避免双人互相覆盖）。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { Delete, Plus, Refresh, Select } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import AsyncSection from '@/components/AsyncSection.vue'
import { STATION_TYPES, createStation, listStations, saveStations, stationTypeLabel } from '@/api/map'
import { unwrap } from '@/api/envelope'
import { useAsyncData } from '@/composables/useAsyncData'
import { useAsyncTask } from '@/composables/useAsyncTask'
import { useRefreshFeedback } from '@/composables/useRefreshFeedback'

const stations = ref([])
const mapVersion = ref(1)
// 保存服务端快照的序列化结果：dirty 由「当前值 vs 快照」实时比对得出，
// 比手写 markDirty() 更准——用户改了又改回去，不应该还提示"有未保存修改"。
const snapshot = ref('[]')
const { pendingKey, run } = useAsyncTask()
const { refresh: refreshWithFeedback } = useRefreshFeedback()

function serialize(rows) {
  return JSON.stringify(rows)
}

const dirty = computed(() => serialize(stations.value) !== snapshot.value)

const { loading, error, load } = useAsyncData(async () => {
  const rows = await listStations()
  const next = rows.map((row, index) => ({ ...createStation(index + 1), ...row }))
  stations.value = next
  snapshot.value = serialize(next)
  return rows
})

// 站点类型分布，页面顶部用它做概览。
const typeSummary = computed(() => STATION_TYPES.map((type) => ({
  ...type,
  count: stations.value.filter((station) => station.type === type.value).length
})).filter((item) => item.count > 0))

const booleanColumns = [
  { prop: 'returnStation', label: '回站点' },
  { prop: 'heightCheck', label: '高度检查' },
  { prop: 'soundInterference', label: '声音干扰' },
  { prop: 'takePhoto', label: '拍照' },
  { prop: 'collectEnvironment', label: '环境采集' },
  { prop: 'recordAudio', label: '录音' }
]

// 关闭标签页 / 刷新浏览器时的原生提示：路由守卫管不到这一层。
function handleBeforeUnload(event) {
  if (!dirty.value) return
  event.preventDefault()
  // 旧版浏览器需要 returnValue 才会弹确认框
  event.returnValue = ''
}

onMounted(() => {
  load()
  window.addEventListener('beforeunload', handleBeforeUnload)
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload)
})

// 页内跳转拦截：改造前改完整张地图切个页面就全丢了，且没有任何提示。
onBeforeRouteLeave(async () => {
  if (!dirty.value) return true
  try {
    await ElMessageBox.confirm(
      '地图站点有未保存的修改，离开后这些修改会丢失。',
      '有未保存的修改',
      { type: 'warning', confirmButtonText: '放弃修改并离开', cancelButtonText: '留在本页' }
    )
    return true
  } catch {
    return false
  }
})

function addStation() {
  const nextIndex = stations.value.length + 1
  stations.value.push(createStation(nextIndex))
}

async function removeStation(index) {
  const station = stations.value[index]
  try {
    await ElMessageBox.confirm(`确认删除站点 ${station.station}？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  stations.value.splice(index, 1)
}

async function save() {
  if (!stations.value.length) {
    ElMessage.warning('至少保留一个站点')
    return
  }
  const duplicated = stations.value.map((item) => item.station).filter((value, index, list) => list.indexOf(value) !== index)
  if (duplicated.length) {
    ElMessage.warning(`站点编号重复：${[...new Set(duplicated)].join('、')}`)
    return
  }
  const result = await run('save', async () => {
    const response = await saveStations(stations.value, mapVersion.value)
    const payload = unwrap(response, {})
    if (payload.mapVersion) mapVersion.value = payload.mapVersion
    return payload
  }, { success: '地图站点保存成功' })
  if (result !== undefined) {
    // 保存成功后把当前值作为新快照，dirty 立即归零
    snapshot.value = serialize(stations.value)
  }
}

async function reload() {
  await refreshWithFeedback(async () => {
    await load()
    return !error.value
  }, { success: '已恢复为服务端保存的站点数据', isError: () => error.value })
}
</script>

<template>
  <div class="view">
    <PageHeader
      title="地图站点"
      :description="`共 ${stations.length} 个站点 · 地图版本 v${mapVersion}`"
      :status-text="dirty ? '有未保存修改' : '已同步'"
      :status-type="dirty ? 'warning' : 'success'"
    >
      <template #extra>
        <el-button :icon="Refresh" :loading="loading" :disabled="!dirty" @click="reload">放弃修改</el-button>
        <el-button
          type="primary"
          :icon="Select"
          :loading="pendingKey === 'save'"
          :disabled="!dirty"
          @click="save"
        >
          保存地图
        </el-button>
      </template>
    </PageHeader>

    <AsyncSection :loading="loading" :error="error" loading-text="正在加载地图站点…" @retry="load">
      <section class="view-panel">
        <div class="view-toolbar">
          <div class="view-toolbar__actions">
            <el-tag v-for="item in typeSummary" :key="item.value" :type="item.value === 'inspection' ? 'primary' : item.value === 'charging' ? 'success' : 'info'" effect="light">
              {{ item.label }} {{ item.count }}
            </el-tag>
            <span class="text-muted">修改后需要点击「保存地图」才会写入后端</span>
          </div>
          <el-button :icon="Plus" @click="addStation">添加站点</el-button>
        </div>

        <!-- 未保存提醒条：滚动到表格上方时也能看到状态 -->
        <el-alert
          v-if="dirty"
          class="map-dirty"
          type="warning"
          :closable="false"
          show-icon
          :title="`有未保存的修改（${stations.length} 个站点）。离开本页或刷新浏览器会丢失。`"
        />

        <el-table :data="stations" border stripe size="default" :row-key="(row) => row.stationId">
          <template #empty>
            <el-empty description="暂无站点，请点击「添加站点」" :image-size="72" />
          </template>

          <el-table-column type="index" label="#" width="55" align="center" />
          <el-table-column label="站点" width="90">
            <template #default="{ row }">
              <el-input-number v-model="row.station" :min="1" :controls="false" size="small" class="cell-number" />
            </template>
          </el-table-column>
          <el-table-column label="类型" width="120">
            <template #default="{ row }">
              <el-select v-model="row.type" size="small">
                <el-option v-for="item in STATION_TYPES" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="鸡笼" width="90">
            <template #default="{ row }">
              <el-input-number v-model="row.cage" :min="0" :controls="false" size="small" class="cell-number" />
            </template>
          </el-table-column>
          <el-table-column label="x" width="110">
            <template #default="{ row }">
              <el-input-number v-model="row.x" :precision="3" :step="0.1" :controls="false" size="small" class="cell-number" />
            </template>
          </el-table-column>
          <el-table-column label="y" width="110">
            <template #default="{ row }">
              <el-input-number v-model="row.y" :precision="3" :step="0.1" :controls="false" size="small" class="cell-number" />
            </template>
          </el-table-column>
          <el-table-column label="yaw" width="100">
            <template #default="{ row }">
              <el-input-number v-model="row.yaw" :min="-180" :max="180" :controls="false" size="small" class="cell-number" />
            </template>
          </el-table-column>
          <el-table-column label="下一站点速度" width="130">
            <template #default="{ row }">
              <el-input-number v-model="row.nextSpeed" :precision="2" :step="0.05" :min="0" :controls="false" size="small" class="cell-number" />
            </template>
          </el-table-column>
          <el-table-column label="等待(毫秒)" width="130">
            <template #default="{ row }">
              <el-input-number v-model="row.waitMs" :min="0" :step="500" :controls="false" size="small" class="cell-number" />
            </template>
          </el-table-column>
          <el-table-column
            v-for="column in booleanColumns"
            :key="column.prop"
            :label="column.label"
            width="100"
            align="center"
          >
            <template #default="{ row }">
              <el-switch v-model="row[column.prop]" size="small" />
            </template>
          </el-table-column>
          <el-table-column label="操作" width="80" fixed="right" align="center">
            <template #default="{ $index }">
              <el-button text type="danger" size="small" :icon="Delete" @click="removeStation($index)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>

        <el-alert
          class="map-tip"
          type="info"
          :closable="false"
          show-icon
          :title="`站点类型：${STATION_TYPES.map((item) => stationTypeLabel(item.value)).join(' / ')}。坐标与 yaw 由现场标定确定。`"
        />
      </section>
    </AsyncSection>
  </div>
</template>

<style scoped>
.cell-number {
  width: 100%;
}

.cell-number :deep(.el-input__inner) {
  text-align: left;
}

.map-dirty {
  margin-bottom: var(--app-gap-inner);
}

.map-tip {
  margin-top: var(--app-gap-inner);
}
</style>
