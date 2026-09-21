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

export async function listStations(params = {}) {
  return unwrapRows(await request({ url: '/api/v1/map/stations', method: 'get', params }), [])
}

export async function saveStations(stations = [], mapVersion) {
  const response = await request({
    url: '/api/v1/map/stations',
    method: 'put',
    data: { mapVersion, stations }
  })
  return unwrap(response, { saved: stations.length })
}