import { fileURLToPath, URL } from 'node:url'

import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_PROXY_TARGET || 'http://127.0.0.1:8100'
  // 底盘循迹服务（track.vue 专用，端口 9100）。
  // 注意：这里填的是「运行 Vite 的这台机器」能访问到的地址；
  // 如果 9100 服务在机器人或另一台主机上，改 .env.development 里的 VITE_TRACK_PROXY_TARGET。
  const trackTarget = env.VITE_TRACK_PROXY_TARGET || 'http://127.0.0.1:9100'

  return {
    plugins: [
      vue(),
      vueDevTools(),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    // 与旧项目一致：后端接口、健康检查和 WebSocket 都通过开发代理转发，前端只发同源请求。
    // 循迹服务同理，走 /track-api 前缀代理：浏览器只请求 5173 同源地址，
    // 跨域由 Node 代理承担，Cookie 也随之变成同源 Cookie（不再受 CORS / SameSite 限制）。
    server: {
      // 允许用局域网地址（如 192.168.136.1:5173）访问开发服务器。
      host: true,
      port: 5173,
      proxy: {
        '/api': { target, changeOrigin: true },
        '/healthz': { target, changeOrigin: true },
        '/readyz': { target, changeOrigin: true },
        '/version': { target, changeOrigin: true },
        '/ws': { target, changeOrigin: true, ws: true },
        '/track-api': {
          target: trackTarget,
          changeOrigin: true,
          // /track-api/api/tasks -> http://<trackTarget>/api/tasks
          rewrite: (path) => path.replace(/^\/track-api/, ''),
          // 把 9100 下发的 Cookie 作用域限制在 /track-api 内，
          // 否则它的会话 Cookie 会被带到主后端 /api 请求上，导致写操作被判 403。
          cookiePathRewrite: '/track-api',
        },
      },
    },
  }
})
