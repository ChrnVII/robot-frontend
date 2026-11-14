<script setup>
// 云端接入：cloud-agent 的全部人工操作都收敛在这一页。
//
// 这个页面不是"只读监控"：改云端地址、共享目录、并发数，发起/取消注册，
// 手工填 token、切换/删除凭据、取消上传、重启进程，全部在这里完成。
// 数据来源是 backend 的 /api/v1/cloud-link/*，最终转发到 cloud-agent 的 UDS。
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  Download, Link, Refresh, VideoPause, VideoPlay
} from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import {
  activateCloudCredential, cancelCloudEnroll, cancelCloudUpload, deleteCloudCredential,
  getCloudLogs, getCloudStatus, pauseCloud, putCloudCredential, reconnectCloud,
  reloadCloudConfig, restartCloudAgent, resumeCloud, rotateCloudToken, startCloudEnroll,
  updateCloudConfig
} from '@/api/cloudLink'
import { unwrap } from '@/api/envelope'
import { getErrorMessage } from '@/utils/request'
import { formatTime } from '@/utils/format'

const STATE_META = {
  starting: { label: '启动中', type: 'info' },
  unregistered: { label: '未注册', type: 'info' },
  enrolling: { label: '提交注册', type: 'warning' },
  pending: { label: '待批准', type: 'warning' },
  connecting: { label: '连接中', type: 'warning' },
  online: { label: '在线', type: 'success' },
  offline: { label: '离线', type: 'warning' },
  unauthorized: { label: '凭据被拒', type: 'danger' },
  paused: { label: '已暂停', type: 'info' },
  error: { label: '异常', type: 'danger' },
  stopped: { label: '已停止', type: 'info' }
}

const status = ref(null)
const error = ref('')
const busy = ref('')
const refreshing = ref(false)
const logs = ref([])
const lastSeq = ref(0)
const logsPaused = ref(false)
const autoScroll = ref(true)
const levelFilter = ref('DEBUG')
const logBox = ref(null)

const configForm = reactive({})
const configSnapshot = ref({})

const credentialDialog = reactive({ visible: false, form: emptyCredential() })
const enrollDialog = reactive({ visible: false, form: { server: '', name: '', root: '' } })
const rotateBusy = ref(false)

let statusTimer = null
let logTimer = null

const stateMeta = computed(() => STATE_META[status.value?.state] || { label: status.value?.state || '未知', type: 'info' })
const agentDown = computed(() => !status.value)
const config = computed(() => status.value?.config || {})
const slots = computed(() => status.value?.credentials?.slots || [])
const uploads = computed(() => status.value?.uploads || { active: 0, jobs: [], recent: [] })
const pending = computed(() => status.value?.pending)
const configDirty = computed(() => JSON.stringify({ ...configForm }) !== JSON.stringify(configSnapshot.value))

const LEVEL_RANK = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40 }
const visibleLogs = computed(() => {
  const min = LEVEL_RANK[levelFilter.value] || 0
  return logs.value.filter((item) => (LEVEL_RANK[item.level] || 0) >= min)
})

function emptyCredential() {
  return { server: '', token: '', agentId: '', root: '', name: '' }
}

function syncConfigForm(data) {
  const source = data?.config || {}
  const next = {
    server: source.server || '',
    root: source.root || '',
    name: source.name || '',
    heartbeatInterval: source.heartbeatInterval ?? 15,
    maxConcurrentUploads: source.maxConcurrentUploads ?? 3,
    verifyTls: source.verifyTls !== false,
    logLevel: source.logLevel || 'INFO'
  }
  Object.keys(configForm).forEach((key) => { delete configForm[key] })
  Object.assign(configForm, next)
  configSnapshot.value = { ...next }
}

async function refreshStatus({ silent = false } = {}) {
  if (!silent) refreshing.value = true
  try {
    const data = unwrap(await getCloudStatus(), {})
    status.value = data
    error.value = ''
    if (!configDirty.value) syncConfigForm(data)
  } catch (exception) {
    status.value = null
    error.value = getErrorMessage(exception, '读取云端接入状态失败')
  } finally {
    refreshing.value = false
  }
}

async function refreshLogs() {
  if (logsPaused.value || !status.value) return
  try {
    const data = unwrap(await getCloudLogs({ since: lastSeq.value, limit: 200 }), {})
    const items = data.items || []
    if (items.length) {
      logs.value = logs.value.concat(items).slice(-500)
      lastSeq.value = data.lastSeq || items[items.length - 1].seq
      await nextTick()
      if (autoScroll.value && logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
    }
  } catch {
    /* 日志拉取失败不打断页面：状态区已经会显示不可用原因 */
  }
}

async function action(name, task, successText) {
  if (busy.value) return
  busy.value = name
  try {
    await task()
    if (successText) ElMessage.success(successText)
    await refreshStatus({ silent: true })
    await nextTick()
    if (logBox.value && autoScroll.value) logBox.value.scrollTop = logBox.value.scrollHeight
  } catch (exception) {
    ElMessage.error(getErrorMessage(exception))
  } finally {
    busy.value = ''
  }
}

function saveConfig() {
  action('save', () => updateCloudConfig({ ...configForm }), '配置已写入并应用')
}

function reloadConfig() {
  action('reload', () => reloadCloudConfig(), '已重新读取配置文件')
}

function reconnect() {
  action('reconnect', () => reconnectCloud(), '已请求重新连接')
}

function togglePause() {
  const paused = status.value?.paused
  action('pause', () => (paused ? resumeCloud() : pauseCloud()), paused ? '已恢复接入' : '已暂停接入')
}

function enrollNow() {
  enrollDialog.form = {
    server: configForm.server || '',
    name: configForm.name || '',
    root: configForm.root || ''
  }
  enrollDialog.visible = true
}

function submitEnroll() {
  const task = action('enroll', () => startCloudEnroll({ ...enrollDialog.form }), '注册申请已提交')
  enrollDialog.visible = false
  return task
}

function cancelEnroll() {
  action('cancel-enroll', () => cancelCloudEnroll(), '已取消等待批准')
}

async function rotateToken() {
  try {
    await ElMessageBox.confirm(
      '轮换会用旧 token 向云端换一把新的。如果云端已经吊销这台设备，轮换会失败，需要重新注册或手工填凭据。',
      '轮换 token',
      { type: 'warning', confirmButtonText: '开始轮换', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  rotateBusy.value = true
  try {
    const data = unwrap(await rotateCloudToken(), {})
    if (data.ok) ElMessage.success('token 已轮换')
    else ElMessage.error(`${data.message || '轮换失败'}${data.code ? `（${data.code}）` : ''}`)
    await refreshStatus({ silent: true })
  } catch (exception) {
    ElMessage.error(getErrorMessage(exception))
  } finally {
    rotateBusy.value = false
  }
}

function openCredentialDialog() {
  credentialDialog.form = { ...emptyCredential(), root: configForm.root, name: configForm.name }
  credentialDialog.visible = true
}

function submitCredential() {
  const form = credentialDialog.form
  if (!form.server.trim() || !form.token.trim()) {
    ElMessage.warning('云端地址与 token 都必须填写')
    return
  }
  const task = action('credential', () => putCloudCredential({ ...form }), '凭据已保存并切换')
  credentialDialog.visible = false
  return task
}

function activateSlot(slot) {
  action('activate', () => activateCloudCredential(slot.server), `已切换到 ${slot.server}`)
}

async function removeSlot(slot) {
  try {
    await ElMessageBox.confirm(
      `删除 ${slot.server} 的本地凭据后，这台设备需要重新注册或重新填写 token 才能再接入。`,
      '删除凭据',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  action('forget', () => deleteCloudCredential(slot.server), '凭据已删除')
}

async function clearAllCredentials() {
  try {
    await ElMessageBox.confirm(
      '会删除本机记住的所有云端凭据。这个操作等价于原来的 rm -rf .robot-monitor/agents，删除后需要重新注册。',
      '清空全部凭据',
      { type: 'error', confirmButtonText: '全部删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  action('clear', () => deleteCloudCredential(), '已清空全部凭据')
}

function cancelUpload(job) {
  action('cancel-upload', () => cancelCloudUpload(job.uploadId), '已取消上传，云端会收到一条失败通知')
}

async function restartProcess() {
  try {
    await ElMessageBox.confirm(
      '会重新 exec cloud-agent 进程：连接会短暂中断，正在上传的分片会被取消。',
      '重启进程',
      { type: 'warning', confirmButtonText: '重启', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  action('restart', () => restartCloudAgent(), '进程正在重启，几秒后自动刷新')
  setTimeout(() => refreshStatus({ silent: true }), 3000)
}

function downloadLogs() {
  const text = visibleLogs.value
    .map((item) => `${new Date(item.ts * 1000).toISOString()} ${item.level} ${item.logger}: ${item.message}`)
    .join('\n')
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `cloud-agent-${new Date().toISOString().slice(0, 19).replaceAll(':', '')}.log`
  anchor.click()
  URL.revokeObjectURL(url)
}

function stamp(value) {
  return value ? formatTime(value * 1000) : '—'
}

function sizeText(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}

watch(autoScroll, async (value) => {
  if (value) {
    await nextTick()
    if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
  }
})

onMounted(async () => {
  syncConfigForm(null)
  await refreshStatus({ silent: true })
  await refreshLogs()
  statusTimer = setInterval(() => refreshStatus({ silent: true }), 3000)
  logTimer = setInterval(refreshLogs, 2000)
})

onBeforeUnmount(() => {
  clearInterval(statusTimer)
  clearInterval(logTimer)
})
</script>

<template>
  <div class="view">
    <PageHeader
      title="云端接入"
      description="cloud-agent 是独立进程：只出站取件，本地页面经 backend 的 UDS 控制面操作它"
      :status-text="agentDown ? '未运行' : stateMeta.label"
      :status-type="agentDown ? 'danger' : stateMeta.type"
    >
      <template #extra>
        <el-button :icon="Refresh" :loading="refreshing" @click="refreshStatus({ silent: false })">
          刷新
        </el-button>
        <el-button
          :icon="status?.paused ? VideoPlay : VideoPause"
          :disabled="agentDown || busy !== ''"
          @click="togglePause"
        >
          {{ status?.paused ? '恢复接入' : '暂停接入' }}
        </el-button>
        <el-button :icon="Link" :disabled="agentDown || busy !== ''" @click="reconnect">重新连接</el-button>
        <el-button type="danger" plain :disabled="agentDown || busy !== ''" @click="restartProcess">
          重启进程
        </el-button>
      </template>
    </PageHeader>

    <el-alert
      v-if="agentDown"
      type="error"
      show-icon
      :closable="false"
      title="cloud-agent 没有运行"
    >
      <p class="alert-line">页面控制依赖它的本地控制面，进程不在时无法从页面启动或操作它。</p>
      <p class="alert-line alert-line--code">sudo systemctl start robot-cloud-agent</p>
      <p class="alert-line">启动后这一页会在 3 秒内自动恢复。错误信息：{{ error || '控制面不可达' }}</p>
    </el-alert>

    <el-alert
      v-else-if="status?.lastError"
      :type="status.lastError.code === 'unauthorized' ? 'error' : 'warning'"
      show-icon
      :closable="false"
      :title="`${status.lastError.code}：${status.lastError.message}`"
    >
      <p class="alert-line">发生时间：{{ stamp(status.lastError.at) }}</p>
    </el-alert>

    <el-alert
      v-if="!agentDown && pending"
      type="warning"
      show-icon
      :closable="false"
      title="注册申请正在等待云端批准"
    >
      <p class="alert-line">pending_id：<code>{{ pending.id }}</code></p>
      <p class="alert-line">{{ pending.hint || '到云端的「节点」页点批准，或使用服务端命令 approve。' }}</p>
      <el-button size="small" :loading="busy === 'cancel-enroll'" @click="cancelEnroll">取消等待</el-button>
    </el-alert>

    <section class="view-panel">
      <div class="view-panel__head">
        <h2>连接状态</h2>
        <small>数据每 3 秒刷新一次；暂停后进程仍在，只是不再接任务与重连</small>
      </div>
      <el-skeleton v-if="agentDown" :rows="2" animated />
      <div v-else class="facts">
        <div class="fact"><span>状态</span><el-tag :type="stateMeta.type" effect="light">{{ stateMeta.label }}</el-tag></div>
        <div class="fact"><span>云端地址</span><strong>{{ status.server || '未配置' }}</strong></div>
        <div class="fact"><span>agent_id</span><strong>{{ status.agentId || '未注册' }}</strong></div>
        <div class="fact"><span>主机名</span><strong>{{ status.hostname || '—' }}</strong></div>
        <div class="fact"><span>共享目录</span><strong class="mono">{{ status.root || '未配置' }}</strong></div>
        <div class="fact"><span>连接建立</span><strong>{{ stamp(status.connectedAt) }}</strong></div>
        <div class="fact"><span>最后心跳</span><strong>{{ stamp(status.lastHeartbeatAt) }}</strong></div>
        <div class="fact"><span>版本 / 协议</span><strong>{{ status.version }} / v{{ status.protocol }}</strong></div>
        <div class="fact"><span>进程启动</span><strong>{{ stamp(status.startedAt) }}</strong></div>
        <div class="fact"><span>活动上传</span><strong>{{ uploads.active }}</strong></div>
      </div>
    </section>

    <section class="view-panel">
      <div class="view-panel__head">
        <h2>接入配置</h2>
        <small>保存后由 cloud-agent 写回 TOML 并热应用；换云端会清掉旧 token</small>
      </div>
      <el-form :model="configForm" label-width="140px" class="config-form" :disabled="agentDown">
        <el-row :gutter="18">
          <el-col :xs="24" :md="12">
            <el-form-item label="云端地址">
              <el-input v-model="configForm.server" placeholder="https://files.example.com" clearable />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="12">
            <el-form-item label="共享目录">
              <el-input v-model="configForm.root" placeholder="/srv/share 或 /" clearable />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="12">
            <el-form-item label="设备名称">
              <el-input v-model="configForm.name" placeholder="默认使用 hostname" clearable />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="12">
            <el-form-item label="并发分片数">
              <el-input-number v-model="configForm.maxConcurrentUploads" :min="1" :max="32" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="12">
            <el-form-item label="心跳间隔（秒）">
              <el-input-number v-model="configForm.heartbeatInterval" :min="1" :max="3600" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="12">
            <el-form-item label="校验 TLS 证书">
              <el-switch v-model="configForm.verifyTls" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="12">
            <el-form-item label="日志级别">
              <el-select v-model="configForm.logLevel" class="wide">
                <el-option v-for="level in ['DEBUG', 'INFO', 'WARNING', 'ERROR']" :key="level" :label="level" :value="level" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="12">
            <el-form-item label="本地平台地址">
              <el-input v-model="configForm.backendBase" placeholder="http://127.0.0.1:8100" clearable />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="12">
            <el-form-item label="摄像头编号">
              <el-input v-model="configForm.cameraId" placeholder="ptz" clearable />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="12">
            <el-form-item label="允许远程画面">
              <el-switch v-model="configForm.mediaEnabled" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="12">
            <el-form-item label="媒体上游上限">
              <el-input-number v-model="configForm.mediaMaxSessions" :min="1" :max="8" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="12">
            <el-form-item label="配置文件">
              <span class="mono muted">{{ config.configPath || '—' }}</span>
            </el-form-item>
          </el-col>
        </el-row>
        <div class="actions">
          <el-button type="primary" :disabled="!configDirty || agentDown || busy !== ''" :loading="busy === 'save'" @click="saveConfig">
            保存并应用
          </el-button>
          <el-button :disabled="agentDown || busy !== ''" :loading="busy === 'reload'" @click="reloadConfig">
            重新读取文件
          </el-button>
          <el-button :disabled="!configDirty" @click="syncConfigForm(status)">撤销修改</el-button>
          <span class="muted">凭据目录：<code>{{ config.stateDir || '—' }}</code></span>
        </div>
      </el-form>
    </section>

    <section class="view-panel">
      <div class="view-panel__head">
        <h2>凭据与注册</h2>
        <small>一个云端一个槽；切换不会重新注册，删除后需要重新注册或填 token</small>
      </div>
      <div class="actions actions--top">
        <el-button type="primary" :disabled="agentDown || busy !== ''" @click="enrollNow">立即注册</el-button>
        <el-button :disabled="agentDown || busy !== ''" :loading="rotateBusy" @click="rotateToken">轮换 token</el-button>
        <el-button :disabled="agentDown || busy !== ''" @click="openCredentialDialog">手工填凭据</el-button>
        <el-button type="danger" plain :disabled="agentDown || busy !== '' || !slots.length" @click="clearAllCredentials">
          清空全部凭据
        </el-button>
      </div>

      <el-table :data="slots" size="small" empty-text="本地还没有任何云端凭据">
        <el-table-column prop="server" label="云端地址" min-width="220" show-overflow-tooltip />
        <el-table-column prop="agentId" label="agent_id" min-width="140" show-overflow-tooltip />
        <el-table-column prop="root" label="注册时目录" min-width="180" show-overflow-tooltip />
        <el-table-column label="当前" width="80">
          <template #default="{ row }">
            <el-tag v-if="row.active" type="success" size="small">使用中</el-tag>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" :disabled="row.active || busy !== ''" @click="activateSlot(row)">切换</el-button>
            <el-button link type="danger" :disabled="busy !== ''" @click="removeSlot(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section class="view-panel">
      <div class="view-panel__head">
        <h2>上传</h2>
        <small>进度是本机视角；云端仍是进度的唯一真相</small>
      </div>
      <el-table :data="uploads.jobs" size="small" empty-text="当前没有上传任务">
        <el-table-column prop="rel" label="文件" min-width="220" show-overflow-tooltip />
        <el-table-column label="大小" width="110">
          <template #default="{ row }">{{ sizeText(row.totalSize) }}</template>
        </el-table-column>
        <el-table-column label="进度" min-width="180">
          <template #default="{ row }">
            <el-progress :percentage="row.percent || 0" :stroke-width="8" />
          </template>
        </el-table-column>
        <el-table-column prop="state" label="状态" width="100" />
        <el-table-column label="操作" width="90">
          <template #default="{ row }">
            <el-button link type="danger" :disabled="busy !== ''" @click="cancelUpload(row)">取消</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-collapse v-if="uploads.recent.length" class="recent">
        <el-collapse-item :title="`最近完成 / 失败（${uploads.recent.length}）`" name="recent">
          <el-table :data="uploads.recent" size="small">
            <el-table-column prop="rel" label="文件" min-width="220" show-overflow-tooltip />
            <el-table-column prop="state" label="结果" width="100" />
            <el-table-column label="时间" width="170">
              <template #default="{ row }">{{ stamp(row.finishedAt) }}</template>
            </el-table-column>
            <el-table-column prop="error" label="失败原因" min-width="200" show-overflow-tooltip />
          </el-table>
        </el-collapse-item>
      </el-collapse>
    </section>

    <section class="view-panel">
      <div class="view-panel__head">
        <h2>运行日志</h2>
        <small>进程内环形缓冲，最近 500 行；暂停只停刷新，不影响进程</small>
      </div>
      <div class="actions actions--top">
        <el-select v-model="levelFilter" class="level-select" size="small">
          <el-option v-for="level in ['DEBUG', 'INFO', 'WARNING', 'ERROR']" :key="level" :label="`${level} 及以上`" :value="level" />
        </el-select>
        <el-checkbox v-model="autoScroll">自动滚动</el-checkbox>
        <el-checkbox v-model="logsPaused">暂停刷新</el-checkbox>
        <el-button size="small" :icon="Download" @click="downloadLogs">下载</el-button>
        <el-button size="small" @click="logs = []">清屏</el-button>
      </div>
      <div ref="logBox" class="logbox">
        <p v-if="!visibleLogs.length" class="muted">暂无日志</p>
        <p v-for="item in visibleLogs" :key="item.seq" class="logline" :class="`logline--${item.level.toLowerCase()}`">
          <span class="logtime">{{ stamp(item.ts) }}</span>
          <span class="loglevel">{{ item.level }}</span>
          <span class="logmessage">{{ item.message }}</span>
        </p>
      </div>
    </section>

    <el-dialog v-model="credentialDialog.visible" title="手工填写凭据" width="560px">
      <p class="muted dialog-hint">
        对应云端 <code>robot-monitor-server issue-token</code> 的输出。token 只保存到本机凭据槽（0600），不会写进配置文件。
      </p>
      <el-form :model="credentialDialog.form" label-width="110px">
        <el-form-item label="云端地址" required>
          <el-input v-model="credentialDialog.form.server" placeholder="https://files.example.com" />
        </el-form-item>
        <el-form-item label="token" required>
          <el-input v-model="credentialDialog.form.token" type="password" show-password autocomplete="new-password" />
        </el-form-item>
        <el-form-item label="agent_id">
          <el-input v-model="credentialDialog.form.agentId" placeholder="issue-token 输出的 agent_id（轮换时需要）" />
        </el-form-item>
        <el-form-item label="共享目录">
          <el-input v-model="credentialDialog.form.root" placeholder="留空沿用当前配置" />
        </el-form-item>
        <el-form-item label="设备名称">
          <el-input v-model="credentialDialog.form.name" placeholder="留空沿用当前配置" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="credentialDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="busy === 'credential'" @click="submitCredential">保存并切换</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="enrollDialog.visible" title="发起设备注册" width="520px">
      <p class="muted dialog-hint">云端默认要求人工批准。提交后这一页会显示 pending_id，批准后自动转为在线。</p>
      <el-form :model="enrollDialog.form" label-width="110px">
        <el-form-item label="云端地址" required>
          <el-input v-model="enrollDialog.form.server" placeholder="https://files.example.com" />
        </el-form-item>
        <el-form-item label="共享目录" required>
          <el-input v-model="enrollDialog.form.root" placeholder="任意绝对路径，只读" />
        </el-form-item>
        <el-form-item label="设备名称">
          <el-input v-model="enrollDialog.form.name" placeholder="默认使用 hostname" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="enrollDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="busy === 'enroll'" @click="submitEnroll">提交注册</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.alert-line {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.6;
}

.alert-line--code {
  font-family: var(--app-font-mono);
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--app-surface-3);
}

.facts {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: var(--app-gap-inner);
}

.fact {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: var(--app-surface-2);
  min-width: 0;
}

.fact span {
  font-size: 11px;
  color: var(--app-text-muted);
}

.fact strong {
  font-size: 13px;
  color: var(--app-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.config-form {
  max-width: 980px;
}

.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.actions--top {
  margin-bottom: var(--app-gap-inner);
}

.wide {
  width: 100%;
}

.level-select {
  width: 150px;
}

.recent {
  margin-top: var(--app-gap-inner);
  border-top: 1px solid var(--app-border);
}

.logbox {
  height: 280px;
  overflow: auto;
  padding: 10px 12px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: var(--app-surface-2);
  font-family: var(--app-font-mono);
  font-size: 12px;
  line-height: 1.7;
}

.logline {
  display: flex;
  gap: 10px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.logtime {
  color: var(--app-text-muted);
  flex: 0 0 auto;
}

.loglevel {
  flex: 0 0 62px;
  font-weight: 600;
}

.logmessage {
  flex: 1;
  min-width: 0;
}

.logline--warning .loglevel { color: var(--app-warning); }
.logline--error .loglevel,
.logline--critical .loglevel { color: var(--app-danger); }
.logline--debug .loglevel { color: var(--app-text-muted); }

.mono {
  font-family: var(--app-font-mono);
}

.muted {
  color: var(--app-text-muted);
  font-size: 12px;
}

.dialog-hint {
  margin: 0 0 12px;
  line-height: 1.6;
}
</style>
