// 页面通用的异步数据读取：统一 loading / error / data 三态，避免每个页面各写一套 try-catch。
// 视图只关心「怎么渲染」，请求失败与重试由 loading / error / reload 三个出口承担。
import { ref, shallowRef } from 'vue'
import { getErrorMessage } from '@/utils/request'

export function useAsyncData(loader, options = {}) {
  const { initialData = null, immediate = false, onSuccess, onError } = options

  const data = shallowRef(initialData)
  const loading = ref(false)
  const error = ref('')
  const loaded = ref(false)
  let requestId = 0

  async function load(...args) {
    const current = ++requestId
    loading.value = true
    error.value = ''
    try {
      const result = await loader(...args)
      // 只有最后一次请求可以落地，避免并发刷新互相覆盖。
      if (current !== requestId) return undefined
      data.value = result
      loaded.value = true
      onSuccess?.(result)
      return result
    } catch (reason) {
      if (current !== requestId) return undefined
      error.value = getErrorMessage(reason)
      onError?.(reason)
      return undefined
    } finally {
      if (current === requestId) loading.value = false
    }
  }

  function reset(next = initialData) {
    requestId += 1
    data.value = next
    error.value = ''
    loading.value = false
    loaded.value = false
  }

  if (immediate) load()

  return { data, loading, error, loaded, load, reload: load, reset }
}
