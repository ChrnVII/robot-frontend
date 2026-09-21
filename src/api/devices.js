// 移动底盘命令层：把页面上的语义按钮映射成真实设备命令，页面不直接接触 target/action。
import { sendDeviceCommand } from './safety'

// [target, action]：必须与 robot-core 设备能力返回的动作名一致。
const COMMAND_MAP = {
  clearFault: ['motion', 'motion.clear_fault'],
  startTask: ['motion', 'motion.start_task'],
  stopTask: ['motion', 'motion.stop'],
  pause: ['motion', 'motion.pause'],
  resume: ['motion', 'motion.resume'],
  chargeTask: ['motion', 'motion.charge_task'],
  relocate: ['motion', 'motion.relocate'],
  clearAlarm: ['motion', 'motion.clear_alarm'],
  gotoStation: ['motion', 'motion.goto_station'],
  lightOn: ['light', 'light.on'],
  lightOff: ['light', 'light.off'],
  charge: ['battery', 'battery.charge']
}

/** 页面可用的机器人命令清单，用于渲染按钮与文案。 */
export const ROBOT_COMMANDS = [
  { id: 'clearFault', label: '故障清除', type: 'warning' },
  { id: 'startTask', label: '开始任务', type: 'primary' },
  { id: 'stopTask', label: '结束任务', type: 'danger' },
  { id: 'pause', label: '暂停', type: 'warning' },
  { id: 'resume', label: '恢复', type: 'success' },
  { id: 'chargeTask', label: '回充任务', type: 'primary' },
  { id: 'charge', label: '充电', type: 'primary' },
  { id: 'lightOn', label: '开灯', type: 'success' },
  { id: 'lightOff', label: '关灯', type: 'info' },
  { id: 'relocate', label: '重定位', type: 'info' },
  { id: 'clearAlarm', label: '解除报警', type: 'danger' },
  { id: 'gotoStation', label: '前往站点', type: 'info' }
]

export const CONFIRM_COMMANDS = new Set(['stopTask', 'chargeTask', 'relocate', 'clearAlarm', 'gotoStation'])

export function robotCommandLabel(command) {
  return ROBOT_COMMANDS.find((item) => item.id === command)?.label || command
}

export function needsConfirmation(command) {
  return CONFIRM_COMMANDS.has(command)
}

/** 下发机器人命令。 */
export function sendRobotCommand(command, payload = {}) {
  const mapped = COMMAND_MAP[command]
  if (!mapped) throw new Error(`不支持的机器人命令：${command}`)
  return sendDeviceCommand(mapped[0], mapped[1], { ...payload })
}

/** 任务模式：0 正常、1 演示。 */
export const TASK_MODES = [
  { value: '0', label: '正常' },
  { value: '1', label: '演示' }
]