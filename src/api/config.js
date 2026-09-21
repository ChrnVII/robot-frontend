// 参数设置接口层：机器人与服务连接参数。
//   GET /api/v1/config?configType=operator   读取参数
//   PUT /api/v1/config?configType=operator   保存参数
import request from '@/utils/request'
import { unwrap } from './envelope'

const CONFIG_TYPE = 'operator'

// [页面字段, 旧项目字段, 是否只读]
export const PARAM_FIELDS = [
  { key: 'robotId', legacy: ['robot_id'], label: 'robot_id', readonly: true },
  { key: 'name', legacy: ['name'], label: 'name' },
  { key: 'type', legacy: ['type'], label: 'type' },
  { key: 'icon', legacy: ['icon'], label: 'icon' },
  { key: 'config', legacy: ['config'], label: 'config' },
  { key: 'linkFlag', legacy: ['link_flag'], label: 'link_flag' },
  { key: 'clientId', legacy: ['client_id'], label: 'client_id' },
  { key: 'clientUser', legacy: ['client_user'], label: 'client_user' },
  { key: 'clientPsw', legacy: ['client_psw'], label: 'client_psw', secret: true },
  { key: 'clientUrl', legacy: ['client_url'], label: 'client_url' },
  { key: 'servKey', legacy: ['serv_key'], label: 'serv_key', secret: true },
  { key: 'servUrl', legacy: ['serv_url'], label: 'serv_url' }
]

export const READONLY_PARAM_KEYS = PARAM_FIELDS.filter((field) => field.readonly).map((field) => field.key)

export function normalizeParams(source) {
  const input = source && typeof source === 'object' ? source : {}
  const result = {}
  PARAM_FIELDS.forEach((field) => {
    const value = [field.key, ...field.legacy].map((key) => input[key]).find((item) => item !== undefined && item !== null)
    result[field.key] = value === undefined ? '' : String(value)
  })
  return result
}

export function getParams(params = {}) {
  return request({
    url: '/api/v1/config',
    method: 'get',
    params: { configType: CONFIG_TYPE, ...params }
  })
}

export function saveParams(values = {}) {
  const payload = { ...values }
  READONLY_PARAM_KEYS.forEach((key) => { delete payload[key] })
  return request({
    url: '/api/v1/config',
    method: 'put',
    params: { configType: CONFIG_TYPE },
    data: payload
  })
}

/** 便捷方法：读回并归一化参数对象。 */
export async function fetchParams() {
  return normalizeParams(unwrap(await getParams(), {}))
}