<script setup>
// 页面标题栏：所有业务页共用，保证标题、副标题、右侧操作区位置一致。
defineProps({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  // 状态标签：{ text, type }，例如 { text: '系统在线', type: 'success' }
  statusText: { type: String, default: '' },
  statusType: { type: String, default: 'success' },
  updatedAt: { type: String, default: '' }
})
</script>

<template>
  <header class="page-header">
    <div class="page-header__main">
      <div class="page-header__title">
        <h1>{{ title }}</h1>
        <el-tag v-if="statusText" :type="statusType" effect="light" round size="small">{{ statusText }}</el-tag>
      </div>
      <p v-if="description" class="page-header__description">{{ description }}</p>
    </div>
    <div class="page-header__extra">
      <slot name="extra" />
      <span v-if="updatedAt" class="page-header__time">更新于 {{ updatedAt }}</span>
    </div>
  </header>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 18px;
}

.page-header__title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.page-header__title h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  color: var(--el-text-color-primary);
  letter-spacing: -0.3px;
}

.page-header__description {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.page-header__extra {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.page-header__time {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}
</style>
