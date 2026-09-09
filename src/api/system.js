import request from '@/utils/request';

// 登录 get
// export function login(data) {
//   return request({
//     url: '/user/login',
//     method: 'post',
//     data
//   });
// }

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

// 判断平台是否已就绪
export function getPlatfromReady(params) {
  return request({
    url: '/readyz',
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

// 其他业务接口...