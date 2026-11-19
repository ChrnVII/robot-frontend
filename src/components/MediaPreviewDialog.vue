<script setup>
// 媒体预览弹窗：视频走"后端转封装成 MP4"，音频走原生播放。
//
// 为什么不用 <video src=".mkv">：浏览器不支持 matroska 容器，画面出不来。
// 为什么不用 <video src="/api/...">：开启鉴权后媒体标签带不上 Authorization 头，
// 会直接 401。所以统一走 axios 取 blob 再转 objectURL，关闭时 revoke 掉。
import { computed, ref, watch } from 'vue'
import { getErrorMessage } from '@/utils/request'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: '预览' },
  kind: { type: String, default: 'video' }, // video / audio
  // 返回 Blob 的加载函数；由页面决定从哪个接口取（任务产物 / 预览转封装）
  loader: { type: Function, default: null }
})

const emit = defineEmits(['update:modelValue'])

const src = ref('')
const loading = ref(false)
const error = ref('')

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})

function release() {
  if (src.value) {
    URL.revokeObjectURL(src.value)
    src.value = ''
  }
}

async function load() {
  if (!props.loader) return
  loading.value = true
  error.value = ''
  release()
  try {
    const blob = await props.loader()
    if (!blob) throw new Error('没有取到内容')
    src.value = URL.createObjectURL(blob instanceof Blob ? blob : new Blob([blob]))
  } catch (reason) {
    error.value = getErrorMessage(reason, '预览加载失败')
  } finally {
    loading.value = false
  }
}

watch(() => props.modelValue, (open) => {
  if (open) load()
  else {
    release()
    error.value = ''
  }
})
</script>

<template>
  <el-dialog v-model="visible" :title="title" width="820px" destroy-on-close @closed="release">
    <div v-loading="loading" class="preview-body">
      <el-alert
        v-if="error"
        type="warning"
        :closable="false"
        show-icon
        :title="error"
        description="文件可能仍在录制、已损坏，或该类型不支持在线预览；可直接下载后查看。"
      />
      <template v-else>
        <video v-if="src && kind === 'video'" :src="src" controls autoplay class="preview-video" />
        <audio v-else-if="src && kind === 'audio'" :src="src" controls class="preview-audio" />
        <div v-else-if="!loading" class="preview-empty">正在准备预览…</div>
      </template>
    </div>
  </el-dialog>
</template>

<style scoped>
.preview-body {
  min-height: 220px;
}

.preview-video {
  width: 100%;
  max-height: 62vh;
  background: #000;
  border-radius: 8px;
}

.preview-audio {
  width: 100%;
}

.preview-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
  color: var(--app-text-muted);
  font-size: 13px;
}
</style>
