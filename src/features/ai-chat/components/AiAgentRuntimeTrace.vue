<script setup lang="ts">
import {
  Activity,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  CornerDownRight,
  ExternalLink,
  FileText,
  LoaderCircle,
  Square,
} from '@lucide/vue'
import { onBeforeUnmount, ref, watch } from 'vue'

import type { AgentRuntimeViewState, AgentTimelineEvent } from '@/models/agentRuntime'
import {
  parseAgentToolPayload,
  presentAgentToolCall,
  type AgentToolDisplayField,
  type AgentToolDisplayItem,
} from '@/services/AgentToolPresentation'

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
let runtimeClockTimer: ReturnType<typeof globalThis.setInterval> | null = null

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

function getRuntimeTimelineEvents(state: AgentRuntimeViewState): AgentTimelineEvent[] {
  if (state.timelineEvents?.length) return state.timelineEvents
  return state.toolCalls.map((call) => ({
    id: `tool:${call.id}`,
    kind: 'tool',
    status:
      call.status === 'running' ? 'running' : call.status === 'completed' ? 'completed' : 'failed',
    detail: summarizeToolResult(call),
    occurredAt: call.startedAt,
    completedAt: call.completedAt,
    toolCallId: call.id,
  }))
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

function getTimelineTool(
  event: AgentTimelineEvent,
  state: AgentRuntimeViewState,
): RuntimeToolCall | null {
  if (!event.toolCallId) return null
  return state.toolCalls.find((call) => call.id === event.toolCallId) ?? null
}

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

function summarizeToolArguments(value: string): string {
  const call = { argumentsJson: value, resultJson: null } as RuntimeToolCall
  const first = presentAgentToolCall(call).inputFields[0]
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

onBeforeUnmount(() => {
  if (runtimeClockTimer) globalThis.clearInterval(runtimeClockTimer)
})
</script>

<template>
  <section
    class="ai-agent-loop"
    :class="`ai-agent-loop--${state.status}`"
    role="status"
    aria-label="Agent 运行轨迹"
  >
    <header class="ai-agent-loop__header">
      <span class="ai-agent-loop__identity"><Activity :size="14" /> Agent loop</span>
      <small>{{ getRuntimeMeta(state) }} · {{ providerLabel }} / {{ model }}</small>
      <button
        v-if="active"
        type="button"
        aria-label="停止 Agent"
        title="停止 Agent"
        @click="emit('stop')"
      >
        <Square :size="12" fill="currentColor" />
      </button>
    </header>

    <details
      v-if="getRuntimeTimelineEvents(state).length > 0"
      class="ai-agent-loop__trace"
      :open="isRuntimeTraceInitiallyOpen(state)"
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
          <small>{{ getRuntimeSummaryText(state) }}</small>
        </span>
        <ChevronDown :size="14" aria-hidden="true" />
      </summary>
      <ol class="ai-agent-tool-list ai-agent-timeline">
        <li
          v-for="event in getRuntimeTimelineEvents(state)"
          :key="event.id"
          :class="[
            `ai-agent-tool-list__item--${event.status}`,
            `ai-agent-timeline__item--${event.kind}`,
            { 'ai-agent-timeline__decision': event.kind === 'decision' },
            { 'ai-agent-timeline__summary': event.kind === 'summary' },
          ]"
        >
          <details
            v-if="getTimelineTool(event, state)"
            class="ai-agent-tool-step"
            :open="getTimelineTool(event, state)?.status === 'failed'"
          >
            <summary>
              <span class="ai-agent-tool-step__marker" aria-hidden="true">
                <LoaderCircle
                  v-if="getTimelineTool(event, state)?.status === 'running'"
                  :size="13"
                  class="ai-agent-tool-list__spinner"
                />
                <CircleCheck
                  v-else-if="getTimelineTool(event, state)?.status === 'completed'"
                  :size="13"
                />
                <CircleX v-else :size="13" />
              </span>
              <span class="ai-agent-tool-step__copy">
                <strong>
                  <span class="ai-agent-timeline__kind">工具</span>
                  {{ getToolLabel(getTimelineTool(event, state)?.toolName ?? '') }}
                </strong>
                <small>{{
                  summarizeToolArguments(getTimelineTool(event, state)?.argumentsJson ?? '')
                }}</small>
              </span>
              <span class="ai-agent-tool-step__status">{{
                summarizeToolResult(getTimelineTool(event, state)!)
              }}</span>
              <time>{{
                formatToolDuration(
                  getTimelineTool(event, state)?.startedAt ?? event.occurredAt,
                  getTimelineTool(event, state)?.completedAt ?? event.completedAt,
                )
              }}</time>
              <ChevronDown :size="13" class="ai-agent-tool-step__chevron" aria-hidden="true" />
            </summary>
            <div class="ai-agent-tool-step__details">
              <section
                v-if="getToolInputFields(getTimelineTool(event, state)!).length"
                class="ai-agent-tool-step__section"
              >
                <strong>输入</strong>
                <dl class="ai-agent-tool-step__fields">
                  <template
                    v-for="field in getToolInputFields(getTimelineTool(event, state)!)"
                    :key="field.label"
                  >
                    <dt>{{ field.label }}</dt>
                    <dd>{{ field.value }}</dd>
                  </template>
                </dl>
              </section>
              <template v-if="getTimelineTool(event, state)?.error">
                <section class="ai-agent-tool-step__section">
                  <strong>错误</strong>
                  <p class="ai-agent-tool-list__error">
                    {{ getTimelineTool(event, state)?.error }}
                  </p>
                </section>
              </template>
              <section
                v-else-if="
                  getToolResultItems(getTimelineTool(event, state)!).length ||
                  getToolResultText(getTimelineTool(event, state)!)
                "
                class="ai-agent-tool-step__section"
              >
                <strong>结果</strong>
                <p v-if="getToolResultText(getTimelineTool(event, state)!)">
                  {{ getToolResultText(getTimelineTool(event, state)!) }}
                </p>
                <ul
                  v-if="getToolResultItems(getTimelineTool(event, state)!).length"
                  class="ai-agent-tool-results"
                >
                  <li
                    v-for="item in getToolResultItems(getTimelineTool(event, state)!)"
                    :key="`${item.documentId ?? item.url ?? ''}:${item.title}`"
                  >
                    <button
                      v-if="item.documentId"
                      type="button"
                      class="ai-agent-tool-results__document"
                      @click="emit('open-source', item.documentId, item.blockId)"
                    >
                      <FileText :size="13" aria-hidden="true" />
                      <span>{{ item.title }}</span>
                      <ChevronRight :size="12" aria-hidden="true" />
                    </button>
                    <a v-else-if="item.url" :href="item.url" target="_blank" rel="noreferrer">
                      <span>{{ item.title }}</span>
                      <ExternalLink :size="12" aria-hidden="true" />
                    </a>
                    <strong v-else>{{ item.title }}</strong>
                    <p v-if="item.description">{{ item.description }}</p>
                    <small v-if="item.documentId">
                      知识库文档{{ item.blockId ? ' · 已定位内容块' : '' }}
                    </small>
                    <small v-else-if="item.url">{{ item.url }}</small>
                  </li>
                </ul>
              </section>
              <details class="ai-agent-tool-step__raw">
                <summary>原始数据</summary>
                <span>工具</span>
                <code>{{ getTimelineTool(event, state)?.toolName }}</code>
                <template
                  v-if="formatToolDetail(getTimelineTool(event, state)?.argumentsJson ?? null)"
                >
                  <span>输入 JSON</span>
                  <pre>{{
                    formatToolDetail(getTimelineTool(event, state)?.argumentsJson ?? null)
                  }}</pre>
                </template>
                <template
                  v-if="formatToolDetail(getTimelineTool(event, state)?.resultJson ?? null)"
                >
                  <span>输出 JSON</span>
                  <pre>{{
                    formatToolDetail(getTimelineTool(event, state)?.resultJson ?? null)
                  }}</pre>
                </template>
              </details>
            </div>
          </details>
          <div
            v-if="
              getTimelineTool(event, state) && getToolResultPreview(getTimelineTool(event, state)!)
            "
            class="ai-agent-tool-step__preview"
          >
            <CornerDownRight :size="12" aria-hidden="true" />
            <span><b>输出</b>{{ getToolResultPreview(getTimelineTool(event, state)!) }}</span>
          </div>
          <div v-if="!getTimelineTool(event, state)" class="ai-agent-timeline__step">
            <span class="ai-agent-tool-step__marker" aria-hidden="true">
              <LoaderCircle
                v-if="event.status === 'running'"
                :size="13"
                class="ai-agent-tool-list__spinner"
              />
              <CircleCheck v-else-if="event.status === 'completed'" :size="13" />
              <CircleX v-else :size="13" />
            </span>
            <div class="ai-agent-timeline__copy">
              <strong>
                <span class="ai-agent-timeline__kind">{{ getTimelineEventLabel(event) }}</span>
                {{ getTimelineStepTitle(event) }}
              </strong>
              <span class="ai-agent-timeline__narrative">
                <p v-for="paragraph in getTimelineParagraphs(event)" :key="paragraph">
                  {{ paragraph }}
                </p>
              </span>
            </div>
          </div>
        </li>
      </ol>
    </details>

    <div class="ai-agent-loop__phase">
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
      <strong>{{ state.detail || step || '正在分析上下文' }}</strong>
    </div>
  </section>
</template>
