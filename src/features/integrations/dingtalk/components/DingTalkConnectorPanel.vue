<script setup lang="ts">
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  AlertTriangle,
  CirclePause,
  MessageCircle,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Tag,
  Trash2,
} from '@lucide/vue'
import { onBeforeUnmount, onMounted, ref } from 'vue'

import { createDingTalkService } from '@/app/composition/dingTalkServiceFactory'
import type { ImConnector, ImRuntimeStatus } from '@/models/inbox/im'
import type { DingTalkService } from '@/services/inbox/DingTalkService'
import { NButton, NInput, NModal } from '@/ui'
import { useMessage } from '@/ui/services'

const native = Reflect.has(globalThis, '__TAURI_INTERNALS__')
const notify = useMessage()
const connectors = ref<ImConnector[]>([])
const loading = ref(false)
const saving = ref(false)
const operatingId = ref('')
const error = ref('')
const showCreate = ref(false)
const form = ref(defaultForm())
let servicePromise: Promise<DingTalkService> | null = null
let refreshTimer: ReturnType<typeof globalThis.setInterval> | null = null
let unlisten: UnlistenFn | null = null

const service = () => (servicePromise ??= createDingTalkService())

async function load(showLoading = true): Promise<void> {
  if (!native) return
  if (showLoading) loading.value = true
  const result = await (await service()).listConnectors()
  if (showLoading) loading.value = false
  if (!result.ok) return void (error.value = result.error.message)
  connectors.value = result.value
}

async function connect(): Promise<void> {
  saving.value = true
  error.value = ''
  try {
    const result = await (await service()).createConnector({ ...form.value })
    if (!result.ok) return void (error.value = result.error.message)
    showCreate.value = false
    form.value = defaultForm()
    notify.success('钉钉 Stream 已启动')
    await load(false)
  } finally {
    saving.value = false
  }
}

async function toggle(connector: ImConnector): Promise<void> {
  operatingId.value = connector.id
  error.value = ''
  try {
    const result = connector.enabled
      ? await (await service()).stopConnector(connector)
      : await (await service()).startConnector(connector)
    if (!result.ok) return void (error.value = result.error.message)
    notify.success(connector.enabled ? '钉钉连接已暂停' : '钉钉连接正在启动')
    await load(false)
  } finally {
    operatingId.value = ''
  }
}

async function retry(connector: ImConnector): Promise<void> {
  operatingId.value = connector.id
  error.value = ''
  try {
    if (connector.enabled) await (await service()).stopConnector(connector)
    const result = await (await service()).startConnector({ ...connector, enabled: false })
    if (!result.ok) return void (error.value = result.error.message)
    notify.success('正在重新连接钉钉')
    await load(false)
  } finally {
    operatingId.value = ''
  }
}

async function remove(connector: ImConnector): Promise<void> {
  if (!globalThis.confirm(`删除钉钉连接“${connector.displayName}”？本地收到的会话和消息也会删除。`))
    return
  const result = await (await service()).deleteConnector(connector)
  if (!result.ok) return void (error.value = result.error.message)
  connectors.value = connectors.value.filter((candidate) => candidate.id !== connector.id)
  notify.success('钉钉连接已删除')
}

async function editCategory(connector: ImConnector): Promise<void> {
  const category = globalThis.prompt('设置钉钉来源分类', connector.sourceCategory)
  if (category == null || category.trim() === connector.sourceCategory) return
  const result = await (await service()).updateCategory(connector.id, category)
  if (!result.ok) return void (error.value = result.error.message)
  connectors.value = connectors.value.map((candidate) =>
    candidate.id === connector.id ? result.value : candidate,
  )
  notify.success('钉钉来源分类已更新')
}

function defaultForm() {
  return {
    displayName: '',
    sourceCategory: '工作消息',
    clientId: '',
    clientSecret: '',
  }
}

function statusLabel(status: ImRuntimeStatus): string {
  return (
    {
      stopped: '已暂停',
      connecting: '连接中',
      online: '在线接收',
      reconnecting: '正在重连',
      auth_error: '凭据错误',
      error: '连接异常',
    } satisfies Record<ImRuntimeStatus, string>
  )[status]
}

onMounted(async () => {
  await load()
  if (!native) return
  unlisten = await listen('dingtalk-message-received', () => void load(false))
  refreshTimer = globalThis.setInterval(() => void load(false), 5_000)
})

onBeforeUnmount(() => {
  if (refreshTimer) globalThis.clearInterval(refreshTimer)
  unlisten?.()
})
</script>

<template>
  <section class="email-account-panel dingtalk-connector-panel" aria-label="钉钉连接器">
    <header>
      <div>
        <strong>钉钉消息连接器</strong>
        <small>企业内部应用 · Stream 模式 · 只读收件</small>
      </div>
      <NButton type="primary" size="small" :disabled="!native" @click="showCreate = true">
        <template #icon><Plus :size="15" /></template>连接钉钉
      </NButton>
    </header>

    <div v-if="!native" class="email-account-panel__notice">
      <AlertTriangle :size="16" />钉钉 Stream 需要在 Tauri 桌面应用中运行。
    </div>
    <div v-if="error" class="email-account-panel__notice email-account-panel__notice--error">
      <AlertTriangle :size="16" />{{ error }}
    </div>

    <div v-if="loading" class="email-account-panel__empty">正在读取钉钉连接…</div>
    <div v-else-if="connectors.length" class="email-account-list">
      <article v-for="connector in connectors" :key="connector.id">
        <span class="email-account-list__icon"><MessageCircle :size="19" /></span>
        <div class="email-account-list__main">
          <strong>{{ connector.displayName }}</strong>
          <small>钉钉 · {{ connector.sourceCategory }} · {{ connector.clientId }}</small>
          <em v-if="connector.lastError">{{ connector.lastError }}</em>
          <span :data-runtime-status="connector.runtimeStatus">
            {{ statusLabel(connector.runtimeStatus) }}
            <template v-if="connector.lastConnectedAt">
              · 上次连接 {{ new Date(connector.lastConnectedAt).toLocaleString() }}
            </template>
          </span>
          <span v-if="connector.lastEventAt">
            最近消息 {{ new Date(connector.lastEventAt).toLocaleString() }}
          </span>
        </div>
        <div class="email-account-list__actions">
          <NButton quaternary circle aria-label="修改来源分类" @click="editCategory(connector)">
            <template #icon><Tag :size="15" /></template>
          </NButton>
          <NButton
            v-if="connector.runtimeStatus === 'auth_error' || connector.runtimeStatus === 'error'"
            quaternary
            circle
            aria-label="重试连接"
            :loading="operatingId === connector.id"
            @click="retry(connector)"
          >
            <template #icon><RefreshCw :size="15" /></template>
          </NButton>
          <NButton
            v-else
            quaternary
            circle
            :aria-label="connector.enabled ? '暂停连接' : '启动连接'"
            :loading="operatingId === connector.id"
            @click="toggle(connector)"
          >
            <template #icon
              ><CirclePause v-if="connector.enabled" :size="15" /><Play v-else :size="15"
            /></template>
          </NButton>
          <NButton quaternary circle aria-label="删除钉钉连接" @click="remove(connector)">
            <template #icon><Trash2 :size="15" /></template>
          </NButton>
        </div>
      </article>
    </div>
    <div v-else class="email-account-panel__empty">
      <MessageCircle :size="27" /><strong>还没有钉钉连接</strong>
      <span>创建企业内部机器人后，单聊和群内 @机器人消息会实时进入收件箱。</span>
    </div>

    <aside class="email-account-panel__security">
      <ShieldCheck :size="16" />
      <p>
        <strong>接收边界：</strong>当前只读接收发给机器人的单聊，以及群聊中明确 @机器人的消息；
        不读取完整群历史、不自动回复。应用关闭期间钉钉机器人消息不会可靠补发。
      </p>
    </aside>

    <NModal
      v-model:show="showCreate"
      preset="card"
      title="连接钉钉 Stream"
      class="email-account-modal"
      :bordered="false"
    >
      <div class="email-account-form">
        <label
          ><span>连接名称</span
          ><NInput v-model:value="form.displayName" placeholder="例如：研发团队钉钉"
        /></label>
        <label
          ><span>来源分类</span
          ><NInput v-model:value="form.sourceCategory" placeholder="例如：工作消息"
        /></label>
        <label class="is-wide"
          ><span>Client ID（AppKey）</span
          ><NInput v-model:value="form.clientId" placeholder="钉钉应用的 Client ID"
        /></label>
        <label class="is-wide"
          ><span>Client Secret（AppSecret）</span
          ><NInput v-model:value="form.clientSecret" type="password" show-password-on="click"
        /></label>
      </div>
      <ol class="email-account-modal__hint">
        <li>在钉钉开放平台创建“企业内部应用”，添加机器人能力。</li>
        <li>机器人消息接收模式选择 Stream 模式，并完成应用发布和企业内安装。</li>
        <li>复制“凭证与基础信息”中的 Client ID / Client Secret，在此验证并连接。</li>
      </ol>
      <p class="email-account-modal__hint">
        Client Secret 仅写入系统密钥环保护的加密存储，不会保存在普通数据库或界面状态之外。
      </p>
      <p v-if="error" class="email-account-panel__notice email-account-panel__notice--error">
        <AlertTriangle :size="15" />{{ error }}
      </p>
      <template #footer>
        <div class="email-account-modal__actions">
          <NButton @click="showCreate = false">取消</NButton>
          <NButton type="primary" :loading="saving" @click="connect">验证并连接</NButton>
        </div>
      </template>
    </NModal>
  </section>
</template>
