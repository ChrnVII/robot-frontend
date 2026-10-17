// 告警提醒：桌面通知 + 提示音 + 可静音。
// 巡检场景里"有新告警"是需要立刻知道的事件，但浏览器不允许自动申请通知权限
// （必须由用户手势触发），所以侧栏提供一个显式的「开启提醒」按钮；
// 未授权时仍会有侧栏角标与提示音，只是不弹系统通知。
import { computed, ref } from 'vue'

const SOUND_KEY = 'app-alert-sound'

// 模块级单例：侧栏的开关与轮询逻辑共享同一份权限/静音状态。
const permission = ref(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
const muted = ref(readMuted())

function readMuted() {
  try {
    return localStorage.getItem(SOUND_KEY) === 'off'
  } catch {
    return false
  }
}

function writeMuted(value) {
  try {
    localStorage.setItem(SOUND_KEY, value ? 'off' : 'on')
  } catch {
    /* 隐私模式忽略 */
  }
}

let audioContext = null

/** 用 WebAudio 合成两声短提示音：不引入音频文件，也不会被静态资源 404 拖累。 */
function playChime() {
  if (muted.value) return
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext
    if (!Ctor) return
    audioContext = audioContext || new Ctor()
    // 浏览器要求用户交互后才能播放，处于 suspended 时尝试恢复；失败则静默跳过。
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {})

    const now = audioContext.currentTime
    const notes = [
      { at: 0, freq: 880 },
      { at: 0.16, freq: 1180 }
    ]
    notes.forEach(({ at, freq }) => {
      const oscillator = audioContext.createOscillator()
      const gain = audioContext.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = freq
      // 快速起振 + 指数衰减，听感接近设备提示音而不是"嘟"的长音。
      gain.gain.setValueAtTime(0.0001, now + at)
      gain.gain.exponentialRampToValueAtTime(0.18, now + at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.18)
      oscillator.connect(gain).connect(audioContext.destination)
      oscillator.start(now + at)
      oscillator.stop(now + at + 0.2)
    })
  } catch {
    /* 音频不可用时静默，不影响告警本身 */
  }
}

export function useAlertNotifier() {
  const canNotify = computed(() => permission.value === 'granted')

  /** 申请通知权限：必须在用户点击事件里调用。 */
  async function requestPermission() {
    if (typeof Notification === 'undefined') return 'unsupported'
    if (Notification.permission === 'granted') {
      permission.value = 'granted'
      return permission.value
    }
    try {
      permission.value = await Notification.requestPermission()
    } catch {
      permission.value = Notification.permission
    }
    return permission.value
  }

  /**
   * 有新告警时调用。
   * @param {number} count 本次新增条数
   * @param {string} summary 通知正文（如最近一条告警内容）
   */
  function notifyNewAlerts(count, summary = '') {
    if (!count || count <= 0) return
    playChime()

    if (permission.value !== 'granted') return
    try {
      const body = summary || `当前共有 ${count} 条待处理告警，点击查看详情`
      const notification = new Notification(`新增 ${count} 条巡检告警`, {
        body,
        tag: 'inspection-alert', // 同 tag 覆盖，避免连续告警堆满通知中心
        icon: '/favicon.ico',
        requireInteraction: false
      })
      notification.onclick = () => {
        window.focus()
        window.location.assign('/alerts')
        notification.close()
      }
    } catch {
      /* 通知构造失败（如被策略禁用）时不影响页面 */
    }
  }

  function toggleMute() {
    muted.value = !muted.value
    writeMuted(muted.value)
    if (!muted.value) playChime()
  }

  /** 试听：让用户确认提示音可用，也顺带解锁 AudioContext。 */
  function testSound() {
    const wasMuted = muted.value
    muted.value = false
    playChime()
    muted.value = wasMuted
  }

  return {
    permission,
    canNotify,
    muted,
    requestPermission,
    notifyNewAlerts,
    toggleMute,
    testSound
  }
}
