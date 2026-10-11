<script setup>
// 球形摄像头：实时画面、云台控制、预置点管理和抓图。
// 帧地址与命令都经 api/safety.js 下发；页面只负责定时刷新画面和交互状态。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  Aim, Camera, Delete, Plus, Refresh, RefreshRight, SwitchButton, Warning
} from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import AsyncSection from '@/components/AsyncSection.vue'
import {
  cameraSnapshot, deleteCameraPreset, getCameraFeed, gotoCameraPreset, listCameraPresets,
  ptzContinuous, rebootCamera, saveCameraPreset
} from '@/api/safety'
import { unwrap } from '@/api/envelope'
import { useAsyncData } from '@/composables/useAsyncData'
import { useAsyncTask } from '@/composables/useAsyncTask'
import { formatTime } from '@/utils/format'

const FRAME_INTERVAL = 1000

// 云台方向：direct 值对应设备协议，speed 由滑块给出。
const PTZ_DIRECTIONS = [
  { direct: 'up', label: '上', icon: '↑' },
  { direct: 'left', label: '左', icon: '←' },
  { direct: 'stop', label: '停止', icon: '■', danger: true },
  { direct: 'right', label: '右', icon: '→' },
  { direct: 'down', label: '下', icon: '↓' }
]

const presets = ref([])
const currentPresetId = ref(null)
const speed = ref(1)
const frameTick = ref(0)
const lastAction = ref('待命')
const snapshotAsset = ref(null)
const newPresetId = ref('')

const { pendingKey, run } = useAsyncTask()
const { loading, error, load } = useAsyncData(async () => {
  const rows = await listCameraPresets()
  presets.value = rows
  if (!presets.value.some((item) => item.presetId === currentPresetId.value)) {
    currentPresetId.value = presets.value[0]?.presetId ?? null
  }
  return rows
})

let timer = null

const currentPreset = computed(() => presets.value.find((item) => item.presetId === currentPresetId.value) || null)
const cameraFeed = computed(() => getCameraFeed(currentPresetId.value, frameTick.value + 1))
const frameSrc = computed(() => cameraFeed.value.url)

const snapshotText = computed(() => {
  if (!snapshotAsset.value) return '尚未抓图'
  const asset = snapshotAsset.value
  return `${asset.assetId || asset.uri || '已保存'} · ${formatTime(asset.capturedAt)}`
})

function tickFrame() {
  // 模拟模式下让占位图逐帧变化；真实模式下由浏览器按 URL 时间戳重新拉流。
  frameTick.value += 1
}

onMounted(() => {
  load()
  timer = window.setInterval(tickFrame, FRAME_INTERVAL)
})

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer)
})

async function ptz(direction) {
  const result = await run(`ptz-${direction}`, () => ptzContinuous(direction, speed.value), {
    success: `云台${direction === 'stop' ? '停止' : '转动'}指令已下发`
  })
  if (result !== undefined) lastAction.value = direction === 'stop' ? '云台停止' : `云台向${direction}`
}

async function goPreset() {
  if (!currentPresetId.value) {
    ElMessage.warning('请先选择预置点')
    return
  }
  const result = await run('goto', () => gotoCameraPreset(currentPresetId.value), { success: '已下发转到预置点' })
  if (result !== undefined) lastAction.value = `转到 ${currentPreset.value?.name || currentPresetId.value}`
}

async function snapshot() {
  const result = await run('snapshot', () => cameraSnapshot(currentPresetId.value), { success: '抓图完成' })
  if (result === undefined) return
  snapshotAsset.value = unwrap(result, null)
  lastAction.value = '抓图'
}

async function addPreset() {
  const id = Number(newPresetId.value)
  if (!Number.isFinite(id) || id <= 0) {
    ElMessage.warning('请输入有效的预置点 ID')
    return
  }
  const result = await run('savePreset', () => saveCameraPreset(id), { success: `预置点 ${id} 已保存` })
  if (result === undefined) return
  newPresetId.value = ''
  currentPresetId.value = id
  await load()
}

async function removePreset() {
  if (!currentPresetId.value) return
  const target = currentPreset.value
  try {
    await ElMessageBox.confirm(`删除预置点「${target?.name || currentPresetId.value}」？该操作会写入摄像头配置。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  const result = await run('deletePreset', () => deleteCameraPreset(currentPresetId.value), { success: '预置点已删除' })
  if (result === undefined) return
  currentPresetId.value = null
  await load()
}

async function reboot() {
  try {
    await ElMessageBox.confirm('重启摄像头会中断实时画面 1–2 分钟，确认执行？', '重启确认', {
      type: 'warning',
      confirmButtonText: '确认重启',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  const result = await run('reboot', () => rebootCamera(currentPresetId.value), { success: '摄像头重启指令已下发' })
  if (result !== undefined) lastAction.value = '摄像头重启中'
}

async function refresh() {
  await load()
  frameTick.value = 0
  if (!error.value) ElMessage.success('预置点已刷新')
}
</script>

<template>
  <div class="view">
    <PageHeader
      title="球形摄像"
      :description="`当前预置点 ${currentPreset?.name || '未选择'} · ${lastAction}`"
      :status-text="cameraFeed.statusText"
      :status-type="cameraFeed.statusType"
    >
      <template #extra>
        <el-button :icon="Refresh" :loading="loading" @click="refresh">刷新预置点</el-button>
        <el-button type="danger" plain :icon="RefreshRight" :loading="pendingKey === 'reboot'" @click="reboot">重启摄像头</el-button>
      </template>
    </PageHeader>

    <AsyncSection :loading="loading" :error="error" loading-text="正在连接摄像头…" @retry="load">
      <div class="camera-layout">
        <section class="view-panel camera-stage">
          <div class="camera-stage__head">
            <span class="camera-live"><i />{{ cameraFeed.label }}</span>
            <span class="text-muted">CH 01 · {{ currentPreset?.name || '手动' }}</span>
          </div>
          <div class="camera-stage__frame">
            <img :key="frameSrc" :src="frameSrc" alt="摄像头实时画面" @error="lastAction = '画面读取失败'" />
            <span class="camera-stage__meta">{{ formatTime(new Date()) }}</span>
          </div>
          <div class="camera-stage__actions">
            <el-button type="primary" :icon="Camera" :loading="pendingKey === 'snapshot'" @click="snapshot">抓图</el-button>
            <span class="text-muted">最近抓图：{{ snapshotText }}</span>
          </div>
        </section>

        <section class="view-panel camera-controls">
          <div class="view-panel__head">
            <h2>预置点</h2>
            <small>预置点由摄像头端保存</small>
          </div>
          <el-select v-model="currentPresetId" class="full-control" placeholder="选择预置点">
            <el-option v-for="item in presets" :key="item.presetId" :label="`${item.name}（ID ${item.presetId}）`" :value="item.presetId" />
          </el-select>
          <div class="camera-controls__row">
            <el-button type="primary" :icon="Aim" :loading="pendingKey === 'goto'" :disabled="!currentPresetId" @click="goPreset">转到预置点</el-button>
            <el-button type="danger" plain :icon="Delete" :loading="pendingKey === 'deletePreset'" :disabled="!currentPresetId" @click="removePreset">删除</el-button>
          </div>

          <el-divider content-position="left">新增 / 修改预置点</el-divider>
          <div class="camera-controls__row">
            <el-input-number v-model="newPresetId" :min="1" :max="255" :controls="false" placeholder="预置点 ID" class="preset-input" />
            <el-button type="success" :icon="Plus" :loading="pendingKey === 'savePreset'" @click="addPreset">保存为预置点</el-button>
          </div>
          <p class="text-muted preset-hint">同 ID 再次保存即覆盖该预置点的当前位置。</p>
        </section>

        <section class="view-panel camera-controls">
          <div class="view-panel__head">
            <h2>云台控制</h2>
            <small>速度范围 1–120</small>
          </div>
          <el-slider v-model="speed" :min="1" :max="120" show-input :show-input-controls="false" />

          <div class="ptz-pad">
            <el-button
              v-for="item in PTZ_DIRECTIONS"
              :key="item.direct"
              :type="item.danger ? 'danger' : 'default'"
              :loading="pendingKey === `ptz-${item.direct}`"
              :disabled="Boolean(pendingKey)"
              class="ptz-button"
              @click="ptz(item.direct)"
            >
              {{ item.icon }} {{ item.label }}
            </el-button>
          </div>

          <el-alert
            class="camera-tip"
            type="info"
            :closable="false"
            show-icon
            :title="`方向值按设备协议下发（direct=${PTZ_DIRECTIONS.map((item) => item.direct).join(' / ')}），速度 ${speed}。`"
          />
        </section>
      </div>

      <section class="view-panel">
        <div class="view-panel__head">
          <h2>预置点清单</h2>
          <small>共 {{ presets.length }} 个预置点</small>
        </div>
        <el-table :data="presets" border stripe size="small">
          <template #empty>
            <el-empty description="摄像头未返回预置点" :image-size="64" />
          </template>
          <el-table-column prop="presetId" label="预置点 ID" width="120" />
          <el-table-column prop="name" label="名称" min-width="180" />
          <el-table-column label="操作" width="220">
            <template #default="{ row }">
              <el-button
                text
                type="primary"
                size="small"
                :icon="SwitchButton"
                :loading="pendingKey === 'goto'"
                @click="currentPresetId = row.presetId; goPreset()"
              >
                转到此预置点
              </el-button>
              <el-button text type="warning" size="small" :icon="Warning" @click="currentPresetId = row.presetId; snapshot()">
                抓图
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </AsyncSection>
  </div>
</template>

<style scoped>
.camera-layout {
  display: grid;
  grid-template-columns: minmax(320px, 1.4fr) minmax(280px, 1fr) minmax(280px, 1fr);
  gap: 16px;
  margin-bottom: 16px;
}

@media (max-width: 1200px) {
  .camera-layout {
    grid-template-columns: 1fr 1fr;
  }
}

@media (max-width: 820px) {
  .camera-layout {
    grid-template-columns: 1fr;
  }
}

.camera-stage__head,
.camera-stage__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.camera-live {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 1px;
  color: var(--el-color-danger);
}

.camera-live i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentcolor;
}

.camera-stage__frame {
  position: relative;
  margin: 12px 0;
  border-radius: 8px;
  overflow: hidden;
  background: #0f1419;
  aspect-ratio: 16 / 10;
}

.camera-stage__frame img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.camera-stage__meta {
  position: absolute;
  left: 10px;
  bottom: 8px;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgb(0 0 0 / 55%);
  color: #fff;
  font-size: 11px;
}

.full-control,
.preset-input {
  width: 100%;
}

.camera-controls__row {
  display: flex;
  gap: 10px;
  margin-top: 12px;
  flex-wrap: wrap;
}

.preset-hint {
  margin: 10px 0 0;
  font-size: 12px;
}

.ptz-pad {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-top: 12px;
}

.ptz-button {
  width: 100%;
  margin-left: 0 !important;
}

.camera-tip {
  margin-top: 14px;
}
</style>
