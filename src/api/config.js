// 运行环境接口层：只读展示后端**实际生效**的配置。
//
// 为什么只剩读：
// 旧版「参数设置」页的 client/serv/icon/config 等字段（ui_config 键值表）在后端没有任何
// 消费方——存进去只是躺着，连 name 都不会显示到任何页面。继续渲染成"可编辑表单"等于
// 维持一个假功能，所以整块移除，页面改为展示 GET /config?configType=inspection 的真值。
//
// 当前可修改的参数都在启动配置里（configs/*.yaml、robot.env），改完需要重启对应进程；
// 以后若要开放"在线可改"的参数，需要先在后端加读取点，再回到这里加写入。
import request from '@/utils/request'
import { unwrap } from './envelope'

/** 运行模式取值 → 中文说明。 */
export const MODE_LABELS = {
  hardware: '真机（hardware）',
  simulated: '模拟（simulated）'
}

/** 后端实际生效的巡检运行配置（运行模式 / 模型 / 路径）。 */
export async function fetchRuntimeConfig() {
  return unwrap(await request({
    url: '/api/v1/config',
    method: 'get',
    params: { configType: 'inspection' }
  }), {})
}
