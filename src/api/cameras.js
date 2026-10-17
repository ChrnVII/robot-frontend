// 相机目录：球形摄像头与多路抓图相机的唯一编号来源（后端 GET /api/v1/cameras）。
// 通道列表不再由前端写死 8 路，改由这份清单驱动；接口不可用时页面回退内置 8 路。
import request from '@/utils/request'

export function listCameras() {
  return request({ url: '/api/v1/cameras', method: 'get' })
}
