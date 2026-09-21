<script setup>
// 指标卡：总览页和底盘页共用的小型数值展示单元。
defineProps({
  label: { type: String, required: true },
  value: { type: [String, Number], default: '—' },
  unit: { type: String, default: '' },
  hint: { type: String, default: '' },
  // Element Plus tag 类型：primary / success / warning / danger / info
  type: { type: String, default: '' }
})
</script>

<template>
  <div class="metric-card" :class="type ? `metric-card--${type}` : ''">
    <span class="metric-card__label">{{ label }}</span>
    <div class="metric-card__value">
      <strong>{{ value }}</strong>
      <small v-if="unit">{{ unit }}</small>
    </div>
    <span v-if="hint" class="metric-card__hint">{{ hint }}</span>
  </div>
</template>

<style scoped>
.metric-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-left: 3px solid var(--el-border-color);
  border-radius: 8px;
}

.metric-card--primary { border-left-color: var(--el-color-primary); }
.metric-card--success { border-left-color: var(--el-color-success); }
.metric-card--warning { border-left-color: var(--el-color-warning); }
.metric-card--danger { border-left-color: var(--el-color-danger); }
.metric-card--info { border-left-color: var(--el-color-info); }

.metric-card__label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.metric-card__value {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.metric-card__value strong {
  font-size: 22px;
  font-weight: 700;
  color: var(--el-text-color-primary);
  line-height: 1.2;
}

.metric-card__value small {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.metric-card__hint {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}
</style>
