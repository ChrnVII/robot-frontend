// 地图站点接口层。
//   GET  /api/v1/map/stations    站点列表
//   PUT  /api/v1/map/stations    整张地图保存（带版本号，避免双人覆盖）
import request from '@/utils/request'
import { unwrap, unwrapRows } from './envelope'

export const STATION_TYPES = [
  { value: 'inspection', label: '巡检点' },
  { value: 'transit', label: '通行点' },
  { value: 'charging', label: '充电点' }
]

export function stationTypeLabel(value) {
  return STATION_TYPES.find((item) => item.value === value)?.label || String(value ?? '')
}

export function createStation(index = 1) {
  return {
    stationId: `st-${Date.now()}-${index}`,
    station: index,
    type: 'inspection',
    cage: index,
    x: 0,
    y: 0,
    yaw: 0,
    returnStation: false,
    nextSpeed: 0.45,
    heightCheck: true,
    waitMs: 3000,
    soundInterference: false,
    takePhoto: true,
    collectEnvironment: true,
    recordAudio: false
  }
}

/**
 * 读取站点表与当前版本号。
 * 后端 GET 返回 { mapVersion, stations, rows }：版本号必须一起拿回来，
 * 否则保存时的乐观锁永远拿旧版本去比对，服务端一旦涨版本就再也存不进去。
 */
export async function fetchMap(params = {}) {
  const body = unwrap(await request({ url: '/api/v1/map/stations', method: 'get', params }), {})
  const stations = Array.isArray(body) ? body : unwrapRows(body, [])
  return {
    mapVersion: Number(body?.mapVersion) || 1,
    stations
  }
}

/** 只要站点列表的旧用法（兼容保留）。 */
export async function listStations(params = {}) {
  const { stations } = await fetchMap(params)
  return stations
}

export async function saveStations(stations = [], mapVersion) {
  const response = await request({
    url: '/api/v1/map/stations',
    method: 'put',
    data: { mapVersion, stations }
  })
  return unwrap(response, { saved: stations.length })
}