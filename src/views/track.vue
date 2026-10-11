<script>
// 底盘循迹：机器人端任务控制台（自包含页面）。
// 说明：本页对接的是独立的底盘循迹控制服务，与其他页面后端不同，
//      因此这里自建 axios 实例，不复用 @/utils/request。
//      服务地址不再硬编码绝对地址（原来写死 http://localhost:9100）：
//      绝对地址会被浏览器当成跨域请求，用局域网 IP 访问 5173 时必然被 CORS 拦下，
//      而且 localhost 在浏览器侧指向的是「访问者自己的机器」，根本找不到机器人上的服务。
//      改为走 Vite 的 /track-api 前缀代理（见 vite.config.js），只发 5173 同源请求。
//      代理层用 cookiePathRewrite 把 9100 的会话 Cookie 限制在 /track-api 作用域，
//      因此不会再出现「该 Cookie 被带到主应用请求上导致 403」的问题。
import axios from 'axios'

// 生产部署可在此注入同源路径（如 /track-api）或反向代理地址；不配置时默认走开发代理前缀。
const TRACK_SERVER_URL = import.meta.env.VITE_TRACK_SERVER_URL || '/track-api'

const trackApi = axios.create({
  baseURL: TRACK_SERVER_URL,
  timeout: 8000,
  withCredentials: true
})

export default {
  name: 'TrackView',
  data: function () {
    return {
      tasks: [],
      selectedTask: null,
      robotStatus: {},
      positionStatus: {},
      liftStatus: {},
      gatewayStatus: {},
      motionStatus: {state: 'IDLE'},
      motionTasks: [
        {id: 1, distance: '1.20', liftHeight: '', waitSeconds: '5'}
      ],
      nextMotionTaskId: 2,
      motionSubmitting: false,
      lastMotionState: 'IDLE',
      online: false,
      authenticated: false,
      loginBusy: false,
      loginError: '',
      loginForm: {username: '', password: ''},
      csrfToken: '',
      userName: '',
      vendorUiBaseUrl: window.location.protocol + '//' + window.location.hostname + ':9000',
      loadingTasks: false,
      busy: false,
      message: '',
      messageError: false,
      lastUpdate: null,
      pollTimer: null,
      pendingAction: '',
      pendingTimer: null,
      pendingStableCount: 0,
      logs: []
    }
  },
  computed: {
    hasFault: function () {
      var reason = this.robotStatus.reason || this.positionStatus.reason
      return this.robotStatus.move === 'Error' || this.positionStatus.move === 'Error' ||
        (reason !== undefined && reason !== null && reason !== '' && reason !== '0')
    },
    statusKey: function () {
      if (this.hasFault) return 'error'
      if (this.numberValue(this.robotStatus.taskFlag) === 1 && this.numberValue(this.robotStatus.taskStopFlag) === 1) return 'paused'
      if (this.numberValue(this.robotStatus.taskFlag) === 1) return 'running'
      return this.pendingAction === 'end' ? 'finished' : 'idle'
    },
    statusLabel: function () {
      return {idle: '空闲', running: '循迹中', paused: '已暂停', finished: '已结束', error: '故障'}[this.statusKey]
    },
    statusClass: function () { return 'state-' + this.statusKey },
    motionRunning: function () {
      return this.motionStatus.state === 'RUNNING'
    },
    motionStateLabel: function () {
      return {IDLE: '待执行', RUNNING: '执行中', FINISHED: '已完成', ERROR: '未完成'}[this.motionStatus.state] || '待执行'
    },
    motionProgressPercent: function () {
      var total = Number(this.motionStatus.steps) || 0
      var current = Number(this.motionStatus.step) || 0
      if (this.motionStatus.state === 'FINISHED') return 100
      return total ? Math.min(100, Math.round((current - 1) * 100 / total)) : 0
    },
    liftRangeLabel: function () {
      if (this.liftStatus.min === undefined || this.liftStatus.min === null ||
        this.liftStatus.max === undefined || this.liftStatus.max === null) return '原页面单位'
      return this.liftStatus.min + ' 至 ' + this.liftStatus.max
    },
    sequenceValidationMessage: function () {
      var travel = 0
      var actionCount = 0
      for (var index = 0; index < this.motionTasks.length; index++) {
        actionCount += 1
        var distance = Number(this.motionTasks[index].distance)
        if (!isFinite(distance) || Math.abs(distance) < 0.01 || Math.abs(distance) > 100) {
          return '任务 ' + (index + 1) + ' 的移动距离必须在 -100 至 100 米之间，且不能为 0'
        }
        travel += Math.abs(distance)
        var liftHeight = String(this.motionTasks[index].liftHeight === undefined || this.motionTasks[index].liftHeight === null ? '' : this.motionTasks[index].liftHeight).trim()
        if (liftHeight !== '') {
          var height = Number(liftHeight)
          if (!/^-?\d+$/.test(liftHeight) || !isFinite(height)) {
            return '任务 ' + (index + 1) + ' 的升降高度必须是整数，或留空'
          }
          if (this.liftStatus.min !== undefined && this.liftStatus.min !== null &&
            this.liftStatus.max !== undefined && this.liftStatus.max !== null &&
            (height < Number(this.liftStatus.min) || height > Number(this.liftStatus.max))) {
            return '任务 ' + (index + 1) + ' 的升降高度必须在 ' + this.liftStatus.min + ' 至 ' + this.liftStatus.max + ' 之间'
          }
          actionCount += 1
        }
        if (index < this.motionTasks.length - 1) {
          actionCount += 1
          var wait = Number(this.motionTasks[index].waitSeconds)
          if (!isFinite(wait) || wait < 0.1 || wait > 3600) {
            return '任务 ' + (index + 1) + ' 后的等待时间必须在 0.1 至 3600 秒之间'
          }
        }
      }
      if (travel > 100) return '全部任务累计移动距离不能超过 100 米'
      return actionCount > 40 ? '动作步骤总数不能超过 40，请减少任务或升降动作' : ''
    },
    sequenceValid: function () {
      return this.sequenceValidationMessage === ''
    },
    canStartSequence: function () {
      var idle = String(this.positionStatus.now || '').toLowerCase() === 'idle'
      var positionError = String(this.positionStatus.move || '').toLowerCase() === 'error'
      return this.authenticated && this.online && !this.busy && !this.motionSubmitting && !this.motionRunning &&
        this.sequenceValid && idle && !positionError &&
        this.numberValue(this.robotStatus.taskFlag) !== 1
    },
    canStart: function () {
      return this.authenticated && !this.motionRunning && !!this.selectedTask && this.isEnabledTask(this.selectedTask) && (this.statusKey === 'idle' || this.statusKey === 'finished')
    },
    canPause: function () { return false },
    canResume: function () { return false },
    canEnd: function () {
      return this.authenticated && !!this.selectedTask && (this.numberValue(this.robotStatus.taskFlag) === 1 || this.statusKey === 'error') && (this.statusKey === 'running' || this.statusKey === 'paused' || this.statusKey === 'error')
    },
    canClear: function () { return false },
    lastUpdateText: function () {
      return this.lastUpdate ? this.lastUpdate.toLocaleTimeString() : '未更新'
    }
  },
  mounted: function () {
    this.setMessage('请先登录自有控制服务', false)
    this.restoreSession()
  },
  beforeUnmount: function () {
    if (this.pollTimer) clearInterval(this.pollTimer)
  },
  methods: {
    activateSession: function (data) {
      this.authenticated = true
      this.csrfToken = data.csrfToken
      this.userName = data.user || this.loginForm.username
      this.vendorUiBaseUrl = data.vendorUiBaseUrl || this.vendorUiBaseUrl
      this.setMessage('已登录自有控制服务', false)
      this.addLog('登录成功')
      this.loadTasks()
      this.loadOperations()
      this.getStatus()
      if (this.pollTimer) clearInterval(this.pollTimer)
      this.pollTimer = setInterval(this.getStatus, 1500)
    },
    restoreSession: function () {
      var self = this
      trackApi.get('/api/auth/session', {timeout: 5000}).then(function (response) {
        if (!response.data || response.data.ok !== true || !response.data.csrfToken) throw new Error('会话响应无效')
        self.activateSession(response.data)
      }).catch(function () {})
    },
    login: function () {
      var self = this
      if (self.loginBusy) return
      self.loginBusy = true
      self.loginError = ''
      trackApi.post('/api/auth/login', self.loginForm, {timeout: 8000}).then(function (response) {
        if (!response.data || response.data.ok !== true || !response.data.csrfToken) throw new Error('登录响应无效')
        self.activateSession(response.data)
        self.loginForm.password = ''
      }).catch(function (error) {
        self.loginError = '登录失败：' + self.errorText(error)
      }).then(function () { self.loginBusy = false })
    },
    logout: function () {
      var self = this
      trackApi.post('/api/auth/logout', {}, {headers: {'X-CSRF-Token': self.csrfToken}, timeout: 5000}).catch(function () {}).then(function () {
        if (self.pollTimer) clearInterval(self.pollTimer)
        if (self.pendingTimer) clearTimeout(self.pendingTimer)
        self.authenticated = false
        self.csrfToken = ''
        self.userName = ''
        self.tasks = []
        self.selectedTask = null
        self.robotStatus = {}
        self.positionStatus = {}
        self.gatewayStatus = {}
        self.motionStatus = {state: 'IDLE'}
        self.lastMotionState = 'IDLE'
        self.online = false
        self.pendingAction = ''
        self.setMessage('已退出自有控制服务', false)
      })
    },
    numberValue: function (value) {
      var number = Number(value)
      return isNaN(number) ? 0 : number
    },
    value: function (value) {
      return value === undefined || value === null || value === '' ? '-' : value
    },
    routeCount: function (route) {
      return route ? String(route).split(',').filter(function (item) { return item !== '' }).length : 0
    },
    isEnabledTask: function (task) {
      return String(task.flag) === '1'
    },
    selectTask: function (task) {
      if (!this.isEnabledTask(task)) return
      this.selectedTask = task
      this.setMessage('已选择任务：' + (task.name || task.taskId), false)
      this.addLog('选择任务 ' + (task.name || task.taskId))
    },
    setMessage: function (text, isError) {
      this.message = text
      this.messageError = !!isError
    },
    addLog: function (text) {
      var now = new Date()
      var time = now.toLocaleTimeString()
      this.logs.unshift({time: time, text: text})
      if (this.logs.length > 20) this.logs.pop()
    },
    loadOperations: function () {
      var self = this
      trackApi.get('/api/operations', {timeout: 8000}).then(function (response) {
        if (!response.data || response.data.ok !== true) throw new Error('操作记录读取失败')
        self.logs = (response.data.operations || []).slice(0, 20).map(function (item) {
          var time = item.time ? new Date(item.time).toLocaleTimeString() : '-'
          var text = (item.action || '操作') + ' ' + (item.taskId || '') + ' ' + (item.result || '')
          return {time: time, text: text}
        })
      }).catch(function (error) {
        self.handleUnauthorized(error)
      })
    },
    loadTasks: function () {
      var self = this
      self.loadingTasks = true
      trackApi.get('/api/tasks', {timeout: 8000}).then(function (response) {
        if (!response.data || response.data.ok !== true) throw new Error((response.data && response.data.message) || '任务列表接口返回失败')
        self.tasks = (response.data.tasks || []).filter(function (item) { return item && String(item.flag) === '1' })
        if (self.selectedTask) {
          self.selectedTask = self.tasks.find(function (item) { return String(item.taskId) === String(self.selectedTask.taskId) }) || null
        }
        self.addLog('任务列表已更新，共 ' + self.tasks.length + ' 个启用任务')
      }).catch(function (error) {
        self.handleUnauthorized(error)
        self.setMessage('任务列表读取失败：' + self.errorText(error), true)
        self.addLog('任务列表读取失败')
      }).then(function () { self.loadingTasks = false })
    },
    getStatus: function () {
      var self = this
      if (!self.authenticated) return
      trackApi.get('/api/robot/status', {timeout: 8000}).then(function (response) {
        if (!response.data || response.data.ok !== true) throw new Error((response.data && response.data.message) || '状态接口返回失败')
        self.robotStatus = response.data.robot || {}
        self.positionStatus = response.data.position || {}
        self.liftStatus = response.data.lift || {}
        self.gatewayStatus = response.data.gateway || {}
        var nextMotion = response.data.motion || {state: 'IDLE'}
        var nextState = nextMotion.state || 'IDLE'
        if (self.lastMotionState === 'RUNNING' && nextState === 'FINISHED') {
          self.setMessage('动作任务已全部完成', false)
          self.addLog('动作任务已完成，累计位移 ' + self.value(nextMotion.distance) + ' 米')
        } else if (self.lastMotionState === 'RUNNING' && nextState === 'ERROR') {
          self.setMessage('动作任务未完成：' + (nextMotion.reason || '未知原因'), true)
          self.addLog('动作任务未完成')
        }
        self.motionStatus = nextMotion
        self.lastMotionState = nextState
        self.online = true
        self.lastUpdate = new Date()
        self.confirmPendingAction()
      }).catch(function (error) {
        self.handleUnauthorized(error)
        self.online = false
        self.setMessage('机器人状态读取失败：' + self.errorText(error), true)
      })
    },
    confirmPendingAction: function () {
      if (!this.pendingAction) return
      var action = this.pendingAction
      var state = this.statusKey
      if (action === 'pause') {
        if (state !== 'paused') {
          this.pendingStableCount = 0
          return
        }
        this.pendingStableCount += 1
        if (this.pendingStableCount < 3) return
      }
      var matched = (action === 'start' && state === 'running') ||
        (action === 'pause' && state === 'paused') ||
        (action === 'resume' && state === 'running') ||
        (action === 'end' && state !== 'running' && state !== 'paused') ||
        (action === 'clean' && !this.hasFault)
      if (matched) {
        if (this.pendingTimer) clearTimeout(this.pendingTimer)
        this.pendingTimer = null
        this.pendingStableCount = 0
        this.setMessage({start: '机器人已开始循迹', pause: '机器人已暂停', resume: '机器人已恢复循迹', end: '任务已结束', clean: '故障已清除'}[action], false)
        this.addLog(this.message)
        this.pendingAction = ''
      }
    },
    addMotionTask: function () {
      if (this.motionRunning || this.motionTasks.length >= 20) return
      this.motionTasks.push({id: this.nextMotionTaskId++, distance: '1.00', liftHeight: '', waitSeconds: '5'})
    },
    removeMotionTask: function (index) {
      if (this.motionRunning || this.motionTasks.length === 1) return
      this.motionTasks.splice(index, 1)
    },
    taskDirectionLabel: function (task) {
      var distance = Number(task.distance)
      if (!isFinite(distance) || Math.abs(distance) < 0.01) return '等待输入'
      return distance > 0 ? '前进 ' + Math.abs(distance) + ' 米' : '后退 ' + Math.abs(distance) + ' 米'
    },
    taskDirectionIcon: function (task) {
      return Number(task.distance) < 0 ? 'fa-arrow-down' : 'fa-arrow-up'
    },
    taskHasLift: function (task) {
      return String(task.liftHeight === undefined || task.liftHeight === null ? '' : task.liftHeight).trim() !== ''
    },
    taskStepNumber: function (index) {
      var step = 1
      for (var prior = 0; prior < index; prior++) {
        step += 1
        if (this.taskHasLift(this.motionTasks[prior])) step += 1
        step += 1
      }
      return step
    },
    isActiveMove: function (index) {
      return this.motionRunning && Number(this.motionStatus.step) === this.taskStepNumber(index)
    },
    isActiveLift: function (index) {
      return this.motionRunning && this.taskHasLift(this.motionTasks[index]) &&
        Number(this.motionStatus.step) === this.taskStepNumber(index) + 1
    },
    isActiveWait: function (index) {
      return this.motionRunning && index < this.motionTasks.length - 1 &&
        Number(this.motionStatus.step) === this.taskStepNumber(index) + 1 + (this.taskHasLift(this.motionTasks[index]) ? 1 : 0)
    },
    motionSequenceSteps: function () {
      var steps = []
      for (var index = 0; index < this.motionTasks.length; index++) {
        var task = this.motionTasks[index]
        steps.push({type: 'move', distance: Number(task.distance)})
        if (this.taskHasLift(task)) {
          steps.push({type: 'lift', height: Number(task.liftHeight)})
        }
        if (index < this.motionTasks.length - 1) {
          steps.push({type: 'wait', seconds: Number(task.waitSeconds)})
        }
      }
      return steps
    },
    startMotionSequence: function () {
      var self = this
      if (!self.canStartSequence) return
      var steps = self.motionSequenceSteps()
      self.motionSubmitting = true
      self.setMessage('正在提交动作任务...', false)
      trackApi.post('/api/motion/sequence', {steps: steps}, {
        headers: {'X-CSRF-Token': self.csrfToken},
        timeout: 8000
      }).then(function (response) {
        if (!response.data || response.data.ok !== true || !response.data.motion) {
          throw new Error((response.data && response.data.message) || '动作任务接口返回失败')
        }
        self.motionStatus = response.data.motion
        self.lastMotionState = response.data.motion.state || 'RUNNING'
        self.setMessage('共 ' + self.motionTasks.length + ' 个移动任务已开始', false)
        self.addLog('动作任务已开始，共 ' + self.motionTasks.length + ' 个移动任务')
        self.getStatus()
      }).catch(function (error) {
        self.handleUnauthorized(error)
        self.setMessage('动作任务提交失败：' + self.errorText(error), true)
        self.addLog('动作任务提交失败')
      }).then(function () { self.motionSubmitting = false })
    },
    command: function (action, body, label, expected) {
      var self = this
      if (self.busy || self.pendingAction || self.motionRunning) return
      var endpoint = action === 'start' ? '/api/task/start' : '/api/task/end'
      self.busy = true
      self.pendingAction = expected
      self.pendingStableCount = 0
      if (self.pendingTimer) clearTimeout(self.pendingTimer)
      self.setMessage('正在发送' + label + '指令，等待状态确认...', false)
      trackApi.post(endpoint, body, {headers: {'X-CSRF-Token': self.csrfToken}, timeout: 8000}).then(function (response) {
        if (!response.data || response.data.ok !== true) throw new Error((response.data && response.data.message) || '控制接口返回失败')
        self.addLog(label + '指令已发送')
        self.getStatus()
        self.pendingTimer = setTimeout(function () {
          if (self.pendingAction !== expected) return
          self.pendingAction = ''
          self.pendingStableCount = 0
          self.pendingTimer = null
          self.setMessage(label + '状态未确认，请以机器人实际状态为准。', true)
          self.addLog(label + '状态未确认')
        }, expected === 'pause' ? 7000 : 5000)
      }).catch(function (error) {
        self.handleUnauthorized(error)
        if (self.pendingTimer) clearTimeout(self.pendingTimer)
        self.pendingTimer = null
        self.pendingStableCount = 0
        self.pendingAction = ''
        self.setMessage(label + '失败：' + self.errorText(error), true)
        self.addLog(label + '失败')
      }).then(function () { self.busy = false })
    },
    startTask: function () {
      var self = this
      if (!self.selectedTask || !confirm('确认开始“' + (self.selectedTask.name || self.selectedTask.taskId) + '”吗？')) return
      self.command('start', {taskId: self.selectedTask.taskId}, '开始循迹', 'start')
    },
    endTask: function () {
      if (!confirm('确认结束当前循迹任务吗？结束后机器人不会继续执行当前路线。')) return
      this.command('end', {taskId: this.selectedTask.taskId}, '结束任务', 'end')
    },
    handleUnauthorized: function (error) {
      if (error && error.response && error.response.status === 401) {
        this.authenticated = false
        this.csrfToken = ''
        if (this.pollTimer) clearInterval(this.pollTimer)
        this.setMessage('登录已失效，请重新登录', true)
      }
    },
    errorText: function (error) {
      if (error && error.response && error.response.data && error.response.data.message) return error.response.data.message
      if (error && error.response && error.response.status) return 'HTTP ' + error.response.status
      if (error && error.message) return error.message
      return '网络或接口异常'
    }
  }
}
</script>

<template>
<div id="track-app" class="track-page">
    <header class="topbar">
        <div class="brand">
            <div class="brand-mark"><i class="fa fa-road"></i></div>
            <div>
                <h1>底盘循迹</h1>
                <p>机器人端任务控制</p>
            </div>
        </div>
        <nav class="top-actions" aria-label="页面导航">
            <span v-if="authenticated" class="user-badge">操作员：{{ userName }}</span>
            <button v-if="authenticated" type="button" @click="logout"><i class="fa fa-sign-out"></i> 退出</button>
            <a :href="vendorUiBaseUrl + '/irobot/irbt/agv'"><i class="fa fa-cogs"></i> 原移动底盘</a>
            <a :href="vendorUiBaseUrl + '/irobot/irbt/web2'"><i class="fa fa-home"></i> 管理首页</a>
        </nav>
    </header>

    <div v-if="!authenticated" class="auth-mask">
        <form class="auth-card" @submit.prevent="login">
            <h2>登录自有控制服务</h2>
            <p>动作任务和正式巡检控制需要登录并经过操作记录。</p>
            <div class="auth-field">
                <label for="gateway-username">用户名</label>
                <input id="gateway-username" v-model.trim="loginForm.username" autocomplete="username" required>
            </div>
            <div class="auth-field">
                <label for="gateway-password">密码</label>
                <input id="gateway-password" v-model="loginForm.password" type="password" autocomplete="current-password" required>
            </div>
            <div class="auth-error">{{ loginError }}</div>
            <button class="control-button btn-start" type="submit" :disabled="loginBusy">
                <i class="fa" :class="loginBusy ? 'fa-spinner fa-spin' : 'fa-sign-in'"></i>
                {{ loginBusy ? '登录中...' : '登录' }}
            </button>
        </form>
    </div>

    <main class="page">
        <div class="page-heading">
            <div>
                <h2>底盘循迹控制台</h2>
                <p>编排相对移动动作，或选择正式巡检任务执行既有路线。</p>
            </div>
            <div class="live-status">
                <span class="live-dot" :class="{offline: !online}"></span>
                <span>{{ online ? '状态连接正常' : '状态连接异常' }}</span>
                <span>{{ lastUpdateText }}</span>
            </div>
        </div>

        <div class="alert">
            <i class="fa fa-shield"></i>
            <div>现场操作前请确认路线和周围环境安全。相对移动使用商家软件坐标控制距离，不能替代 RFID 或其他绝对位置标记。</div>
        </div>

        <div class="layout">
            <section class="column">
                <div class="panel">
                    <div class="panel-header">
                        <h3>动作任务</h3>
                        <small>{{ motionStateLabel }}</small>
                    </div>
                    <div class="panel-body">
                        <form @submit.prevent="startMotionSequence">
                            <div class="sequence-list">
                                <template v-for="(task, index) in motionTasks" :key="task.id">
                                    <div class="sequence-task" :class="{active: isActiveMove(index)}">
                                        <div class="sequence-number">任务 {{ index + 1 }}<span>移动</span></div>
                                        <div class="motion-field">
                                            <label :for="'distance-' + task.id">移动距离（米）</label>
                                            <input :id="'distance-' + task.id" v-model.trim="task.distance" type="number" min="-100" max="100" step="0.01" inputmode="decimal" placeholder="1.20" :disabled="motionRunning">
                                        </div>
                                        <div class="motion-field">
                                            <label :for="'lift-height-' + task.id">升降高度（{{ liftRangeLabel }}，可选）</label>
                                            <input :id="'lift-height-' + task.id" v-model.trim="task.liftHeight" type="number" :min="liftStatus.min" :max="liftStatus.max" step="1" inputmode="numeric" placeholder="留空表示不升降" :disabled="motionRunning">
                                        </div>
                                        <div class="motion-summary">
                                            <span>方向</span>
                                            <strong><i class="fa" :class="taskDirectionIcon(task)" style="margin-right:7px"></i>{{ taskDirectionLabel(task) }}</strong>
                                        </div>
                                        <button class="icon-button" type="button" @click="removeMotionTask(index)" :disabled="motionRunning || motionTasks.length === 1" title="删除此任务" aria-label="删除此任务"><i class="fa fa-trash"></i></button>
                                    </div>
                                    <div v-if="taskHasLift(task)" class="sequence-connector" :class="{active: isActiveLift(index)}">
                                        <i class="fa fa-arrows-v"></i>
                                        <span>升降至 {{ task.liftHeight }}（原页面单位）</span>
                                    </div>
                                    <div v-if="index < motionTasks.length - 1" class="sequence-connector" :class="{active: isActiveWait(index)}">
                                        <i class="fa fa-clock-o"></i>
                                        <span>等待</span>
                                        <input v-model.trim="task.waitSeconds" type="number" min="0.1" max="3600" step="0.1" inputmode="decimal" :disabled="motionRunning" :aria-label="'任务 ' + (index + 1) + ' 后等待秒数'">
                                        <span>秒后继续</span>
                                    </div>
                                </template>
                            </div>
                            <div class="sequence-actions">
                                <button class="sequence-add" type="button" @click="addMotionTask" :disabled="motionRunning || motionTasks.length >= 20"><i class="fa fa-plus" style="margin-right:7px"></i>添加任务</button>
                                <button class="control-button btn-resume" type="submit" :disabled="!canStartSequence">
                                    <i class="fa" :class="motionSubmitting || motionRunning ? 'fa-spinner fa-spin' : 'fa-play'"></i>{{ motionRunning ? '执行中' : '执行全部任务' }}
                                </button>
                            </div>
                            <div v-if="sequenceValidationMessage" class="message error" style="margin-top:14px"><i class="fa fa-exclamation-circle"></i> {{ sequenceValidationMessage }}</div>
                        </form>

                        <div v-if="motionStatus.id" class="motion-progress"><span :style="{width: motionProgressPercent + '%'}"></span></div>
                        <div v-if="motionStatus.id" class="motion-meta">
                            <span>{{ motionStatus.message || motionStateLabel }}</span>
                            <span>动作 {{ motionStatus.step || 0 }}/{{ motionStatus.steps || 0 }} · 移动 {{ motionStatus.segment || 0 }}/{{ motionStatus.segments || 0 }} 段</span>
                        </div>
                        <div v-if="motionStatus.state === 'ERROR'" class="message error" style="margin-top:14px">
                            <i class="fa fa-exclamation-circle"></i> {{ motionStatus.reason || '动作任务失败' }}
                        </div>
                    </div>
                </div>

                <div class="panel">
                    <div class="panel-header">
                        <h3>正式巡检任务</h3>
                        <button class="top-actions" style="padding:0;border:0" type="button" @click="loadTasks" :disabled="loadingTasks" title="刷新任务列表">
                            <span style="color:var(--teal);font-size:13px"><i class="fa fa-refresh" :class="{ 'fa-spin': loadingTasks }"></i> 刷新</span>
                        </button>
                    </div>
                    <div class="panel-body">
                        <div v-if="tasks.length" class="task-list">
                            <button v-for="item in tasks" :key="item.taskId" type="button" class="task-row" :class="{selected: selectedTask && selectedTask.taskId === item.taskId, 'disabled-task': !isEnabledTask(item)}" @click="selectTask(item)">
                                <div class="task-title">
                                    <span>{{ item.name || ('任务 ' + item.taskId) }}</span>
                                    <span class="tag" :class="isEnabledTask(item) ? 'tag-on' : 'tag-off'">{{ isEnabledTask(item) ? '启用' : '停用' }}</span>
                                </div>
                                <div class="task-meta">
                                    <span>任务 ID：{{ item.taskId || '-' }}</span>
                                    <span>{{ routeCount(item.task) }} 个点位</span>
                                </div>
                            </button>
                        </div>
                        <div v-else class="empty">{{ loadingTasks ? '正在读取任务...' : '暂无可用的正式巡检任务' }}</div>
                    </div>
                </div>

                <div class="panel">
                    <div class="panel-header"><h3>操作记录</h3></div>
                    <div class="panel-body">
                        <ul v-if="logs.length" class="log">
                            <li v-for="(entry, index) in logs" :key="index">
                                <time>{{ entry.time }}</time>
                                <span>{{ entry.text }}</span>
                            </li>
                        </ul>
                        <div v-else class="empty" style="padding:8px 0">暂无操作记录</div>
                    </div>
                </div>
            </section>

            <section class="column">
                <div class="panel">
                    <div class="panel-header">
                        <h3>任务控制</h3>
                        <small>模式：正常</small>
                    </div>
                    <div class="panel-body">
                        <div class="selection-line">
                            <div>
                                <span>当前选择</span>
                                <br>
                                <strong>{{ selectedTask ? (selectedTask.name || selectedTask.taskId) : '未选择任务' }}</strong>
                            </div>
                            <span v-if="selectedTask">ID {{ selectedTask.taskId }}</span>
                        </div>

                        <div class="route-box">
                            <div class="route-label">路线序列</div>
                            <div class="route-value">{{ selectedTask ? selectedTask.task : '请选择一个启用的正式任务' }}</div>
                        </div>

                        <div class="controls">
                            <button class="control-button btn-start" type="button" @click="startTask" :disabled="!canStart || busy"><i class="fa fa-play-circle"></i>开始循迹</button>
                            <button class="control-button btn-pause" type="button" :disabled="true" title="等待底层协议确认"><i class="fa fa-pause-circle"></i>暂停（待接入）</button>
                            <button class="control-button btn-resume" type="button" :disabled="true" title="等待底层协议确认"><i class="fa fa-play-circle"></i>恢复（待接入）</button>
                            <button class="control-button btn-end" type="button" @click="endTask" :disabled="!canEnd || busy"><i class="fa fa-stop-circle"></i>结束任务</button>
                            <button class="control-button btn-clear" type="button" :disabled="true" title="第一阶段暂未接入"><i class="fa fa-wrench"></i>故障清除（待接入）</button>
                        </div>

                        <div class="status-strip" :class="statusClass">
                            <span class="state"><span class="state-mark"></span>{{ statusLabel }}</span>
                            <span class="status-time">{{ robotStatus.move || '等待状态' }}</span>
                        </div>

                        <div v-if="message" class="message" :class="{error: messageError}" style="margin-top:16px">
                            <i class="fa" :class="messageError ? 'fa-exclamation-circle' : 'fa-info-circle'"></i>
                            {{ message }}
                        </div>
                    </div>
                </div>

                <div class="panel">
                    <div class="panel-header">
                        <h3>机器人状态</h3>
                        <small>{{ robotStatus.robotId || '-' }}</small>
                    </div>
                    <div class="panel-body">
                        <div class="message" style="margin-bottom:14px">
                            <i class="fa fa-info-circle"></i>
                            这里显示商家软件坐标；相对移动会在执行前重新读取，不代表机器人在场地中的绝对位置。
                        </div>
                        <div class="metrics">
                            <div class="metric"><span class="metric-label">电量</span><span class="metric-value">{{ value(robotStatus.energy) }}<span class="metric-unit">%</span></span></div>
                            <div class="metric"><span class="metric-label">磁条位置</span><span class="metric-value">{{ value(robotStatus.posMag) }}</span></div>
                            <div class="metric"><span class="metric-label">当前路线点</span><span class="metric-value">{{ value(robotStatus.svCurP || robotStatus.point || robotStatus.pos) }}</span></div>
                            <div class="metric"><span class="metric-label">速度</span><span class="metric-value">{{ value(robotStatus.velocity) }}</span></div>
                        </div>
                        <div class="details" style="margin-top:14px">
                            <div class="detail"><span>软件 X</span><span>{{ value(positionStatus.posex) }}</span></div>
                            <div class="detail"><span>软件 Y</span><span>{{ value(positionStatus.posey) }}</span></div>
                            <div class="detail"><span>软件航向</span><span>{{ value(positionStatus.poseyaw) }}</span></div>
                            <div class="detail"><span>任务标志</span><span>{{ value(robotStatus.taskFlag) }}</span></div>
                            <div class="detail"><span>暂停标志</span><span>{{ value(robotStatus.taskStopFlag) }}</span></div>
                            <div class="detail"><span>目标路线点</span><span>{{ value(robotStatus.svGotoP) }}</span></div>
                            <div class="detail"><span>当前任务</span><span>{{ value(robotStatus.task) }}</span></div>
                            <div class="detail"><span>充电状态</span><span>{{ robotStatus.charge === '1' || robotStatus.charge === 1 ? '充电中' : '未充电' }}</span></div>
                            <div class="detail"><span>升降状态</span><span>{{ liftStatus.state === undefined || liftStatus.state === null ? value(robotStatus.lifting) : (Number(liftStatus.state) === 0 ? '停止' : '运行中') }}</span></div>
                            <div class="detail"><span>升降位置</span><span>{{ value(liftStatus.position) }}</span></div>
                        </div>
                    </div>
                </div>

                <div class="panel">
                    <div class="panel-header"><h3>故障信息</h3></div>
                    <div class="panel-body">
                        <div class="message" :class="{error: hasFault}">
                            <i class="fa" :class="hasFault ? 'fa-exclamation-triangle' : 'fa-check-circle'"></i>
                            {{ hasFault ? ('故障原因：' + (robotStatus.reason || robotStatus.move)) : '当前未读取到故障信息' }}
                        </div>
                    </div>
                </div>
            </section>
        </div>
    </main>
</div>
</template>

<style scoped>
/* 原页面字体图标来自本地 /vendor-assets/font-awesome.min.css（该项目未包含该资源），
   这里改为在组件内引入同一版本的 Font Awesome，保持图标名称与用法不变。 */
@import url("https://cdn.jsdelivr.net/npm/font-awesome@4.7.0/css/font-awesome.min.css");

.track-page {
    --ink: #17212b;
    --muted: #687581;
    --line: #dfe5e8;
    --paper: #f5f7f8;
    --panel: #ffffff;
    --navy: #123b52;
    --teal: #087f8c;
    --green: #16845b;
    --amber: #b36a00;
    --red: #bc3c3c;
    --shadow: 0 8px 24px rgba(20, 39, 51, 0.07);

    min-height: 100%;
    color: var(--ink);
    background: var(--paper);
    font-family: "Microsoft YaHei", "PingFang SC", Arial, sans-serif;
}

.track-page,
.track-page * { box-sizing: border-box; }

button, input, select { font: inherit; }

button { cursor: pointer; }

button:disabled {
    cursor: not-allowed;
    opacity: 0.45;
}

.topbar {
    background: var(--navy);
    color: #fff;
    min-height: 70px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 28px;
}

/* 未登录遮罩只覆盖右侧内容区，左侧按应用侧边栏宽度让开。
   原写法 inset:0 是相对视口定位的，会连左侧导航一起盖住，
   导致未登录时无法点击侧边栏切换到其他页面。
   left 的取值与应用外壳 .app-sidebar 的宽度保持一致（见 App.vue）。 */
.auth-mask {
    position: fixed;
    z-index: 20;
    top: 0;
    right: 0;
    bottom: 0;
    left: 248px;
    display: grid;
    place-items: center;
    padding: 20px;
    background: rgba(18, 59, 82, 0.7);
}

.auth-card {
    width: min(420px, 100%);
    padding: 28px;
    border-radius: 8px;
    background: var(--panel);
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.24);
}

.auth-card h2 { margin: 0 0 8px; color: var(--navy); }

.auth-card p { margin: 0 0 20px; color: var(--muted); font-size: 13px; }

.auth-field { margin-bottom: 14px; }

.auth-field label { display: block; margin-bottom: 6px; color: var(--muted); font-size: 13px; }

.auth-field input {
    width: 100%;
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 10px 11px;
}

.auth-error { color: var(--red); min-height: 20px; margin-bottom: 10px; font-size: 13px; }

.user-badge { color: #bcd0d8; align-self: center; font-size: 12px; }

.brand {
    display: flex;
    align-items: center;
    gap: 13px;
}

.brand-mark {
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    border: 1px solid rgba(255, 255, 255, 0.45);
    border-radius: 5px;
    color: #9de5df;
    font-size: 18px;
}

.brand h1 {
    font-size: 20px;
    font-weight: 600;
    margin: 0;
    letter-spacing: 0;
}

.brand p {
    color: #bcd0d8;
    font-size: 12px;
    margin: 4px 0 0;
}

.top-actions {
    display: flex;
    gap: 9px;
}

.top-actions a,
.top-actions button {
    color: #e8f2f4;
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 4px;
    padding: 8px 12px;
    text-decoration: none;
    font-size: 13px;
}

.top-actions a:hover,
.top-actions button:hover { background: rgba(255, 255, 255, 0.1); }

.page {
    max-width: 1440px;
    margin: 0 auto;
    padding: 24px 28px 36px;
}

.page-heading {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 20px;
}

.page-heading h2 {
    margin: 0;
    font-size: 25px;
    font-weight: 650;
}

.page-heading p {
    margin: 8px 0 0;
    color: var(--muted);
    font-size: 13px;
}

.live-status {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 13px;
    white-space: nowrap;
}

.live-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--green);
}

.live-dot.offline { background: var(--red); }

.alert {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 14px;
    margin-bottom: 20px;
    border: 1px solid #f0c9a6;
    border-left: 4px solid var(--amber);
    background: #fff8ef;
    color: #70420d;
    font-size: 13px;
    line-height: 1.55;
}

.layout {
    display: grid;
    grid-template-columns: minmax(295px, 0.86fr) minmax(0, 1.65fr);
    gap: 20px;
    align-items: start;
}

.column { min-width: 0; }

.panel {
    background: var(--panel);
    border: 1px solid var(--line);
    box-shadow: var(--shadow);
    border-radius: 6px;
    margin-bottom: 20px;
}

.panel-header {
    padding: 16px 18px;
    border-bottom: 1px solid var(--line);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
}

.panel-header h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 650;
}

.panel-header small { color: var(--muted); }

.panel-body { padding: 18px; }

.task-list {
    max-height: 390px;
    overflow: auto;
}

.task-row {
    display: block;
    width: 100%;
    text-align: left;
    background: #fff;
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 13px 14px;
    margin-bottom: 10px;
    color: var(--ink);
}

.task-row:last-child { margin-bottom: 0; }

.task-row:hover { border-color: #8bbac0; }

.task-row.selected {
    border-color: var(--teal);
    box-shadow: inset 3px 0 0 var(--teal);
    background: #f2fbfb;
}

.task-row.disabled-task { opacity: 0.58; }

.task-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-weight: 600;
    font-size: 14px;
}

.task-meta {
    color: var(--muted);
    display: flex;
    gap: 12px;
    margin-top: 7px;
    font-size: 12px;
}

.tag {
    border-radius: 3px;
    padding: 3px 7px;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
}

.tag-on { background: #e5f6ed; color: #167047; }
.tag-off { background: #eef1f2; color: #687581; }

.empty {
    padding: 30px 10px;
    color: var(--muted);
    text-align: center;
    font-size: 13px;
}

.selection-line {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: center;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--line);
}

.selection-line strong { font-size: 18px; }
.selection-line span { color: var(--muted); font-size: 12px; }

.route-box {
    margin: 16px 0 18px;
    padding: 12px;
    background: #f7f9fa;
    border: 1px solid var(--line);
    border-radius: 4px;
}

.route-label {
    color: var(--muted);
    font-size: 12px;
    margin-bottom: 7px;
}

.route-value {
    color: var(--ink);
    font-family: Consolas, "Courier New", monospace;
    font-size: 12px;
    line-height: 1.7;
    overflow-wrap: anywhere;
}

.controls {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
}

.control-button {
    min-height: 48px;
    border: 1px solid transparent;
    border-radius: 4px;
    color: #fff;
    font-size: 14px;
    font-weight: 600;
}

.control-button i { margin-right: 6px; }
.btn-start { background: var(--green); }
.btn-start:hover:not(:disabled) { background: #106b49; }
.btn-pause { background: var(--amber); }
.btn-pause:hover:not(:disabled) { background: #8c5200; }
.btn-resume { background: var(--teal); }
.btn-resume:hover:not(:disabled) { background: #066773; }
.btn-end { background: var(--red); }
.btn-end:hover:not(:disabled) { background: #963030; }
.btn-clear {
    color: #7b4a00;
    border-color: #d9b06d;
    background: #fff8eb;
}
.btn-clear:hover:not(:disabled) { background: #fff0d0; }

.motion-field label,
.motion-summary span {
    display: block;
    color: var(--muted);
    font-size: 12px;
    margin-bottom: 7px;
}

.motion-field input {
    width: 100%;
    height: 48px;
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0 12px;
    color: var(--ink);
    background: #fff;
    font-size: 18px;
}

.motion-field input:focus {
    outline: 2px solid rgba(8, 127, 140, 0.2);
    border-color: var(--teal);
}

.motion-summary strong {
    display: flex;
    align-items: center;
    min-height: 48px;
    font-size: 15px;
}

.sequence-list { border-top: 1px solid var(--line); }

.sequence-task {
    display: grid;
    grid-template-columns: 96px minmax(120px, 1fr) minmax(120px, 1fr) 40px;
    gap: 12px;
    align-items: end;
    padding: 15px 0 15px 12px;
    border-bottom: 1px solid var(--line);
}

.sequence-task.active {
    box-shadow: inset 3px 0 0 var(--teal);
}

.sequence-task .sequence-number { grid-column: 1; grid-row: 1 / 3; }
.sequence-task .icon-button { grid-column: 4; grid-row: 1; }
.sequence-task .motion-summary { grid-column: 2 / 4; grid-row: 2; }

.sequence-connector.active { color: var(--teal); font-weight: 600; }
.sequence-connector.active::before { background: var(--teal); }

.sequence-number {
    align-self: center;
    font-size: 14px;
    font-weight: 650;
}

.sequence-number span {
    display: block;
    margin-top: 4px;
    color: var(--muted);
    font-size: 11px;
    font-weight: 400;
}

.icon-button {
    width: 40px;
    height: 40px;
    border: 1px solid var(--line);
    border-radius: 4px;
    color: var(--red);
    background: #fff;
}

.icon-button:hover:not(:disabled) { background: #fff4f4; }

.sequence-connector {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 52px;
    margin-left: 42px;
    color: var(--muted);
    font-size: 13px;
}

.sequence-connector::before {
    content: '';
    width: 2px;
    height: 34px;
    background: var(--line);
}

.sequence-connector input {
    width: 90px;
    height: 36px;
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0 9px;
}

.sequence-actions {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-top: 16px;
}

.sequence-add {
    border: 1px solid var(--teal);
    border-radius: 4px;
    padding: 0 15px;
    color: var(--teal);
    background: #fff;
    font-weight: 600;
}

.sequence-add:hover:not(:disabled) { background: #f2fbfb; }
.sequence-actions .control-button { width: 190px; }

.motion-progress {
    height: 7px;
    margin-top: 14px;
    overflow: hidden;
    border-radius: 3px;
    background: #e8edef;
}

.motion-progress span {
    display: block;
    height: 100%;
    background: var(--teal);
    transition: width 0.2s ease;
}

.motion-meta {
    display: flex;
    justify-content: space-between;
    gap: 14px;
    margin-top: 9px;
    color: var(--muted);
    font-size: 12px;
}

.status-strip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 11px 12px;
    margin-top: 16px;
    background: #f7f9fa;
    border: 1px solid var(--line);
    border-radius: 4px;
    font-size: 13px;
}

.state {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-weight: 650;
}

.state-mark {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: #91a0a8;
}

.state-running .state-mark { background: var(--green); }
.state-paused .state-mark { background: var(--amber); }
.state-error .state-mark { background: var(--red); }
.state-finished .state-mark { background: var(--teal); }

.status-time { color: var(--muted); font-size: 12px; }

.metrics {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
}

.metric {
    min-width: 0;
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 12px;
    background: #fff;
}

.metric-label { color: var(--muted); font-size: 12px; }
.metric-value {
    display: block;
    margin-top: 8px;
    font-size: 19px;
    font-weight: 650;
    overflow-wrap: anywhere;
}

.metric-unit { color: var(--muted); font-size: 11px; margin-left: 3px; }

.details {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0 18px;
}

.detail {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    border-bottom: 1px solid #edf0f1;
    padding: 11px 0;
    font-size: 13px;
}

.detail span:first-child { color: var(--muted); }
.detail span:last-child { text-align: right; overflow-wrap: anywhere; }

.message {
    border-left: 3px solid var(--teal);
    background: #f2fbfb;
    color: #245761;
    padding: 11px 12px;
    font-size: 13px;
    line-height: 1.55;
}

.message.error {
    border-left-color: var(--red);
    background: #fff4f4;
    color: #7f2f2f;
}

.log {
    max-height: 215px;
    overflow: auto;
    margin: 0;
    padding: 0;
    list-style: none;
}

.log li {
    display: grid;
    grid-template-columns: 72px 1fr;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid #edf0f1;
    font-size: 12px;
    line-height: 1.45;
}

.log time { color: var(--muted); }

@media (max-width: 920px) {
    .layout { grid-template-columns: 1fr; }
    .task-list { max-height: none; }
}

@media (max-width: 900px) {
    /* 侧边栏在此断点折叠成图标栏，宽度 76px（见 App.vue） */
    .auth-mask { left: 76px; }
}

@media (max-width: 620px) {
    .topbar { padding: 0 16px; }
    .top-actions a:first-child { display: none; }
    .page { padding: 18px 14px 28px; }
    .page-heading { align-items: flex-start; flex-direction: column; gap: 10px; }
    .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .details { grid-template-columns: 1fr; }
    .controls { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .sequence-task { grid-template-columns: 78px minmax(0, 1fr) 40px; }
    .sequence-task .sequence-number { grid-column: 1; grid-row: 1; }
    .sequence-task .motion-field { grid-column: 2; grid-row: 1; }
    .sequence-task .icon-button { grid-column: 3; grid-row: 1; }
    .sequence-task .motion-field:nth-child(3) { grid-column: 2; grid-row: 2; }
    .sequence-task .motion-summary { grid-column: 2 / 4; grid-row: 3; }
    .sequence-actions { align-items: stretch; flex-direction: column; }
    .sequence-actions .control-button, .sequence-add { width: 100%; min-height: 44px; }
    .panel-body { padding: 14px; }
}
</style>
