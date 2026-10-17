<script setup>
// 异步区块：统一 loading / error / 空数据 三种中间态，页面只写业务内容。
// 关键约定：error 只在内容顶部叠加一条可重试的提示条，不再吞掉默认插槽，
//           这样后端不可用时页面框架（表头、卡片、表格和按钮）依旧完整可见，
//           页面自身只需保证插槽里的取值对 null / undefined 有兜底。
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
    <!-- 页面可通过 #skeleton 提供与真实布局同构的骨架，避免加载完成时高度突变 -->
    <slot name="skeleton">
      <el-skeleton :rows="skeletonRows" animated />
    </slot>
    <p v-if="loadingText" class="async-section__hint">{{ loadingText }}</p>
  </div>

  <template v-else>
    <!-- 读取失败时只提示不遮挡：页面框架继续渲染，用户仍能看到结构并手动重试 -->
    <div v-if="error" class="async-section__error" role="alert">
      <el-alert type="error" :closable="false" show-icon :title="error" />
      <el-button class="async-section__retry" size="small" type="primary" plain @click="emit('retry')">
        重新加载
      </el-button>
    </div>

    <el-empty v-if="empty" :description="emptyText">
      <slot name="empty" />
    </el-empty>

    <slot v-else />
  </template>
</template>

<style scoped>
.async-section {
  padding: 18px;
  background: var(--app-surface);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
}

.async-section__hint {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--app-text-muted);
  text-align: center;
}

.async-section__error {
  margin-bottom: 12px;
}

.async-section__retry {
  margin-top: 10px;
}
</style>
