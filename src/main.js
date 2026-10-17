import 'element-plus/dist/index.css' // Element Plus 基础样式
import 'element-plus/theme-chalk/dark/css-vars.css' // 深色模式变量（必须在 main.css 之前）
import './assets/main.css' // 设计令牌与全局样式，最后加载以覆盖上面的默认值

import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import App from './App.vue'
import router from './router'

const app = createApp(App)

// locale 必须显式指定：不传时 Element Plus 走 en-US，
// 分页条会渲染成 "Total 12 / Go to"，与全站中文界面割裂。
app.use(ElementPlus, { locale: zhCn })
app.use(router)

app.mount('#app')
