<script setup lang="ts">
import { AlertTriangle, Mail, Plus, RefreshCw, ShieldCheck, Tag, Trash2 } from '@lucide/vue'
import { onMounted, ref } from 'vue'

import { createEmailService } from '@/app/composition/emailServiceFactory'
import type { EmailAccount } from '@/models/inbox/email'
import type { EmailService } from '@/services/inbox/EmailService'
import { NButton, NInput, NModal } from '@/ui'
import { useMessage } from '@/ui/services'

const native = Reflect.has(globalThis, '__TAURI_INTERNALS__')
const notify = useMessage()
const accounts = ref<EmailAccount[]>([])
const loading = ref(false)
const saving = ref(false)
const syncingId = ref('')
const error = ref('')
const showCreate = ref(false)
const form = ref(defaultForm())
let servicePromise: Promise<EmailService> | null = null

const service = () => (servicePromise ??= createEmailService())

async function load(): Promise<void> {
  if (!native) return
  loading.value = true
  error.value = ''
  const result = await (await service()).listAccounts()
  loading.value = false
  if (!result.ok) {
    error.value = result.error.message
    return
  }
  accounts.value = result.value
}

async function connect(): Promise<void> {
  saving.value = true
  error.value = ''
  try {
    const result = await (await service()).createAccount({ ...form.value })
    if (!result.ok) {
      error.value = result.error.message
      return
    }
    showCreate.value = false
    form.value = defaultForm()
    accounts.value = [result.value, ...accounts.value]
    notify.success('邮箱连接成功')
    await sync(result.value)
  } finally {
    saving.value = false
  }
}

async function sync(account: EmailAccount): Promise<void> {
  syncingId.value = account.id
  error.value = ''
  try {
    const result = await (await service()).syncAccount(account)
    if (!result.ok) {
      const syncError = result.error.message
      await load()
      error.value = syncError
      return
    }
    notify.success(`已同步 ${result.value} 封邮件`)
    await load()
  } finally {
    syncingId.value = ''
  }
}

async function remove(account: EmailAccount): Promise<void> {
  if (!globalThis.confirm(`删除邮箱连接“${account.displayName}”？本地同步邮件也会删除。`)) return
  const result = await (await service()).deleteAccount(account.id)
  if (!result.ok) {
    const removeError = result.error.message
    await load()
    error.value = removeError
    return
  }
  accounts.value = accounts.value.filter((candidate) => candidate.id !== account.id)
  notify.success('邮箱连接已删除')
}

async function editCategory(account: EmailAccount): Promise<void> {
  const category = globalThis.prompt('设置邮箱来源分类', account.sourceCategory)
  if (category == null || category.trim() === account.sourceCategory) return
  const result = await (await service()).updateCategory(account.id, category)
  if (!result.ok) return void (error.value = result.error.message)
  accounts.value = accounts.value.map((candidate) =>
    candidate.id === account.id ? result.value : candidate,
  )
  notify.success('邮箱来源分类已更新')
}

function defaultForm() {
  return {
    displayName: '',
    emailAddress: '',
    imapHost: '',
    imapPort: 993,
    username: '',
    mailbox: 'INBOX',
    password: '',
    sourceCategory: '未分类',
  }
}

function useEmailAsUsername(): void {
  if (!form.value.username.trim()) form.value.username = form.value.emailAddress.trim()
}

onMounted(() => void load())
</script>

<template>
  <section class="email-account-panel" aria-label="邮箱连接器">
    <header>
      <div>
        <strong>邮箱连接器</strong>
        <small>标准 IMAP · TLS · 只读同步</small>
      </div>
      <NButton type="primary" size="small" :disabled="!native" @click="showCreate = true">
        <template #icon><Plus :size="15" /></template>连接邮箱
      </NButton>
    </header>

    <div v-if="!native" class="email-account-panel__notice">
      <AlertTriangle :size="16" />邮箱连接需要在 Tauri 桌面应用中配置。
    </div>
    <div v-if="error" class="email-account-panel__notice email-account-panel__notice--error">
      <AlertTriangle :size="16" />{{ error }}
    </div>

    <div v-if="loading" class="email-account-panel__empty">正在读取邮箱账户…</div>
    <div v-else-if="accounts.length" class="email-account-list">
      <article v-for="account in accounts" :key="account.id">
        <span class="email-account-list__icon"><Mail :size="19" /></span>
        <div class="email-account-list__main">
          <strong>{{ account.displayName }}</strong>
          <small
            >{{ account.emailAddress }} · {{ account.imapHost }}:{{ account.imapPort }} ·
            {{ account.sourceCategory }}</small
          >
          <em v-if="account.lastError">{{ account.lastError }}</em>
          <span v-if="account.lastSyncedAt"
            >上次检查 {{ new Date(account.lastSyncedAt).toLocaleString() }}</span
          ><span v-else>已连接，尚未检查</span>
          <span v-if="account.syncCursorAt"
            >最新内容 {{ new Date(account.syncCursorAt).toLocaleString() }} · UID
            {{ account.lastRemoteUid }}</span
          >
        </div>
        <div class="email-account-list__actions">
          <NButton quaternary circle aria-label="修改来源分类" @click="editCategory(account)">
            <template #icon><Tag :size="15" /></template>
          </NButton>
          <NButton
            quaternary
            circle
            aria-label="同步邮箱"
            :loading="syncingId === account.id"
            @click="sync(account)"
          >
            <template #icon><RefreshCw :size="15" /></template>
          </NButton>
          <NButton quaternary circle aria-label="删除邮箱连接" @click="remove(account)">
            <template #icon><Trash2 :size="15" /></template>
          </NButton>
        </div>
      </article>
    </div>
    <div v-else class="email-account-panel__empty">
      <Mail :size="27" /><strong>还没有邮箱连接</strong>
      <span>连接后，最近邮件会只读同步到统一收件箱。</span>
    </div>

    <aside class="email-account-panel__security">
      <ShieldCheck :size="16" />
      <p>
        <strong>安全边界：</strong
        >密码加密保存且不会写入普通数据库；同步不会发送、删除、移动邮件，也不会改变服务器已读状态。
      </p>
    </aside>

    <NModal
      v-model:show="showCreate"
      preset="card"
      title="连接邮箱"
      class="email-account-modal"
      :bordered="false"
    >
      <div class="email-account-form">
        <label
          ><span>账户名称</span
          ><NInput v-model:value="form.displayName" placeholder="例如：工作邮箱"
        /></label>
        <label
          ><span>邮箱地址</span
          ><NInput
            v-model:value="form.emailAddress"
            placeholder="name@example.com"
            @blur="useEmailAsUsername"
        /></label>
        <label
          ><span>IMAP 主机</span
          ><NInput v-model:value="form.imapHost" placeholder="imap.example.com"
        /></label>
        <label
          ><span>端口</span><input v-model.number="form.imapPort" type="number" min="1" max="65535"
        /></label>
        <label
          ><span>用户名</span
          ><NInput v-model:value="form.username" placeholder="通常是完整邮箱地址"
        /></label>
        <label
          ><span>文件夹</span><NInput v-model:value="form.mailbox" placeholder="INBOX"
        /></label>
        <label
          ><span>来源分类</span
          ><NInput v-model:value="form.sourceCategory" placeholder="例如：工作 / 个人"
        /></label>
        <label class="is-wide"
          ><span>密码 / 应用专用密码</span
          ><NInput v-model:value="form.password" type="password" show-password-on="click"
        /></label>
      </div>
      <p class="email-account-modal__hint">
        Gmail、Outlook 等服务可能关闭普通密码 IMAP。当前版本支持标准密码或应用专用密码，OAuth
        账户授权将在后续接入。服务器声明支持时会自动发送 RFC 2971 IMAP
        ID，兼容网易系邮箱的客户端身份检查。
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
