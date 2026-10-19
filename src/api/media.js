import request from '@/utils/request'
import { unwrap } from './envelope'

/**
 * 媒体资产只读接口：列表 / 详情 / 内容（回放与下载）。
 * 写入只有 POST /media/captures（采集），见 api/inspection.js 的 captureMedia。
 */

export function listMediaAssets(params = {}) {
  return request({ url: '/api/v1/media/assets', method: 'get', params })
}

export function getMediaAsset(assetId) {
  return request({ url: '/api/v1/media/assets/' + encodeURIComponent(assetId), method: 'get' })
}

/** 以 blob 拉取媒体内容（带登录态；<audio> 的 src 不带 Authorization，必须走 fetch）。 */
async function fetchAssetBlob(assetId) {
  const response = await request({
    url: '/api/v1/media/assets/' + encodeURIComponent(assetId) + '/content',
    method: 'get',
    responseType: 'blob',
    timeout: 0
  })
  return response.data
}

/** 取一段音频的可播放 URL（object URL，调用方负责 revoke）。 */
export async function loadAudioUrl(assetId) {
  const blob = await fetchAssetBlob(assetId)
  return URL.createObjectURL(blob)
}

/** 触发浏览器下载指定资产（文件名取资产元数据的 fileName）。 */
export async function downloadMediaAsset(assetId) {
  const value = unwrap(await getMediaAsset(assetId), {})
  const name = value.fileName || assetId
  const blob = await fetchAssetBlob(assetId)
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
