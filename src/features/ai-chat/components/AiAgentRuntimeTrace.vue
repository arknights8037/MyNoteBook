<script setup lang="ts">
import {
  Activity,
  Bot,
  ChevronDown,
  ChevronRight,
  Clock3,
  CircleCheck,
  CircleX,
  CornerDownRight,
  ExternalLink,
  FileText,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Square,
} from '@lucide/vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import type { AgentRuntimeViewState, AgentTimelineEvent } from '@/models/agent/agentRuntime'
import {
  parseAgentToolPayload,
  presentAgentToolCall,
  type AgentToolDisplayField,
  type AgentToolDisplayItem,
} from '@/services/agent/AgentToolPresentation'

const props = defineProps<{
  state: AgentRuntimeViewState
  active: boolean
  providerLabel: string
  model: string
  step: string
}>()
const emit = defineEmits<{
  stop: []
  'open-source': [documentId: string, blockId?: string]
}>()

const runtimeClock = ref(Date.now())
const detailWorkspaceOpen = ref(false)
let runtimeClockTimer: ReturnType<typeof globalThis.setInterval> | null = null

function toggleDetailWorkspace(): void {
  detailWorkspaceOpen.value = !detailWorkspaceOpen.value
}

function handleDetailWorkspaceKeydown(event: InstanceType<typeof globalThis.KeyboardEvent>): void {
  if (event.key === 'Escape' && detailWorkspaceOpen.value) detailWorkspaceOpen.value = false
}

// Pre-computed lookup map: toolCallId -> toolCall (eliminates O(n) find per template access)
const toolCallMap = computed(() => {
  const map = new Map<string, RuntimeToolCall>()
  for (const call of props.state.toolCalls) map.set(call.id, call)
  return map
})

// Pre-computed timeline events (avoids re-computing on every template access)
const timelineEvents = computed<AgentTimelineEvent[]>(() => {
  if (props.state.timelineEvents?.length) return props.state.timelineEvents
  return props.state.toolCalls.map((call) => ({
    id: `tool:${call.id}`,
    kind: 'tool' as const,
    status:
      call.status === 'running'
        ? ('running' as const)
        : call.status === 'completed'
          ? ('completed' as const)
          : ('failed' as const),
    detail: summarizeToolResult(call),
    occurredAt: call.startedAt,
    completedAt: call.completedAt,
    toolCallId: call.id,
  }))
})

// Pre-computed timeline items: each event enriched with its tool call + presentation data
interface TimelineItem {
  event: AgentTimelineEvent
  toolCall: RuntimeToolCall | null
  toolLabel: string
  argumentsSummary: string
  resultSummary: string
  resultPreview: string
  inputFields: AgentToolDisplayField[]
  resultItems: AgentToolDisplayItem[]
  resultText: string
  paragraphs: string[]
  eventLabel: string
  stepTitle: string
}

const timelineItems = computed<TimelineItem[]>(() => {
  const tcMap = toolCallMap.value
  return timelineEvents.value.map((event) => {
    const toolCall = event.toolCallId ? (tcMap.get(event.toolCallId) ?? null) : null
    return {
      event,
      toolCall,
      toolLabel: toolCall ? getToolLabel(toolCall.toolName) : '',
      argumentsSummary: toolCall ? summarizeToolArguments(toolCall) : '',
      resultSummary: toolCall ? summarizeToolResult(toolCall) : '',
      resultPreview: toolCall ? getToolResultPreview(toolCall) : '',
      inputFields: toolCall ? getToolInputFields(toolCall) : [],
      resultItems: toolCall ? getToolResultItems(toolCall) : [],
      resultText: toolCall ? getToolResultText(toolCall) : '',
      paragraphs: getTimelineParagraphs(event),
      eventLabel: getTimelineEventLabel(event),
      stepTitle: getTimelineStepTitle(event),
    }
  })
})

const runtimeMeta = computed(() => getRuntimeMeta(props.state))
const runtimeSummaryText = computed(() => getRuntimeSummaryText(props.state))
const isTraceInitiallyOpen = computed(() => isRuntimeTraceInitiallyOpen(props.state))
const hasTimeline = computed(() => timelineEvents.value.length > 0)
const activeToolCall = computed(
  () =>
    [...props.state.toolCalls]
      .reverse()
      .find((call) => call.status === 'running' || call.status === 'pending') ?? null,
)
const externalActivity = computed(() => {
  const call = activeToolCall.value
  if (!call?.toolName.startsWith('mcp__')) return null
  const delegated = /(?:qoder|agent_run|delegate|delegation|execute_task|run_task)/i.test(
    call.toolName,
  )
  return {
    call,
    delegated,
    label: getToolLabel(call.toolName),
    elapsed: formatToolDuration(call.startedAt, call.completedAt),
    hint: getExternalWaitHint(call.startedAt, delegated),
  }
})
const currentRound = computed(() => {
  const timelineRound = timelineEvents.value.reduce(
    (maximum, event) => Math.max(maximum, event.stepNumber ?? 0),
    0,
  )
  return Math.max(props.state.rounds, timelineRound, props.active ? 1 : 0)
})
const visibleRounds = computed(() => {
  const count = currentRound.value
  if (count <= 0) return []
  const first = Math.max(1, count - 7)
  return Array.from({ length: count - first + 1 }, (_, index) => first + index)
})
const progressStages = computed(() => {
  const failed = props.state.status === 'failed'
  const completed = props.state.status === 'completed'
  const stageIndex =
    completed || props.state.phase === 'finalizing'
      ? 2
      : props.state.phase === 'preparing' || props.state.phase === 'planning'
        ? 0
        : 1
  return ['理解任务', '执行与协作', '整理结果'].map((label, index) => ({
    label,
    status: completed
      ? 'completed'
      : failed && index === stageIndex
        ? 'failed'
        : index < stageIndex
          ? 'completed'
          : index === stageIndex
            ? 'active'
            : 'pending',
  }))
})
const phasePresentation = computed(() => {
  if (externalActivity.value) {
    return {
      label: externalActivity.value.delegated
        ? `正在等待 ${externalActivity.value.label} 返回`
        : `正在调用 ${externalActivity.value.label}`,
      detail: externalActivity.value.hint,
    }
  }
  if (props.state.status === 'waiting_authorizer') {
    return { label: '执行已暂停，等待你的决定', detail: '回答后会从当前步骤继续，不会重新开始。' }
  }
  if (props.state.status === 'completed') {
    return { label: '任务已完成', detail: props.state.summary?.trim() || props.state.detail }
  }
  if (props.state.status === 'failed') {
    return { label: '任务执行失败', detail: props.state.detail || '可查看时间线定位失败步骤。' }
  }
  if (props.state.status === 'cancelled') {
    return { label: '任务已停止', detail: props.state.detail || '执行现场已保存到当前对话。' }
  }
  if (props.state.phase === 'preparing') {
    return { label: '正在准备运行环境', detail: props.state.detail || '正在冻结本次任务上下文。' }
  }
  if (props.state.phase === 'planning') {
    return { label: '正在理解任务并规划下一步', detail: props.state.detail || props.step }
  }
  if (props.state.phase === 'finalizing') {
    return { label: '正在整理结果', detail: props.state.detail || '正在生成最终回答或修改提案。' }
  }
  const call = activeToolCall.value
  return {
    label: call ? `正在执行 ${getToolLabel(call.toolName)}` : props.state.detail || props.step,
    detail: call ? '工具结果返回后，Agent 会自动进入下一轮判断。' : 'Agent 正在继续执行。',
  }
})

function getRuntimeMeta(state: AgentRuntimeViewState): string {
  const items = [runtimeStatusLabel(state.status)]
  if (state.startedAt) {
    const duration = formatDuration(state.startedAt, state.completedAt ?? runtimeClock.value)
    items.push(state.completedAt ? `执行了 ${duration}` : duration)
  }
  if (state.rounds > 0) items.push(`${state.rounds} 轮`)
  if (state.toolCalls.length > 0) items.push(`${state.toolCalls.length} 次工具调用`)
  return items.join(' · ')
}

function isRuntimeTraceInitiallyOpen(state: AgentRuntimeViewState): boolean {
  return (
    state.status === 'running' || state.status === 'waiting_authorizer' || state.status === 'failed'
  )
}

function getRuntimeSummaryText(state: AgentRuntimeViewState): string {
  const summary = state.summary?.trim()
  if (summary) return summary
  if (state.status === 'completed') return '任务已完成，执行过程已收起。'
  if (state.status === 'cancelled') return '任务已停止。'
  if (state.status === 'failed') return state.detail || '任务执行失败。'
  return state.detail || '正在分析并执行任务。'
}

function runtimeStatusLabel(status: AgentRuntimeViewState['status']): string {
  if (status === 'running') return '运行中'
  if (status === 'waiting_authorizer') return '等待授权人'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'cancelled') return '已停止'
  return '待命'
}

function formatDuration(startedAt: number, completedAt: number): string {
  const duration = Math.max(0, completedAt - startedAt)
  if (duration < 1000) return `${duration} ms`
  if (duration < 60_000) return `${(duration / 1000).toFixed(1)} 秒`
  const minutes = Math.floor(duration / 60_000)
  const seconds = Math.floor((duration % 60_000) / 1000)
  return `${minutes} 分 ${seconds} 秒`
}

function formatToolDuration(startedAt: number, completedAt: number | null): string {
  return formatDuration(startedAt, completedAt ?? runtimeClock.value)
}

function getExternalWaitHint(startedAt: number, delegated: boolean): string {
  const elapsed = Math.max(0, runtimeClock.value - startedAt)
  if (elapsed < 15_000)
    return delegated ? '已提交外部任务，正在等待对方开始处理。' : '正在等待外部服务响应。'
  if (elapsed < 60_000)
    return delegated
      ? '外部 Agent 正在独立执行，返回后本任务会自动继续。'
      : '外部服务仍在处理，结果返回后会自动继续。'
  return delegated
    ? '外部任务耗时较长，但仍在执行；你可以展开查看委派输入或停止任务。'
    : '外部服务响应较慢；你可以继续等待或停止本次任务。'
}

function getToolLabel(toolName: string): string {
  const labels: Record<string, string> = {
    get_current_document: '读取当前页面',
    get_selected_blocks: '读取选中块',
    get_document_outline: '读取页面大纲',
    search_documents: '搜索知识库',
    list_document_groups: '查找文档分组',
    read_document: '读取知识文档',
    find_blocks_by_regex: '定位内容块',
    read_skill_file: '读取技能资料',
    request_authorizer_input: '询问授权人',
    execute_shell: '执行只读命令',
    inspect_environment_paths: '检查环境路径',
    discover_local_tools: '发现本机工具',
    get_system_info: '读取系统信息',
    create_automation_draft: '创建自动化草稿',
    create_mcp_server_draft: '添加 MCP 服务草稿',
    create_skill_draft: '创建 Skill 草稿',
    replace_text_by_regex: '提交文本替换提案',
    replace_block: '提交块修改提案',
    insert_blocks: '提交内容插入提案',
    create_document: '提交新文档提案',
    create_group: '提交新分组提案',
    submit_document_edits: '提交多文档修改提案',
  }
  if (labels[toolName]) return labels[toolName]
  if (toolName.startsWith('mcp__')) return formatMcpToolLabel(toolName)
  return toolName
}

function formatMcpToolLabel(toolName: string): string {
  const [, server = 'MCP', ...toolParts] = toolName.split('__')
  const tool = toolParts.join('__')
  const knownLabels: Record<string, string> = {
    web_search_exa: '网页搜索',
    web_search_advanced_exa: '高级网页搜索',
    web_fetch_exa: '读取网页',
    agent_run: '运行研究 Agent',
    execute_task: '执行委派任务',
    run_task: '执行委派任务',
    get_status: '查询任务状态',
  }
  const serverLabel = server
    .split('_')
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toLocaleUpperCase()}${part.slice(1)}`)
    .join(' ')
  const toolLabel =
    knownLabels[tool] ?? tool.replace(/_exa$/, '').split('_').filter(Boolean).join(' ')
  return `${serverLabel || 'MCP'} · ${toolLabel || '工具'}`
}

type RuntimeToolCall = AgentRuntimeViewState['toolCalls'][number]

function getTimelineStepTitle(event: AgentTimelineEvent): string {
  if (event.kind === 'retry') return '正在重试'
  if (event.kind === 'decision') return `第 ${event.stepNumber ?? '?'} 轮决策`
  if (event.kind === 'summary') return '最终 Summary'
  if (event.kind === 'step_started') return `第 ${event.stepNumber ?? '?'} 轮判断`
  if (event.kind === 'step_completed') return `第 ${event.stepNumber ?? '?'} 轮完成`
  return '运行状态'
}

function getTimelineEventLabel(event: AgentTimelineEvent): string {
  if (event.kind === 'decision') return '判断'
  if (event.kind === 'summary') return '总结'
  if (event.kind === 'retry') return '重试'
  if (event.kind === 'step_started' || event.kind === 'step_completed') return '步骤'
  return '状态'
}

function formatToolDetail(value: string | null, maxLength = 8_000): string {
  const payload = parseAgentToolPayload(value)
  if (payload === null) return ''
  const formatted = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  return formatted.length > maxLength ? `${formatted.slice(0, maxLength)}\n… 已截断` : formatted
}

function summarizeToolArguments(toolCall: RuntimeToolCall): string {
  const presentation = presentAgentToolCall(toolCall)
  if (toolCall.toolName === 'read_document') {
    const fields = new Map(presentation.inputFields.map((field) => [field.label, field.value]))
    const document = fields.get('文档')
    const selectedBlocks = fields.get('指定块')
    const cursor = fields.get('起始块')
    const budget = fields.get('字符预算')
    return [
      document ? `文档：${document}` : '',
      selectedBlocks
        ? `指定块：${selectedBlocks}`
        : cursor
          ? `从第 ${Number(cursor) + 1} 块分页`
          : '从第 1 块分页',
      budget ? `预算 ${budget} 字符` : '',
    ]
      .filter(Boolean)
      .join(' · ')
  }
  const first = presentation.inputFields[0]
  return first ? `${first.label}：${first.value}` : '无参数'
}

function summarizeToolResult(toolCall: RuntimeToolCall): string {
  if (toolCall.status === 'running') return '执行中'
  if (toolCall.error) {
    return toolCall.error.length > 100 ? `${toolCall.error.slice(0, 100)}…` : toolCall.error
  }
  const presentation = presentAgentToolCall(toolCall)
  if (presentation.resultCount !== null) return `完成 · 返回 ${presentation.resultCount} 项`
  return '已完成'
}

function getToolResultPreview(toolCall: RuntimeToolCall): string {
  if (toolCall.status !== 'completed') return ''
  const presentation = presentAgentToolCall(toolCall)
  const preview =
    presentation.resultText ||
    presentation.resultItems
      .slice(0, 4)
      .map((item) => item.title)
      .join(' · ')
  if (!preview) return ''
  const normalized = preview.replace(/\s+/g, ' ').trim()
  return normalized.length > 320 ? `${normalized.slice(0, 320)}…` : normalized
}

function getToolInputFields(toolCall: RuntimeToolCall): AgentToolDisplayField[] {
  return presentAgentToolCall(toolCall).inputFields
}

function getToolResultItems(toolCall: RuntimeToolCall): AgentToolDisplayItem[] {
  return presentAgentToolCall(toolCall).resultItems
}

function getToolResultText(toolCall: RuntimeToolCall): string {
  return presentAgentToolCall(toolCall).resultText
}

function getTimelineParagraphs(event: AgentTimelineEvent): string[] {
  return event.detail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

watch(
  () => props.active,
  (active) => {
    if (runtimeClockTimer) globalThis.clearInterval(runtimeClockTimer)
    runtimeClock.value = Date.now()
    runtimeClockTimer = active
      ? globalThis.setInterval(() => {
          runtimeClock.value = Date.now()
        }, 250)
      : null
  },
  { immediate: true },
)

watch(detailWorkspaceOpen, (open) => {
  if (open) globalThis.addEventListener('keydown', handleDetailWorkspaceKeydown)
  else globalThis.removeEventListener('keydown', handleDetailWorkspaceKeydown)
})

onBeforeUnmount(() => {
  if (runtimeClockTimer) globalThis.clearInterval(runtimeClockTimer)
  globalThis.removeEventListener('keydown', handleDetailWorkspaceKeydown)
})
</script>

<template>
  <Teleport to="body" :disabled="!detailWorkspaceOpen">
    <section
      class="ai-agent-loop"
      :class="[
        `ai-agent-loop--${state.status}`,
        { 'ai-agent-loop--detail-workspace': detailWorkspaceOpen },
      ]"
      :role="detailWorkspaceOpen ? 'dialog' : 'status'"
      :aria-modal="detailWorkspaceOpen ? 'true' : undefined"
      aria-label="Agent 运行轨迹"
    >
      <header class="ai-agent-loop__header">
        <span class="ai-agent-loop__identity"><Activity :size="14" /> Agent loop</span>
        <small>{{ runtimeMeta }} · {{ providerLabel }} / {{ model }}</small>
        <span class="ai-agent-loop__actions">
          <button
            v-if="hasTimeline"
            type="button"
            class="ai-agent-loop__expand"
            :aria-label="detailWorkspaceOpen ? '退出宽视图' : '在宽视图中展开运行详情'"
            :title="detailWorkspaceOpen ? '退出宽视图' : '展开运行详情'"
            @click="toggleDetailWorkspace"
          >
            <Minimize2 v-if="detailWorkspaceOpen" :size="13" />
            <Maximize2 v-else :size="13" />
          </button>
          <button
            v-if="active"
            type="button"
            aria-label="停止 Agent"
            title="停止 Agent"
            @click="emit('stop')"
          >
            <Square :size="12" fill="currentColor" />
          </button>
        </span>
      </header>

      <ol class="ai-agent-progress" aria-label="Agent 执行阶段">
        <li
          v-for="(stage, index) in progressStages"
          :key="stage.label"
          :class="`ai-agent-progress__stage--${stage.status}`"
        >
          <span>{{ stage.status === 'completed' ? '✓' : index + 1 }}</span>
          <strong>{{ stage.label }}</strong>
        </li>
      </ol>

      <section
        v-if="externalActivity"
        class="ai-agent-external-wait"
        :class="{ 'ai-agent-external-wait--delegated': externalActivity.delegated }"
        role="status"
        aria-live="polite"
      >
        <span class="ai-agent-external-wait__icon">
          <Bot v-if="externalActivity.delegated" :size="17" aria-hidden="true" />
          <Activity v-else :size="17" aria-hidden="true" />
        </span>
        <span class="ai-agent-external-wait__copy">
          <small>{{ externalActivity.delegated ? '外部 Agent 委派' : '外部 MCP 服务' }}</small>
          <strong>{{ externalActivity.label }}</strong>
          <span>{{ externalActivity.hint }}</span>
        </span>
        <time><Clock3 :size="12" />{{ externalActivity.elapsed }}</time>
        <span class="ai-agent-external-wait__progress" aria-hidden="true"></span>
      </section>

      <div v-if="visibleRounds.length" class="ai-agent-rounds" aria-label="Agent 内部轮次">
        <span>Agent 轮次</span>
        <ol>
          <li
            v-for="round in visibleRounds"
            :key="round"
            :class="{
              'ai-agent-rounds__item--current': round === currentRound && active,
              'ai-agent-rounds__item--completed': round < currentRound || !active,
            }"
          >
            {{ round }}
          </li>
        </ol>
        <small>每轮都会根据上一轮工具结果决定下一步</small>
      </div>

      <details
        v-if="hasTimeline"
        class="ai-agent-loop__trace"
        :open="detailWorkspaceOpen || isTraceInitiallyOpen"
      >
        <summary class="ai-agent-loop__trace-summary">
          <span>
            <CircleCheck v-if="state.status === 'completed'" :size="14" aria-hidden="true" />
            <LoaderCircle
              v-else-if="active"
              :size="14"
              class="ai-agent-tool-list__spinner"
              aria-hidden="true"
            />
            <CircleX v-else :size="14" aria-hidden="true" />
          </span>
          <span>
            <strong>{{ active ? '实时执行过程' : '执行摘要' }}</strong>
            <small>{{ runtimeSummaryText }}</small>
          </span>
          <ChevronDown :size="14" aria-hidden="true" />
        </summary>
        <ol class="ai-agent-tool-list ai-agent-timeline">
          <li
            v-for="item in timelineItems"
            :key="item.event.id"
            :class="[
              `ai-agent-tool-list__item--${item.event.status}`,
              `ai-agent-timeline__item--${item.event.kind}`,
              { 'ai-agent-timeline__decision': item.event.kind === 'decision' },
              { 'ai-agent-timeline__summary': item.event.kind === 'summary' },
            ]"
          >
            <details
              v-if="item.toolCall"
              class="ai-agent-tool-step"
              :open="item.toolCall.status === 'failed'"
            >
              <summary>
                <span class="ai-agent-tool-step__marker" aria-hidden="true">
                  <LoaderCircle
                    v-if="item.toolCall.status === 'running'"
                    :size="13"
                    class="ai-agent-tool-list__spinner"
                  />
                  <CircleCheck v-else-if="item.toolCall.status === 'completed'" :size="13" />
                  <CircleX v-else :size="13" />
                </span>
                <span class="ai-agent-tool-step__copy">
                  <strong>
                    <span class="ai-agent-timeline__kind">工具</span>
                    {{ item.toolLabel }}
                  </strong>
                  <small>{{ item.argumentsSummary }}</small>
                </span>
                <span class="ai-agent-tool-step__status">{{ item.resultSummary }}</span>
                <time>{{
                  formatToolDuration(
                    item.toolCall.startedAt ?? item.event.occurredAt,
                    item.toolCall.completedAt ?? item.event.completedAt,
                  )
                }}</time>
                <ChevronDown :size="13" class="ai-agent-tool-step__chevron" aria-hidden="true" />
              </summary>
              <div class="ai-agent-tool-step__details">
                <section v-if="item.inputFields.length" class="ai-agent-tool-step__section">
                  <strong>输入</strong>
                  <dl class="ai-agent-tool-step__fields">
                    <template v-for="field in item.inputFields" :key="field.label">
                      <dt>{{ field.label }}</dt>
                      <dd>{{ field.value }}</dd>
                    </template>
                  </dl>
                </section>
                <template v-if="item.toolCall.error">
                  <section class="ai-agent-tool-step__section">
                    <strong>错误</strong>
                    <p class="ai-agent-tool-list__error">
                      {{ item.toolCall.error }}
                    </p>
                  </section>
                </template>
                <section
                  v-else-if="item.resultItems.length || item.resultText"
                  class="ai-agent-tool-step__section"
                >
                  <strong>结果</strong>
                  <p v-if="item.resultText">
                    {{ item.resultText }}
                  </p>
                  <ul v-if="item.resultItems.length" class="ai-agent-tool-results">
                    <li
                      v-for="resultItem in item.resultItems"
                      :key="`${resultItem.documentId ?? resultItem.url ?? ''}:${resultItem.title}`"
                    >
                      <button
                        v-if="resultItem.documentId"
                        type="button"
                        class="ai-agent-tool-results__document"
                        @click="emit('open-source', resultItem.documentId, resultItem.blockId)"
                      >
                        <FileText :size="13" aria-hidden="true" />
                        <span>{{ resultItem.title }}</span>
                        <ChevronRight :size="12" aria-hidden="true" />
                      </button>
                      <a
                        v-else-if="resultItem.url"
                        :href="resultItem.url"
                        target="_blank"
                        rel="noreferrer"
                      >
                        <span>{{ resultItem.title }}</span>
                        <ExternalLink :size="12" aria-hidden="true" />
                      </a>
                      <strong v-else>{{ resultItem.title }}</strong>
                      <p v-if="resultItem.description">{{ resultItem.description }}</p>
                      <small v-if="resultItem.documentId">
                        知识库文档{{ resultItem.blockId ? ' · 已定位内容块' : '' }}
                      </small>
                      <small v-else-if="resultItem.url">{{ resultItem.url }}</small>
                    </li>
                  </ul>
                </section>
                <details class="ai-agent-tool-step__raw">
                  <summary>原始数据</summary>
                  <span>工具</span>
                  <code>{{ item.toolCall.toolName }}</code>
                  <template v-if="formatToolDetail(item.toolCall.argumentsJson)">
                    <span>输入 JSON</span>
                    <pre>{{ formatToolDetail(item.toolCall.argumentsJson) }}</pre>
                  </template>
                  <template v-if="formatToolDetail(item.toolCall.resultJson)">
                    <span>输出 JSON</span>
                    <pre>{{ formatToolDetail(item.toolCall.resultJson) }}</pre>
                  </template>
                </details>
              </div>
            </details>
            <div v-if="item.toolCall && item.resultPreview" class="ai-agent-tool-step__preview">
              <CornerDownRight :size="12" aria-hidden="true" />
              <span><b>输出</b>{{ item.resultPreview }}</span>
            </div>
            <div v-if="!item.toolCall" class="ai-agent-timeline__step">
              <span class="ai-agent-tool-step__marker" aria-hidden="true">
                <LoaderCircle
                  v-if="item.event.status === 'running'"
                  :size="13"
                  class="ai-agent-tool-list__spinner"
                />
                <CircleCheck v-else-if="item.event.status === 'completed'" :size="13" />
                <CircleX v-else :size="13" />
              </span>
              <div class="ai-agent-timeline__copy">
                <strong>
                  <span class="ai-agent-timeline__kind">{{ item.eventLabel }}</span>
                  {{ item.stepTitle }}
                </strong>
                <span class="ai-agent-timeline__narrative">
                  <p v-for="paragraph in item.paragraphs" :key="paragraph">
                    {{ paragraph }}
                  </p>
                </span>
              </div>
            </div>
          </li>
        </ol>
      </details>

      <div class="ai-agent-loop__phase" aria-live="polite">
        <span
          v-if="state.status === 'running' || state.status === 'waiting_authorizer'"
          class="ai-agent-runbar__pulse"
          aria-hidden="true"
        ></span>
        <CircleCheck
          v-else-if="state.status === 'completed'"
          :size="14"
          class="ai-agent-loop__success"
          aria-hidden="true"
        />
        <CircleX v-else :size="14" class="ai-agent-loop__error" aria-hidden="true" />
        <span class="ai-agent-loop__phase-copy">
          <strong>{{ phasePresentation.label || '正在分析上下文' }}</strong>
          <small>{{ phasePresentation.detail }}</small>
        </span>
      </div>
    </section>
  </Teleport>
</template>
