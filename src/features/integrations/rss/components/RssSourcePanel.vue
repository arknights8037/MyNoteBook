<script setup lang="ts">
import {
  AlertTriangle,
  ExternalLink,
  Plus,
  RefreshCw,
  Rss,
  ShieldCheck,
  Tag,
  Trash2,
} from '@lucide/vue'
import { openUrl } from '@tauri-apps/plugin-opener'
import { onMounted, ref } from 'vue'

import { createRssService } from '@/app/composition/rssServiceFactory'
import type { RssSource } from '@/models/inbox/rss'
import type { RssService } from '@/services/inbox/RssService'
import { NButton, NInput, NModal } from '@/ui'
import { useMessage } from '@/ui/services'

const native = Reflect.has(globalThis, '__TAURI_INTERNALS__')
const notify = useMessage()
const sources = ref<RssSource[]>([])
const loading = ref(false)
const saving = ref(false)
const syncingId = ref('')
const error = ref('')
const showCreate = ref(false)
const form = ref({ displayName: '', feedUrl: '', sourceCategory: '未分类' })
let servicePromise: Promise<RssService> | null = null

const service = () => (servicePromise ??= createRssService())

async function load(): Promise<void> {
  if (!native) return
  loading.value = true
  error.value = ''
  const result = await (await service()).listSources()
  loading.value = false
  if (!result.ok) return void (error.value = result.error.message)
  sources.value = result.value
}

async function connect(): Promise<void> {
  saving.value = true
  error.value = ''
  try {
    const result = await (await service()).createSource({ ...form.value })
    if (!result.ok) return void (error.value = result.error.message)
    showCreate.value = false
    form.value = { displayName: '', feedUrl: '', sourceCategory: '未分类' }
    sources.value = [result.value.source, ...sources.value]
    notify.success(`RSS 已连接，导入 ${result.value.imported} 条`)
  } finally {
    saving.value = false
  }
}

async function sync(source: RssSource): Promise<void> {
  syncingId.value = source.id
  error.value = ''
  try {
    const result = await (await service()).syncSource(source)
    if (!result.ok) {
      const syncError = result.error.message
      await load()
      error.value = syncError
      return
    }
    notify.success(result.value ? `已读取 ${result.value} 条 RSS` : '订阅源没有更新')
    await load()
  } finally {
    syncingId.value = ''
  }
}

async function remove(source: RssSource): Promise<void> {
  if (!globalThis.confirm(`删除 RSS 订阅“${source.displayName}”？本地条目也会删除。`)) return
  const result = await (await service()).deleteSource(source.id)
  if (!result.ok) return void (error.value = result.error.message)
  sources.value = sources.value.filter((candidate) => candidate.id !== source.id)
  notify.success('RSS 订阅已删除')
}

async function editCategory(source: RssSource): Promise<void> {
  const category = globalThis.prompt('设置 RSS 来源分类', source.sourceCategory)
  if (category == null || category.trim() === source.sourceCategory) return
  const result = await (await service()).updateCategory(source.id, category)
  if (!result.ok) return void (error.value = result.error.message)
  sources.value = sources.value.map((candidate) =>
    candidate.id === source.id ? result.value : candidate,
  )
  notify.success('RSS 来源分类已更新')
}

async function openSite(source: RssSource): Promise<void> {
  if (!source.siteUrl) return
  try {
    await openUrl(source.siteUrl)
  } catch (openError) {
    error.value = openError instanceof Error ? openError.message : String(openError)
  }
}

onMounted(() => void load())
</script>

<template>
  <section class="email-account-panel rss-source-panel" aria-label="RSS 连接器">
    <header>
      <div>
        <strong>RSS 连接器</strong>
        <small>RSS / Atom / JSON Feed · 条件同步</small>
      </div>
      <NButton type="primary" size="small" :disabled="!native" @click="showCreate = true">
        <template #icon><Plus :size="15" /></template>添加订阅
      </NButton>
    </header>

    <div v-if="!native" class="email-account-panel__notice">
      <AlertTriangle :size="16" />RSS 连接需要在 Tauri 桌面应用中配置。
    </div>
    <div
      v-if="error"
      class="email-account-panel__notice email-account-panel__notice--error"
      role="alert"
    >
      <AlertTriangle :size="16" />{{ error }}
    </div>

    <div v-if="loading" class="email-account-panel__empty">正在读取 RSS 订阅…</div>
    <div v-else-if="sources.length" class="email-account-list">
      <article v-for="source in sources" :key="source.id">
        <span class="email-account-list__icon"><Rss :size="19" /></span>
        <div class="email-account-list__main">
          <strong>{{ source.displayName }}</strong>
          <small>{{ source.feedUrl }} · {{ source.sourceCategory }}</small>
          <em v-if="source.lastError">{{ source.lastError }}</em>
          <span v-if="source.lastSyncedAt"
            >上次检查 {{ new Date(source.lastSyncedAt).toLocaleString() }}</span
          ><span v-else>已添加，尚未检查</span>
          <span v-if="source.syncCursorAt"
            >最新内容 {{ new Date(source.syncCursorAt).toLocaleString() }}</span
          >
        </div>
        <div class="email-account-list__actions">
          <NButton quaternary circle aria-label="修改来源分类" @click="editCategory(source)">
            <template #icon><Tag :size="15" /></template>
          </NButton>
          <NButton
            v-if="source.siteUrl"
            quaternary
            circle
            aria-label="打开站点"
            @click="openSite(source)"
          >
            <template #icon><ExternalLink :size="15" /></template>
          </NButton>
          <NButton
            quaternary
            circle
            aria-label="同步 RSS"
            :loading="syncingId === source.id"
            @click="sync(source)"
          >
            <template #icon><RefreshCw :size="15" /></template>
          </NButton>
          <NButton quaternary circle aria-label="删除 RSS 订阅" @click="remove(source)">
            <template #icon><Trash2 :size="15" /></template>
          </NButton>
        </div>
      </article>
    </div>
    <div v-else class="email-account-panel__empty">
      <Rss :size="27" /><strong>还没有 RSS 订阅</strong>
      <span>添加 RSS、Atom 或 JSON Feed 地址后，最新条目会进入收件箱。</span>
    </div>

    <aside class="email-account-panel__security">
      <ShieldCheck :size="16" />
      <p>
        <strong>安全边界：</strong>仅请求公共 HTTP/HTTPS 地址；响应限制为 2 MiB，远程 HTML
        会转换为纯文本，阅读不会向源站加载图片或脚本。
      </p>
    </aside>

    <NModal
      v-model:show="showCreate"
      preset="card"
      title="添加 RSS 订阅"
      class="email-account-modal"
      :bordered="false"
    >
      <div class="email-account-form rss-source-form">
        <label class="is-wide"
          ><span>订阅地址</span
          ><NInput v-model:value="form.feedUrl" placeholder="https://example.com/feed.xml"
        /></label>
        <label class="is-wide"
          ><span>显示名称（可选）</span
          ><NInput v-model:value="form.displayName" placeholder="留空时使用订阅源标题"
        /></label>
        <label class="is-wide"
          ><span>来源分类</span
          ><NInput v-model:value="form.sourceCategory" placeholder="例如：技术 / 行业 / 公告"
        /></label>
      </div>
      <p class="email-account-modal__hint">
        添加时会立即验证并读取最近 50 条。后续同步会使用 ETag /
        Last-Modified，未变化的订阅不会重复下载正文。
      </p>
      <p
        v-if="error"
        class="email-account-panel__notice email-account-panel__notice--error"
        role="alert"
      >
        <AlertTriangle :size="15" />{{ error }}
      </p>
      <template #footer>
        <div class="email-account-modal__actions">
          <NButton @click="showCreate = false">取消</NButton>
          <NButton type="primary" :loading="saving" @click="connect">验证并添加</NButton>
        </div>
      </template>
    </NModal>
  </section>
</template>
