<script setup>
// 分组信息卡：把同一维度（机器人 / 状态 / 环境）的多个读数收进一张卡。
// 只负责排版，数值格式化与"读不到就横杠"的兜底全部由调用方算好后传入。
defineProps({
  title: { type: String, required: true },
  // 卡头内置图标：robot（机器人）/ status（状态）/ env（环境）
  kind: { type: String, default: 'robot' },
  // 每行：{ label, value, unit, hint, tone, mono }
  rows: { type: Array, default: () => [] },
  // 可选底部进度条（用于电量）：{ value: 0-100, tone: primary / warning / danger }
  progress: { type: Object, default: null }
})

const EMPTY = '—'

// 值缺失时用横杠统一兜底，并降一档颜色，避免"没数据"看起来像"读数是 0"。
function isEmpty(value) {
  return value === EMPTY || value === '' || value === null || value === undefined
}

function barWidth(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(100, Math.max(0, number))
}
</script>

<template>
  <section class="info-card" :class="`info-card--${kind}`">
    <header class="info-card__head">
      <span class="info-card__icon" aria-hidden="true">
        <svg
          v-if="kind === 'robot'"
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linecap="round"
        >
          <rect x="2.4" y="5.6" width="11.2" height="8" rx="2.6" />
          <path d="M8 5.6V3.2" />
          <circle cx="8" cy="2.4" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="5.9" cy="9.4" r="0.75" fill="currentColor" stroke="none" />
          <circle cx="10.1" cy="9.4" r="0.75" fill="currentColor" stroke="none" />
        </svg>
        <svg
          v-else-if="kind === 'status'"
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
        >
          <path d="M3 13V8.2" />
          <path d="M8 13V3.6" />
          <path d="M13 13V6.4" />
        </svg>
        <svg
          v-else
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M8 13.6c3.1 0 5-2 5-4.5C13 6.2 8 2 8 2S3 6.2 3 9.1c0 2.5 1.9 4.5 5 4.5z" />
          <path d="M8 13.6V7.2" />
          <path d="M8 9.6c1.1 0 1.9-.7 1.9-1.7" />
        </svg>
      </span>
      <h3 class="info-card__title">{{ title }}</h3>
      <slot name="meta" />
    </header>

    <div class="info-card__body">
      <div
        v-for="row in rows"
        :key="row.label"
        class="info-row"
        :class="{ 'info-row--empty': isEmpty(row.value) }"
      >
        <span class="info-row__label">{{ row.label }}</span>
        <span
          class="info-row__value"
          :class="[row.tone ? `is-${row.tone}` : '', row.mono ? 'is-mono' : '']"
        >
          <strong>{{ row.value }}</strong>
          <small v-if="row.unit" class="info-row__unit">{{ row.unit }}</small>
          <small v-if="row.hint" class="info-row__hint">{{ row.hint }}</small>
        </span>
      </div>
    </div>

    <div v-if="progress" class="info-card__bar">
      <span
        class="info-card__bar-fill"
        :class="progress.tone ? `is-${progress.tone}` : ''"
        :style="{ width: `${barWidth(progress.value)}%` }"
      />
    </div>
  </section>
</template>

<style scoped>
.info-card {
  --tone: var(--app-primary);
  --tone-soft: #1d6fd81f;

  display: flex;
  flex-direction: column;
  padding: 14px 16px 16px;
  background: var(--app-surface);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-lg);
  box-shadow: var(--app-shadow-sm);
}

.info-card--status {
  --tone: #6b4fd8;
  --tone-soft: #6b4fd81f;
}

.info-card--env {
  --tone: var(--app-success);
  --tone-soft: #2f9e5f1f;
}

.info-card__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--app-border);
}

.info-card__icon {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  border-radius: 7px;
  background: var(--tone-soft);
  color: var(--tone);
}

.info-card__title {
  margin: 0 auto 0 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--app-text);
}

/* 行区不撑满：电量条要紧贴最后一行，卡片拉伸出的空白留在底部 */
.info-card__body {
  padding-top: 2px;
}

.info-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
}

.info-row + .info-row {
  border-top: 1px solid var(--app-border);
}

.info-row__label {
  font-size: 12px;
  color: var(--app-text-muted);
  white-space: nowrap;
}

.info-row__value {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
  font-variant-numeric: tabular-nums;
}

.info-row__value strong {
  font-size: 13px;
  font-weight: 600;
  color: var(--app-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.info-row__value.is-mono strong {
  font-family: var(--app-font-mono);
}

.info-row__value.is-primary strong {
  font-size: 15px;
  color: var(--app-primary);
}

.info-row__value.is-danger strong {
  color: var(--app-danger);
}

.info-row__unit,
.info-row__hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--app-text-muted);
}

.info-row--empty strong {
  color: var(--app-text-muted);
  font-weight: 500;
}

.info-card__bar {
  height: 5px;
  margin-top: 10px;
  border-radius: 999px;
  background: var(--app-surface-3);
  overflow: hidden;
}

.info-card__bar-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--app-primary);
  transition: width 0.3s ease;
}

.info-card__bar-fill.is-warning {
  background: var(--app-warning);
}

.info-card__bar-fill.is-danger {
  background: var(--app-danger);
}
</style>
