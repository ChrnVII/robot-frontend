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
  gap: var(--app-gap);
  flex-wrap: wrap;
  margin-bottom: var(--app-gap);
}

/* min-width:0 是窄屏不横向溢出的关键：否则标题块按内容最小宽度撑开，
   右侧按钮会被挤出视口而不是换行。 */
.page-header__main {
  min-width: 0;
  flex: 1 1 240px;
}

.page-header__title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.page-header__title h1 {
  margin: 0;
  font-size: 21px;
  font-weight: 600;
  color: var(--app-text);
  letter-spacing: -0.02em;
  line-height: 1.3;
}

.page-header__description {
  margin: 5px 0 0;
  font-size: 13px;
  color: var(--app-text-muted);
}

.page-header__extra {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  flex: 0 1 auto;
  min-width: 0;
}

.page-header__time {
  font-size: 12px;
  color: var(--app-text-muted);
  font-variant-numeric: tabular-nums;
}

/* 窄屏：操作区独占一行并允许内部换行，否则几个按钮会把标题挤出视口 */
@media (max-width: 900px) {
  .page-header {
    align-items: flex-start;
  }

  .page-header__extra {
    width: 100%;
  }
}
</style>
