import './assets/main.css'

import { createApp } from 'vue'
import ElementPlus from 'element-plus' // 导入所有elementplus组件和功能
import 'element-plus/dist/index.css' // 导入所需样式
import App from './App.vue'
import router from './router'

const app = createApp(App)

app.use(router)
app.use(ElementPlus)

app.mount('#app')
