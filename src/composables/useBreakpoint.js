// 响应式断点：给需要「按屏幕宽度换布局密度」的场景用（如 el-descriptions 的列数）。
// 纯 CSS 能解决间距和折叠，但组件级的列数/列宽必须回到 JS 判断。
import { onBeforeUnmount, ref } from 'vue'

export function useBreakpoint(query = '(max-width: 900px)') {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return ref(false)
  }

  const media = window.matchMedia(query)
  const matches = ref(media.matches)
  const handler = (event) => {
    matches.value = event.matches
  }

  media.addEventListener('change', handler)
  onBeforeUnmount(() => media.removeEventListener('change', handler))

  return matches
}
