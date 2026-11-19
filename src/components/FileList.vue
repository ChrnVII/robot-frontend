<script setup>
// 产物文件清单：路径 / 大小 / 类型，行内提供预览与下载。
// 只负责展示与抛事件，取数逻辑留在页面（不同产物来源的接口不一样）。
import { computed } from 'vue'
import { Download, VideoPlay } from '@element-plus/icons-vue'
import { formatBytes } from '@/utils/format'

const props = defineProps({
  files: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  emptyText: { type: String, default: '暂无产物文件' }
})

const emit = defineEmits(['preview', 'download'])

const PREVIEWABLE = new Set(['mkv', 'mp4', 'wav'])

function kindOf(file) {
  const name = String(file?.path || file?.name || '')
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
  if (ext === 'mkv' || ext === 'mp4') return 'video'
  if (ext === 'wav' || ext === 'mp3') return 'audio'
  if (ext === 'jpg' || ext === 'jpeg' || ext === 'png') return 'image'
  return ext || 'file'
}

function canPreview(file) {
  return PREVIEWABLE.has(kindOf(file))
}

const rows = computed(() => (props.files || []).map((file) => ({
  ...file,
  kind: kindOf(file),
  sizeText: file?.size ? formatBytes(file.size) : '—'
})))
</script>

<template>
  <div class="file-list">
    <el-table :data="rows" size="small" border :empty-text="emptyText" v-loading="loading">
      <el-table-column label="文件" min-width="240">
        <template #default="{ row }">
          <span class="mono">{{ row.path || row.name }}</span>
        </template>
      </el-table-column>
      <el-table-column label="类型" width="90">
        <template #default="{ row }">
          <el-tag size="small" effect="plain" type="info">{{ row.kind }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="大小" width="110">
        <template #default="{ row }">{{ row.sizeText }}</template>
      </el-table-column>
      <el-table-column label="操作" width="170" fixed="right">
        <template #default="{ row }">
          <el-button
            text
            type="primary"
            size="small"
            :icon="VideoPlay"
            :disabled="!canPreview(row)"
            @click="emit('preview', row)"
          >预览</el-button>
          <el-button text size="small" :icon="Download" @click="emit('download', row)">下载</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  word-break: break-all;
}
</style>
