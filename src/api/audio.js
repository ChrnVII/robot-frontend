// 独立音频录制：开始 / 停止 / 查询当前录音。
//
// 与巡检会话里的「长录音」不同，这条链路是**真麦克风采集**（sounddevice → 标准 WAV），
// 设备与采样参数取自后端 configs/hardware.yaml 的 devices.audio。
// 录音文件固定写 `<任务目录>/audio/session.wav`，与视频同处一个目录。
import request from '@/utils/request'

/** 开始录音。directory 省略时由后端在 data/cams 下新建一个采集目录（仅声音时用）。 */
export function startAudioRecording(directory) {
  return request({
    url: '/api/v1/audio/recordings',
    method: 'post',
    data: directory ? { directory } : {}
  })
}

/** 停止录音并收尾 WAV，返回 { path, bytes, durationSeconds }。 */
export function stopAudioRecording() {
  return request({ url: '/api/v1/audio/recordings/stop', method: 'post' })
}

/** 当前录音状态；data 为 null 表示没有录音。 */
export function getActiveAudioRecording() {
  return request({ url: '/api/v1/audio/recordings/active', method: 'get' })
}
