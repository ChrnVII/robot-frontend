import request from '@/utils/request'

// 后端和 robot-core 健康检查
export function getHealth(params) {
  return request({
    url: '/healthz',
    method: 'get',
    params
  });
}

// 获取平台信息
export function getPlatformInfo(params) {
  return request({
    url: '/api/v1/platform',
    method: 'get',
    params
  });
}

// 获取组件和协议版本
export function getVersion(params) {
  return request({
    url: '/version',
    method: 'get',
    params
  });
}