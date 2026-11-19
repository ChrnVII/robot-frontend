<script setup>
// 保存路径卡片：远程操作时"打开目录"是没有意义的（它在机器人主机上开文件管理器），
// 所以主操作是「复制路径」，打开目录只作为可选的次要入口并明确标注。
import { computed, ref } from 'vue'
import { CopyDocument, FolderOpened } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'

const props = defineProps({
  path: { type: String, default: '' },
  title: { type: String, default: '保存位置' },
  hint: { type: String, default: '' },
  // 是否显示"在机器人主机打开目录"——只在明确知道能用时打开
  canOpen: { type: Boolean, default: false }
})

const emit = defineEmits(['open'])
const copying = ref(false)
const display = computed(() => props.path || '（后端尚未返回目录）')

async function copy() {
  if (!props.path) return
  copying.value = true
  try {
    // navigator.clipboard 只在安全上下文可用；HTTP 内网访问时退回 execCommand。
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(props.path)
    } else {
      const textarea = document.createElement('textarea')
      textarea.value = props.path
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }
    ElMessage.success('路径已复制')
  } catch {
    ElMessage.warning('复制失败，请手动选中路径复制')
  } finally {
    copying.value = false
  }
}
</script>

<template>
  <section class="path-card">
    <header class="path-card__head">
      <h3>{{ title }}</h3>
      <span v-if="hint" class="path-card__hint">{{ hint }}</span>
    </header>
    <div class="path-card__body">
      <code class="path-card__text">{{ display }}</code>
      <div class="path-card__actions">
        <el-button size="small" :icon="CopyDocument" :loading="copying" :disabled="!path" @click="copy">
          复制路径
        </el-button>
        <el-tooltip content="在机器人主机上打开文件管理器（远程访问时看不到该窗口）" placement="top">
          <el-button v-if="canOpen" size="small" :icon="FolderOpened" @click="emit('open')">
            在机器人主机打开
          </el-button>
        </el-tooltip>
      </div>
    </div>
  </section>
</template>

<style scoped>
.path-card {
  padding: 12px 14px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: var(--app-surface);
}

.path-card__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
}

.path-card__head h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.path-card__hint {
  color: var(--app-text-muted);
  font-size: 12px;
}

.path-card__body {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.path-card__text {
  flex: 1 1 320px;
  min-width: 0;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--app-bg-soft, rgba(0, 0, 0, 0.04));
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  word-break: break-all;
}

.path-card__actions {
  display: flex;
  gap: 8px;
}
</style>
