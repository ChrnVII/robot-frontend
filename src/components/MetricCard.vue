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
  gap: 5px;
  padding: 14px 16px;
  background: var(--app-surface);
  border: 1px solid var(--app-border);
  border-left: 3px solid var(--app-border-strong);
  border-radius: var(--app-radius);
  box-shadow: var(--app-shadow-sm);
  transition: box-shadow 0.16s ease;
}

.metric-card:hover {
  box-shadow: var(--app-shadow);
}

.metric-card--primary { border-left-color: var(--app-primary); }
.metric-card--success { border-left-color: var(--app-success); }
.metric-card--warning { border-left-color: var(--app-warning); }
.metric-card--danger { border-left-color: var(--app-danger); }
.metric-card--info { border-left-color: var(--app-text-muted); }

.metric-card__label {
  font-size: 12px;
  font-weight: 500;
  color: var(--app-text-muted);
}

.metric-card__value {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.metric-card__value strong {
  font-size: 22px;
  font-weight: 600;
  color: var(--app-text);
  line-height: 1.2;
  letter-spacing: -0.02em;
}

.metric-card__value small {
  font-size: 12px;
  color: var(--app-text-muted);
}

.metric-card__hint {
  font-size: 12px;
  color: var(--app-text-muted);
}
</style>
