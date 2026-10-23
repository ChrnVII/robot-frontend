export function ptzSpeedRatio(percent) {
  const value = Number(percent)
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError('云台速度必须在 0–100% 范围内')
  }
  return value / 100
}

export function cameraCommandError(result) {
  const state = String(result?.state || '').toLowerCase()
  if (state !== 'rejected' && state !== 'failed') return ''
  const reason = result.rejectReason || result.reject_reason || result.message
  return reason ? `云台指令失败：${reason}` : '云台指令被后端拒绝'
}
