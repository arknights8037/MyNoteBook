import type { AutomationTriggerConfig, AutomationTriggerType } from '@/models/automation/automation'
import type { McpTransport } from '@/models/integrations/mcp'
import type {
  AgentToolExecutionContext,
  AgentToolExecutionResult,
  AgentToolRequest,
} from '@/services/agent/AgentToolExecutor'
import { throwIfAgentToolAborted } from '@/services/agent/AgentToolCancellation'
import {
  readOptionalInteger,
  readOptionalString,
  readRequiredString,
  readStringArray,
} from './toolArgumentParsers'

export function executeDraftTool(
  request: AgentToolRequest,
  context: AgentToolExecutionContext,
  toolName: string,
): Promise<AgentToolExecutionResult> | AgentToolExecutionResult {
  switch (toolName) {
    case 'create_automation_draft':
      return executeCreateAutomationDraft(request, context)
    case 'create_skill_draft':
      return executeCreateSkillDraft(request, context)
    case 'create_mcp_server_draft':
      return executeCreateMcpServerDraft(request, context)
    default:
      return { ok: false, error: `草稿工具 ${toolName} 未识别。` }
  }
}

async function executeCreateAutomationDraft(
  request: AgentToolRequest,
  context: AgentToolExecutionContext,
): Promise<AgentToolExecutionResult> {
  if (!context.createAutomationDraft) {
    return { ok: false, error: '当前环境未提供自动化草稿创建器。' }
  }
  const name = readRequiredString(request.arguments.name, 'name')
  const instruction = readRequiredString(request.arguments.instruction, 'instruction')
  const triggerType = readAutomationTriggerType(request.arguments.triggerType)
  const triggerConfig = readAutomationTriggerConfig(triggerType, request.arguments)
  const bindCurrentDocument = request.arguments.bindCurrentDocument !== false
  const confirmed = await confirmDraftCreation(
    context,
    `创建自动化草稿"${name}"？`,
    describeAutomationDraft(triggerType, triggerConfig),
  )
  if (!confirmed) return { ok: true, value: { created: false, reason: '用户取消创建。' } }
  throwIfAgentToolAborted(request.signal)
  return {
    ok: true,
    value: await context.createAutomationDraft({
      name,
      instruction,
      triggerType,
      triggerConfig,
      documentId: bindCurrentDocument ? context.currentDocument.id : null,
    }),
  }
}

async function executeCreateSkillDraft(
  request: AgentToolRequest,
  context: AgentToolExecutionContext,
): Promise<AgentToolExecutionResult> {
  if (!context.createSkillDraft) {
    return { ok: false, error: '当前环境未提供 Skill 草稿创建器。' }
  }
  const name = readRequiredString(request.arguments.name, 'name')
  const description = readRequiredString(request.arguments.description, 'description')
  const instructions = readRequiredString(request.arguments.instructions, 'instructions')
  const confirmed = await confirmDraftCreation(
    context,
    `创建 Skill 草稿"${name}"？`,
    '将写入本地 skills 目录并保持停用；你可以在插件技能页审阅和启用。',
  )
  if (!confirmed) return { ok: true, value: { created: false, reason: '用户取消创建。' } }
  throwIfAgentToolAborted(request.signal)
  return {
    ok: true,
    value: await context.createSkillDraft({ name, description, instructions }),
  }
}

async function executeCreateMcpServerDraft(
  request: AgentToolRequest,
  context: AgentToolExecutionContext,
): Promise<AgentToolExecutionResult> {
  if (!context.createMcpServerDraft) {
    return { ok: false, error: '当前环境未提供 MCP 草稿创建器。' }
  }
  const name = readRequiredString(request.arguments.name, 'name')
  const transport = readMcpTransport(request.arguments.transport)
  const command = readOptionalString(request.arguments.command, 'command')
  const args = readStringArray(request.arguments.args, 'args', 64)
  const cwd = readOptionalString(request.arguments.cwd, 'cwd')
  const url = readOptionalString(request.arguments.url, 'url')
  if (transport === 'stdio' && !command) throw new Error('stdio MCP 必须提供 command。')
  if (transport === 'http' && !url) throw new Error('HTTP MCP 必须提供 url。')
  const endpoint = transport === 'stdio' ? `${command} ${args.join(' ')}`.trim() : url!
  const confirmed = await confirmDraftCreation(
    context,
    `添加 MCP 服务草稿"${name}"？`,
    `${transport}：${endpoint}。配置将保持停用且未信任，不会在本次任务中连接或加载。`,
  )
  if (!confirmed) return { ok: true, value: { created: false, reason: '用户取消创建。' } }
  throwIfAgentToolAborted(request.signal)
  return {
    ok: true,
    value: await context.createMcpServerDraft({
      name,
      transport,
      ...(command ? { command } : {}),
      ...(args.length ? { args } : {}),
      ...(cwd ? { cwd } : {}),
      ...(url ? { url } : {}),
    }),
  }
}

// --- Helpers ---

async function confirmDraftCreation(
  context: AgentToolExecutionContext,
  question: string,
  description: string,
): Promise<boolean> {
  if (!context.requestAuthorizerInput) throw new Error('当前界面未提供草稿创建确认通道。')
  const answer = await context.requestAuthorizerInput({
    question,
    context: description,
    options: ['创建停用草稿', '取消'],
    allowFreeText: false,
  })
  return answer === '创建停用草稿'
}

function readAutomationTriggerType(value: unknown): AutomationTriggerType {
  if (value === 'manual' || value === 'interval' || value === 'daily') return value
  throw new Error('工具参数 triggerType 必须是 manual、interval 或 daily。')
}

function readMcpTransport(value: unknown): McpTransport {
  if (value === 'stdio' || value === 'http') return value
  throw new Error('工具参数 transport 必须是 stdio 或 http。')
}

function readAutomationTriggerConfig(
  triggerType: AutomationTriggerType,
  args: Record<string, unknown>,
): AutomationTriggerConfig {
  if (triggerType === 'interval') {
    const intervalMinutes = readOptionalInteger(args.intervalMinutes, 'intervalMinutes', 5, 10_080)
    if (intervalMinutes === undefined) throw new Error('间隔自动化需要 intervalMinutes。')
    return { intervalMinutes }
  }
  if (triggerType === 'daily') {
    const dailyTime = readRequiredString(args.dailyTime, 'dailyTime')
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(dailyTime)) {
      throw new Error('工具参数 dailyTime 必须是 HH:mm 格式。')
    }
    return { dailyTime }
  }
  return {}
}

function describeAutomationDraft(
  triggerType: AutomationTriggerType,
  config: AutomationTriggerConfig,
): string {
  const schedule =
    triggerType === 'interval'
      ? `建议每 ${config.intervalMinutes} 分钟运行`
      : triggerType === 'daily'
        ? `建议每天 ${config.dailyTime} 运行`
        : '手动触发'
  return `${schedule}。草稿将保持停用，不会自动排期或运行。`
}
