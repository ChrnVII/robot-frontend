import axios from 'axios';

// 创建 Axios 实例
const service = axios.create({
  baseURL: import.meta.env.VITE_SERVER_URL,  // 从环境变量读取基础地址
  timeout: 10000,                          // 请求超时时间
  headers: { 'Content-Type': 'application/json' }
});

// ---------- 请求拦截器 ----------
// service.interceptors.request.use(
//   (config) => {
//     // 在请求发送前做些什么（例如添加 Token）
//     const token = localStorage.getItem('token');
//     if (token) {
//       config.headers.Authorization = `Bearer ${token}`;
//     }
//     // 可根据需要处理请求数据（如序列化）
//     return config;
//   },
//   (error) => {
//     // 请求错误时的处理
//     console.error('请求错误：', error);
//     return Promise.reject(error);
//   }
// );

// ---------- 响应拦截器 ----------
// service.interceptors.response.use(
//   (response) => {
//     // 对响应数据做统一处理（例如直接返回 data）
//     const res = response.data;
//     // 假设后端约定 code === 200 表示成功
//     if (res.code !== 200) {
//       // 业务错误提示（可统一使用 UI 组件库的 Message）
//       console.warn('业务错误：', res.message || '请求失败');
//       return Promise.reject(new Error(res.message || 'Error'));
//     }
//     return res; // 返回完整响应体，或只返回 res.data
//   },
//   (error) => {
//     // HTTP 状态码错误处理
//     const { response } = error;
//     if (response) {
//       // 根据状态码进行统一处理（如 401 跳转登录）
//       switch (response.status) {
//         case 401:
//           // 清除 token 并跳转到登录页
//           localStorage.removeItem('token');
//           window.location.href = '/login';
//           break;
//         case 403:
//           console.error('权限不足');
//           break;
//         case 404:
//           console.error('请求资源不存在');
//           break;
//         default:
//           console.error(`请求错误 ${response.status}：`, response.data?.message);
//       }
//     } else {
//       // 网络异常或无响应
//       console.error('网络异常，请检查连接');
//     }
//     return Promise.reject(error);
//   }
// );

export default service;