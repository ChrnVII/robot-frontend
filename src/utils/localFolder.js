// 本机文件夹直开：只有「前端与后端部署在同一台主机上」时才成立。
//
// 主路径是后端 POST /api/v1/cam/recordings/open（服务端拉资源管理器）。
// 这里是它的降级兜底：后端没有桌面会话时，改用 window.open(file://) 尝试，
// 并始终把路径写进剪贴板，用户可粘贴到资源管理器地址栏。
//
// 目录来源：后端返回的绝对路径优先，其次才是构建期配置 VITE_RECORDINGS_DIR。
// 不再向用户询问路径——存储位置由后端配置决定。

/** 构建期配置的录像目录（绝对路径，可留空），仅作兜底。 */
export function configuredRecordingsDir() {
  return String(import.meta.env.VITE_RECORDINGS_DIR || '').trim()
}

/** 本地绝对路径转 file:// URL（Windows 盘符与反斜杠一并归一）。 */
export function folderUrl(path) {
  const normalized = String(path).trim().replace(/\\/g, '/').replace(/\/+$/, '')
  const prefix = normalized.startsWith('/') ? 'file://' : 'file:///'
  return prefix + encodeURI(normalized)
}

/** 复制文本：优先 Clipboard API，非安全上下文退回 execCommand。 */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 非 HTTPS / 无权限：走下面的兜底
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

/** 尝试打开本机目录，同时把路径复制到剪贴板；返回两个动作的结果。 */
export async function openLocalFolder(path) {
  const dir = String(path || '').trim()
  if (!dir) return { opened: false, copied: false }
  let opened = false
  try {
    opened = Boolean(window.open(folderUrl(dir), '_blank', 'noopener'))
  } catch {
    opened = false
  }
  const copied = await copyText(dir)
  return { opened, copied }
}
