<script setup lang="ts">
import {
  AlertTriangle,
  ArrowRight,
  Inbox,
  Mail,
  MessageCircle,
  PlugZap,
  Rss,
  ShieldCheck,
} from '@lucide/vue'
import { computed } from 'vue'

import type { InboxSection } from '@/models/workspace/workspaceSurface'
import EmailInboxPanel from './EmailInboxPanel.vue'

const props = defineProps<{ section: InboxSection }>()
const emit = defineEmits<{ openConnections: [] }>()

const sectionMeta: Record<InboxSection, { eyebrow: string; title: string; description: string }> = {
  pending: {
    eyebrow: 'ACTION QUEUE',
    title: '待处理',
    description: '需要阅读、判断、关联项目或交给 Agent 的外部信息。',
  },
  all: {
    eyebrow: 'SIGNAL TIMELINE',
    title: '全部动态',
    description: '按照来源时间汇总 RSS、消息、邮件和其他受控信号。',
  },
  rss: {
    eyebrow: 'RSS SOURCES',
    title: 'RSS',
    description: '订阅更新、内容增量、主题归类和来源异常。',
  },
  messages: {
    eyebrow: 'MESSAGING',
    title: '消息',
    description: '来自 IM 与协作工具的受控消息入口。',
  },
  email: {
    eyebrow: 'EMAIL',
    title: '邮件',
    description: '按账户和会话组织需要继续处理的邮件。',
  },
  failures: {
    eyebrow: 'INGESTION HEALTH',
    title: '采集异常',
    description: '集中处理授权过期、同步失败、解析错误和来源不可用。',
  },
}

const sources = [
  {
    id: 'rss' as const,
    title: 'RSS',
    description: '订阅源、增量抓取和内容哈希',
    icon: Rss,
  },
  {
    id: 'messages' as const,
    title: 'IM / 消息',
    description: '协作空间、频道和会话范围',
    icon: MessageCircle,
  },
  {
    id: 'email' as const,
    title: '邮件',
    description: '账户、文件夹和邮件会话',
    icon: Mail,
  },
]

const activeMeta = computed(() => sectionMeta[props.section])
const visibleSources = computed(() => {
  if (props.section === 'rss' || props.section === 'messages' || props.section === 'email') {
    return sources.filter((source) => source.id === props.section)
  }
  return sources
})
</script>

<template>
  <section class="inbox-surface" aria-label="收件箱">
    <header class="inbox-surface__header">
      <div>
        <span><Inbox :size="14" />{{ activeMeta.eyebrow }}</span>
        <h1>{{ activeMeta.title }}</h1>
        <p>{{ activeMeta.description }}</p>
      </div>
      <button type="button" @click="emit('openConnections')">
        <PlugZap :size="16" />连接与扩展<ArrowRight :size="14" />
      </button>
    </header>

    <div class="inbox-surface__content">
      <section v-if="section === 'failures'" class="inbox-empty-state">
        <span class="inbox-empty-state__icon"><ShieldCheck :size="25" /></span>
        <h2>当前没有采集异常</h2>
        <p>连接器接入后，授权、同步和解析问题会统一出现在这里。</p>
      </section>

      <EmailInboxPanel
        v-else-if="section === 'pending' || section === 'all' || section === 'email'"
        :mode="section"
        @open-connections="emit('openConnections')"
      />

      <template v-else>
        <div class="inbox-overview-strip">
          <div><strong>0</strong><span>待处理</span></div>
          <div><strong>0</strong><span>今日新增</span></div>
          <div><strong>0</strong><span>连接异常</span></div>
          <p><ShieldCheck :size="14" />外部内容只读进入收件箱，正式写入继续经过确认。</p>
        </div>

        <section class="inbox-empty-state">
          <span class="inbox-empty-state__icon"><Inbox :size="25" /></span>
          <h2>{{ section === 'pending' ? '没有等待处理的信息' : '还没有接入外部信息' }}</h2>
          <p>先在“连接与扩展”配置来源；采集内容会在这里统一阅读、筛选和关联项目。</p>
          <button type="button" @click="emit('openConnections')">
            配置连接器<ArrowRight :size="14" />
          </button>
        </section>

        <div class="inbox-source-grid" aria-label="可接入来源">
          <article v-for="source in visibleSources" :key="source.id">
            <span><component :is="source.icon" :size="18" /></span>
            <div><strong>{{ source.title }}</strong><small>{{ source.description }}</small></div>
            <em>规划中</em>
          </article>
        </div>
      </template>

      <aside class="inbox-boundary-note">
        <AlertTriangle :size="16" />
        <p><strong>收件箱不是插件配置页。</strong>这里处理“进来了什么”；账户授权、同步范围和连接状态由“连接与扩展”管理。</p>
      </aside>
    </div>
  </section>
</template>
