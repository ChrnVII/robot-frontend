# frontend-re

巡检机器人控制台前端（Vue 3 + Vite + Element Plus）。

## 部署要求：与后端同机

**本前端应与后端服务部署在同一台主机上**（后端默认 `http://127.0.0.1:8100`）。原因：

- 球形摄像页的「打开目录」按钮**直接打开本机磁盘上的录像文件夹**（`file://` 直开，被浏览器拦截时复制路径让用户粘贴到资源管理器），跨主机时该路径并不存在；
- 录像、抓图等媒体资产保存在后端本机磁盘，只有同机浏览器才能直接访问/打开；
- 生产配置 `VITE_SERVER_URL` 指向 `127.0.0.1`，开发环境经 Vite 代理转发到同机后端；
- 实时预览走同源 WebSocket（`/ws/camera/preview`），同机部署不需要额外的跨域与 TLS 处理。

如果确实要前后端分离部署：把 `VITE_SERVER_URL` 改成后端主机地址、后端配置 `ROBOT_CORS_ORIGINS` 并启用 HTTPS（浏览器低延迟预览要求安全上下文），同时接受「打开目录」只能复制路径、需要在后端主机上手工查看录像。

### 与「打开目录」相关的变量

| 变量 | 说明 |
| --- | --- |
| `VITE_SERVER_URL` | 后端地址；开发环境留空走 Vite 代理，生产环境填 `http://127.0.0.1:8100` |
| `VITE_RECORDINGS_DIR` | 录像目录的**绝对路径**（对应后端 `ROBOT_CAMERA_RECORDINGS_DIR`，默认 `<后端启动目录>/data/camera-recordings`）；留空则首次点击按钮时弹框询问一次，之后记在浏览器 `localStorage` |

> 浏览器安全策略不允许 http(s) 页面导航到 `file://`，所以「打开目录」是尽力而为：能直开就直开，否则把路径复制到剪贴板并提示粘贴到资源管理器地址栏。若需要真正的“一键打开”，只能由同机的本地代理或桌面壳（Electron 等）承担。

## 实时检测页的数据通道

- **预览**：`/ws/inspections/{taskRunId}/cameras/{cameraId}` 二进制帧 + 浏览器 WebCodecs 硬解，
  叠加框走同一条 WS 的 `{"t":"det"}` JSON。需要安全上下文（HTTPS 或 localhost），
  否则页面只显示具体原因、不出画面。
- **预览渲染**：解码输出只保留最新一帧、随到随画（按子码流源帧率）；
  canvas 背板按显示尺寸分配（不高于源分辨率），所有画面共用一个 `requestAnimationFrame`，
  检测框只在结果到达或背板尺寸变化时重绘。
- **状态**：运行期订阅 `/ws/inspections/{taskRunId}`（含每路 `cameraStats`），
  仅在 WS 连不上或反复断开时才退回 2 秒轮询 `GET /inspections/{taskRunId}`。

## Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) + [Vue (Official)](https://marketplace.visualstudio.com/items?itemName=Vue.volar) (and disable Vetur).

## Recommended Browser Setup

- Chromium-based browsers (Chrome, Edge, Brave, etc.):
  - [Vue.js devtools](https://chromewebstore.google.com/detail/vuejs-devtools/nhdogjmejiglipccpnnnanhbledajbpd)
  - [Turn on Custom Object Formatter in Chrome DevTools](http://bit.ly/object-formatters)
- Firefox:
  - [Vue.js devtools](https://addons.mozilla.org/en-US/firefox/addon/vue-js-devtools/)
  - [Turn on Custom Object Formatter in Firefox DevTools](https://fxdx.dev/firefox-devtools-custom-object-formatters/)

## Customize configuration

See [Vite Configuration Reference](https://vite.dev/config/).

## Project Setup

```sh
pnpm install
```

### Compile and Hot-Reload for Development

```sh
pnpm dev
```

### Compile and Minify for Production

```sh
pnpm build
```
