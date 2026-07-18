import type { AgentTimelineEvent } from '@/models/agentRuntime'
import type { AgentToolCall } from '@/models/agentTool'
import type { ExecutionPolicy } from '@/models/executionPolicy'

export function getToolProgressLabel(name: string, completed: boolean): string {
  const labels: Record<string, [string, string]> = {
    get_current_document: ['正在读取当前页面', '已读取当前页面'],
    get_selected_blocks: ['正在确认选中的内容', '已确认选中的内容'],
    get_document_outline: ['正在查看页面结构', '已查看页面结构'],
    search_documents: ['正在知识库中查找资料', '已完成知识库检索'],
    list_document_groups: ['正在查找文档分组', '已找到文档分组'],
    read_document: ['正在阅读相关资料', '已读取相关资料'],
    find_blocks_by_regex: ['正在定位需要修改的内容', '已定位需要修改的内容'],
    read_skill_file: ['正在读取技能资料', '已读取技能资料'],
    request_authorizer_input: ['正在等待授权人决策', '已收到授权人回答'],
    execute_shell: ['正在执行受限本机命令', '受限本机命令已完成'],
    inspect_environment_paths: ['正在检查环境路径', '已检查环境路径'],
    discover_local_tools: ['正在发现本机工具', '已发现本机工具'],
    get_system_info: ['正在读取系统信息', '已读取系统信息'],
    create_automation_draft: ['正在确认自动化草稿', '已创建自动化草稿'],
    create_skill_draft: ['正在确认 Skill 草稿', '已创建 Skill 草稿'],
    replace_text_by_regex: ['正在提交文本替换提案', '文本替换提案已就绪'],
    replace_block: ['正在提交块修改提案', '块修改提案已就绪'],
    insert_blocks: ['正在提交内容插入提案', '内容插入提案已就绪'],
    create_document: ['正在生成文档提案', '文档提案已就绪'],
    create_group: ['正在生成分组提案', '分组提案已就绪'],
    submit_document_edits: ['正在提交多文档修改提案', '多文档修改提案已就绪'],
  }
  return labels[name]?.[completed ? 1 : 0] ?? (completed ? '工具调用已完成' : '正在调用工具')
}

export function getToolFailureProgressLabel(name: string): string {
  return `${getToolProgressLabel(name, false).replace(/^正在/, '')}失败`
}

export function policyAllowsToolName(
  name: string,
  policy: ExecutionPolicy,
): boolean {
  return (
    policy.allowedTools.includes(name) ||
    (name.startsWith('mcp__') && policy.allowedTools.includes('mcp:*'))
  )
}

export function createToolTimelineEvent(
  call: AgentToolCall,
  detail: string,
): AgentTimelineEvent {
  return {
    id: `tool:${call.id}`,
    kind: 'tool',
    status:
      call.status === 'running' ? 'running' : call.status === 'completed' ? 'completed' : 'failed',
    detail,
    occurredAt: call.startedAt,
    completedAt: call.completedAt,
    toolCallId: call.id,
  }
}

export function createToolCallSignature(name: string, args: Record<string, unknown>): string {
  return `${name}:${stableJson(args)}`
}

export function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw normalizeAbortError(signal.reason)
  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      globalThis.clearTimeout(timeout)
      reject(normalizeAbortError(signal?.reason))
    }
    const timeout = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort)
      resolve()
    }, delayMs)
    signal?.addEventListener('abort', handleAbort, { once: true })
  })
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function normalizeAbortError(reason: unknown): Error {
  if (reason instanceof Error && reason.name === 'AbortError') return reason
  const error = new Error('Agent Provider 请求已取消。')
  error.name = 'AbortError'
  return error
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
