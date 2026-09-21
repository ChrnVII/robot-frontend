<script setup>
// 异步区块：统一 loading / error / 空数据 三种中间态，页面只写业务内容。
defineProps({
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  // 数据为空时是否显示空状态；有数据的页面把它设为 false 由子内容自行处理。
  empty: { type: Boolean, default: false },
  emptyText: { type: String, default: '暂无数据' },
  loadingText: { type: String, default: '正在加载…' },
  skeletonRows: { type: Number, default: 4 }
})

const emit = defineEmits(['retry'])
</script>

<template>
  <div v-if="loading" class="async-section" role="status" aria-live="polite">
    <el-skeleton :rows="skeletonRows" animated />
    <p class="async-section__hint">{{ loadingText }}</p>
  </div>

  <div v-else-if="error" class="async-section__error">
    <el-alert type="error" :closable="false" show-icon :title="error" />
    <el-button class="async-section__retry" size="small" type="primary" plain @click="emit('retry')">重新加载</el-button>
  </div>

  <el-empty v-else-if="empty" :description="emptyText">
    <slot name="empty" />
  </el-empty>

  <slot v-else />
</template>

<style scoped>
.async-section {
  padding: 18px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.async-section__hint {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  text-align: center;
}

.async-section__error {
  margin-bottom: 12px;
}

.async-section__retry {
  margin-top: 10px;
}
</style>
