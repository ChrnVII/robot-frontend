// 页面上的写操作（保存、下发命令、删除）共用这一个状态机：
// pendingKey 表示当前正在执行的动作，视图据此禁用按钮并显示 loading。
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { getErrorMessage } from '@/utils/request'

export function useAsyncTask() {
  const pendingKey = ref('')
  const busy = computed(() => Boolean(pendingKey.value))

  function isPending(key) {
    return pendingKey.value === key
  }

  /**
   * 执行一次写操作。
   * @param {string} key 动作标识，用于按钮互斥与 loading 文案。
   * @param {Function} task 真正发起请求的函数。
   * @param {{ success?: string, error?: string, silentError?: boolean }} messages 提示文案。
   */
  async function run(key, task, messages = {}) {
    if (pendingKey.value) return undefined
    pendingKey.value = key
    try {
      const result = await task()
      if (messages.success) ElMessage.success(messages.success)
      return result
    } catch (reason) {
      if (!messages.silentError) ElMessage.error(getErrorMessage(reason) || messages.error || '操作失败')
      return undefined
    } finally {
      pendingKey.value = ''
    }
  }

  return { pendingKey, busy, isPending, run }
}
