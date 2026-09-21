<script setup>
// 列表页通用表格：Element Plus 表格 + 分页 + 空状态，页面只描述列。
// 列定义：{ prop, label, width, minWidth, align, fixed, formatter(row), slot }
// 需要自定义单元格时用 #cell-<prop> 插槽。
import { computed } from 'vue'

const props = defineProps({
  rows: { type: Array, default: () => [] },
  columns: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  rowKey: { type: String, default: 'id' },
  emptyText: { type: String, default: '暂无数据' },
  // 客户端分页；total 为 0 时不显示分页条。
  pagination: { type: Boolean, default: true },
  page: { type: Number, default: 1 },
  pageSize: { type: Number, default: 10 },
  total: { type: Number, default: 0 },
  pageSizes: { type: Array, default: () => [10, 20, 30, 50] },
  height: { type: [String, Number], default: undefined },
  stripe: { type: Boolean, default: true },
  rowClassName: { type: [String, Function], default: '' }
})

const emit = defineEmits(['update:page', 'update:pageSize', 'row-click'])

const totalCount = computed(() => (props.total > 0 ? props.total : props.rows.length))
const showPagination = computed(() => props.pagination && totalCount.value > 0)

function handleRowClick(row) {
  emit('row-click', row)
}
</script>

<template>
  <div class="data-table">
    <el-table
      v-loading="loading"
      :data="rows"
      :row-key="rowKey"
      :height="height"
      :stripe="stripe"
      :row-class-name="rowClassName"
      border
      size="default"
      @row-click="handleRowClick"
    >
      <template #empty>
        <el-empty :description="emptyText" :image-size="72" />
      </template>

      <el-table-column
        v-for="column in columns"
        :key="column.prop || column.label"
        v-bind="column"
        :formatter="column.formatter"
      >
        <template v-if="column.slot" #default="scope">
          <slot :name="`cell-${column.slot}`" v-bind="scope" />
        </template>
        <template v-else-if="column.formatter" #default="scope">
          {{ column.formatter(scope.row, scope.column, scope.row[column.prop], scope.$index) }}
        </template>
      </el-table-column>
    </el-table>

    <div v-if="showPagination" class="data-table__pagination">
      <el-pagination
        background
        layout="total, sizes, prev, pager, next, jumper"
        :current-page="page"
        :page-size="pageSize"
        :page-sizes="pageSizes"
        :total="totalCount"
        @update:current-page="emit('update:page', $event)"
        @update:page-size="emit('update:pageSize', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.data-table {
  width: 100%;
}

.data-table__pagination {
  display: flex;
  justify-content: flex-end;
  padding: 14px 0 2px;
}
</style>
