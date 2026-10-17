// 服务端分页表格：把「筛选条件 → 请求 → 页数据 / 总数 / 错误」收口成一个状态机。
//
// 改造前三个列表页（任务 / 告警 / 运行）都是 listXxx() 拉全量再在浏览器里
// filter + slice：数据涨到几千条时，首屏要多传几 MB，每次输入关键词都要重算全表。
// 现在筛选与分页都由后端完成，前端只持有当前这一页。
import { ref } from 'vue'
import { getErrorMessage } from '@/utils/request'

export function useServerTable(fetcher, options = {}) {
  const { pageSize: initialPageSize = 10, initialFilters = {} } = options

  // 用深响应式而不是 shallowRef：表格里就地改一行（如启停开关）也要能触发渲染。
  // 一页最多几十行，代理成本可以忽略；全量列表时代价才高，而那正是这次要消灭的形态。
  const rows = ref([])
  const total = ref(0)
  const page = ref(1)
  const pageSize = ref(initialPageSize)
  const loading = ref(false)
  const error = ref('')
  const loadedAt = ref('')

  let requestId = 0
  let filters = { ...initialFilters }

  /**
   * 拉取当前页。返回 true 表示本次请求成功落地，便于刷新按钮给出正确反馈。
   * @param {object} nextFilters 覆盖当前筛选条件（缺省沿用上一次）
   */
  async function load(nextFilters) {
    if (nextFilters) filters = { ...filters, ...nextFilters }
    const current = ++requestId
    loading.value = true
    error.value = ''
    try {
      const result = await fetcher({ page: page.value, pageSize: pageSize.value, ...filters })
      // 只有最后一次请求可以落地，避免快速输入关键词时旧响应覆盖新结果。
      if (current !== requestId) return false
      // 删除掉当前页最后一条后页码会越界，回退到实际存在的最后一页。
      if (!result.rows.length && page.value > 1 && result.total > 0) {
        page.value = Math.min(page.value, Math.max(1, Math.ceil(result.total / pageSize.value)))
        return load()
      }
      rows.value = result.rows
      total.value = result.total
      loadedAt.value = new Date().toISOString()
      return true
    } catch (reason) {
      if (current !== requestId) return false
      error.value = getErrorMessage(reason)
      return false
    } finally {
      if (current === requestId) loading.value = false
    }
  }

  /** 筛选条件变化：回到第一页重新查。 */
  function search(nextFilters) {
    page.value = 1
    return load(nextFilters)
  }

  /** 分页器翻页：页码由组件受控传入。 */
  function setPage(next) {
    const target = Math.max(1, Number(next) || 1)
    if (target === page.value) return Promise.resolve(true)
    page.value = target
    return load()
  }

  function setPageSize(next) {
    const target = Math.max(1, Number(next) || initialPageSize)
    if (target === pageSize.value) return Promise.resolve(true)
    pageSize.value = target
    page.value = 1
    return load()
  }

  /** 增删改之后重新取当前页，保持用户位置。 */
  function reload() {
    return load()
  }

  return {
    rows,
    total,
    page,
    pageSize,
    loading,
    error,
    loadedAt,
    load,
    search,
    reload,
    setPage,
    setPageSize
  }
}
