// 主题切换：light / dark，持久化到 localStorage。
// index.html 里有一段等价的内联脚本，在首帧前就把 .dark 挂上，避免闪白；
// 这里负责运行时的读取与切换，两处共用 STORAGE_KEY。
import { computed, ref } from 'vue'

const STORAGE_KEY = 'app-theme'

function readInitial() {
  if (typeof document === 'undefined') return false
  return document.documentElement.classList.contains('dark')
}

// 模块级单例：侧栏顶部的切换按钮和任何需要读主题的组件共享同一份状态。
const isDark = ref(readInitial())

function apply(dark) {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('dark', dark)
  try {
    localStorage.setItem(STORAGE_KEY, dark ? 'dark' : 'light')
  } catch {
    /* 隐私模式忽略 */
  }
}

export function useTheme() {
  function setDark(dark) {
    isDark.value = Boolean(dark)
    apply(isDark.value)
  }

  function toggle() {
    setDark(!isDark.value)
  }

  return {
    isDark: computed(() => isDark.value),
    themeLabel: computed(() => (isDark.value ? '切换到浅色' : '切换到深色')),
    setDark,
    toggle
  }
}
