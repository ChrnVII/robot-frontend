// 刷新按钮的统一反馈。
// 改造前各页各写一套：任务页/告警页刷新成功弹 toast，总览页静默，
// 失败时又只有一条顶部错误条，用户分不清"点了有没有反应"。
// 这里统一成：成功必有提示；失败提示具体原因；请求过快时补足最短加载态。
import { ElMessage } from 'element-plus'
import { getErrorMessage } from '@/utils/request'

//: 最短加载态：接口毫秒级返回时，按钮的 loading 一闪而过，用户会以为没点上。
const MIN_SPIN_MS = 320

export function useRefreshFeedback() {
  /**
   * @param {Function} loader 触发刷新的函数，可以返回 false 表示失败
   * @param {{success?: string, failure?: string, isError?: Function}} options
   *        isError 用于读取页面已有的 error 状态（如 useAsyncData 的 error ref）
   */
  async function refresh(loader, options = {}) {
    const { success = '数据已刷新', failure = '刷新失败', isError } = options
    const startedAt = Date.now()
    let thrown = null
    let ok = true

    try {
      ok = (await loader()) !== false
    } catch (reason) {
      thrown = reason
      ok = false
    }

    const elapsed = Date.now() - startedAt
    if (elapsed < MIN_SPIN_MS) {
      await new Promise((resolve) => setTimeout(resolve, MIN_SPIN_MS - elapsed))
    }

    const pageError = typeof isError === 'function' ? isError() : ''
    if (!ok || pageError || thrown) {
      ElMessage.error(pageError || getErrorMessage(thrown, failure))
      return false
    }

    ElMessage.success(success)
    return true
  }

  return { refresh }
}
