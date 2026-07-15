import type { SelectedBlock } from '@/models/agent'
import type { DocumentRecord, DocumentSummary } from '@/models/document'
import type { AgentAuthorizationRequest } from '@/models/agentRuntime'
import type { AutomationTriggerConfig, AutomationTriggerType } from '@/models/automation'
import { getAgentToolDefinition } from './AgentToolRegistry'
import { throwIfAgentToolAborted } from './AgentToolCancellation'

export interface AgentToolRequest {
  callId?: string
  name: string
  arguments: Record<string, unknown>
  signal?: AbortSignal
}

export interface AgentToolExecutionContext {
  currentDocument: {
    id: string
    title: string
    revision: number | null
    text: string
    blocks: SelectedBlock[]
  }
  selectedBlocks: SelectedBlock[]
  searchDocuments: (query: string, limit: number) => Promise<DocumentSummary[]>
  readDocument: (documentId: string) => Promise<DocumentRecord | null>
  onDocumentRead?: (documentId: string, document: unknown) => Promise<void> | void
  executeNativeTool?: (
    name:
      | 'search_documents'
      | 'list_document_groups'
      | 'read_document'
      | 'find_blocks_by_regex'
      | 'read_skill_file'
      | 'execute_shell'
      | 'inspect_environment_paths'
      | 'discover_local_tools'
      | 'get_system_info',
    args: Record<string, unknown>,
    callId?: string,
    signal?: AbortSignal,
  ) => Promise<unknown>
  requestAuthorizerInput?: (request: Omit<AgentAuthorizationRequest, 'id'>) => Promise<string>
  createAutomationDraft?: (input: {
    name: string
    instruction: string
    triggerType: AutomationTriggerType
    triggerConfig: AutomationTriggerConfig
    documentId: string | null
  }) => Promise<unknown>
  createSkillDraft?: (input: {
    name: string
    description: string
    instructions: string
  }) => Promise<unknown>
}

export interface AgentToolExecutionResult {
  ok: boolean
  value?: unknown
  error?: string
}

export async function executeAgentTool(
  request: AgentToolRequest,
  context: AgentToolExecutionContext,
): Promise<AgentToolExecutionResult> {
  throwIfAgentToolAborted(request.signal)
  const definition = getAgentToolDefinition(request.name)
  if (!definition) return { ok: false, error: `工具 ${request.name} 不在白名单中。` }
  if (definition.risk === 'write') {
    return {
      ok: false,
      error: `写入提案工具 ${request.name} 应由 Agent Runtime 捕获，不能作为数据库写入工具直接执行。`,
    }
  }

  try {
    switch (definition.name) {
      case 'get_current_document':
        return { ok: true, value: context.currentDocument }
      case 'get_selected_blocks':
        return { ok: true, value: context.selectedBlocks }
      case 'get_document_outline':
        return {
          ok: true,
          value: context.currentDocument.blocks
            .filter((block) => block.type === 'heading')
            .map((block) => ({ id: block.id, text: block.text, index: block.index })),
        }
      case 'search_documents': {
        const query = readRequiredString(request.arguments.query, 'query')
        const limit = readLimit(request.arguments.limit, 5)
        if (context.executeNativeTool) {
          return {
            ok: true,
            value: await context.executeNativeTool(
              'search_documents',
              { query, limit },
              request.callId,
              request.signal,
            ),
          }
        }
        const documents = await context.searchDocuments(query, limit)
        return {
          ok: true,
          value: documents.map((document) => ({
            id: document.id,
            title: document.title,
            snippet: document.plainText.slice(0, 500),
            revision: document.revision,
          })),
        }
      }
      case 'list_document_groups': {
        if (!context.executeNativeTool) {
          return { ok: false, error: '当前环境未提供分组读取器。' }
        }
        const query = readOptionalString(request.arguments.query, 'query')
        return {
          ok: true,
          value: await context.executeNativeTool(
            'list_document_groups',
            { query },
            request.callId,
            request.signal,
          ),
        }
      }
      case 'read_document': {
        const documentId = readRequiredString(request.arguments.documentId, 'documentId')
        if (context.executeNativeTool) {
          const document = await context.executeNativeTool(
            'read_document',
            { documentId },
            request.callId,
            request.signal,
          )
          if (document) await context.onDocumentRead?.(documentId, document)
          return document
            ? { ok: true, value: document }
            : { ok: false, error: `文档 ${documentId} 不存在或不可读取。` }
        }
        const document = await context.readDocument(documentId)
        if (document) await context.onDocumentRead?.(documentId, document)
        return document
          ? {
              ok: true,
              value: {
                id: document.id,
                title: document.title,
                plainText: document.plainText.slice(0, 12_000),
                revision: document.revision,
                tags: document.tags,
              },
            }
          : { ok: false, error: `文档 ${documentId} 不存在或不可读取。` }
      }
      case 'find_blocks_by_regex': {
        const pattern = readRequiredString(request.arguments.pattern, 'pattern')
        if (pattern.length > 240) throw new Error('正则表达式不得超过 240 个字符。')
        const flags = normalizeRegexFlags(request.arguments.flags)
        if (!context.executeNativeTool) {
          return { ok: false, error: '当前环境未提供安全正则匹配器。' }
        }
        return {
          ok: true,
          value: await context.executeNativeTool(
            'find_blocks_by_regex',
            { pattern, flags, blocks: context.currentDocument.blocks },
            request.callId,
            request.signal,
          ),
        }
      }
      case 'read_skill_file': {
        if (!context.executeNativeTool) {
          return { ok: false, error: '当前环境未提供技能文件读取器。' }
        }
        const skillId = readRequiredString(request.arguments.skillId, 'skillId')
        const relativePath = readRequiredString(request.arguments.relativePath, 'relativePath')
        return {
          ok: true,
          value: await context.executeNativeTool(
            'read_skill_file',
            { skillId, relativePath },
            request.callId,
            request.signal,
          ),
        }
      }
      case 'request_authorizer_input': {
        if (!context.requestAuthorizerInput) {
          return { ok: false, error: '当前界面未提供授权人互动通道。' }
        }
        const question = readRequiredString(request.arguments.question, 'question')
        const contextDescription = readOptionalString(request.arguments.context, 'context')
        const options = readStringArray(request.arguments.options, 'options', 5).filter(Boolean)
        const allowFreeText = request.arguments.allowFreeText !== false || options.length === 0
        return {
          ok: true,
          value: {
            answer: await context.requestAuthorizerInput({
              question,
              context: contextDescription,
              options,
              allowFreeText,
            }),
          },
        }
      }
      case 'execute_shell': {
        if (!context.executeNativeTool) {
          return { ok: false, error: '当前环境未提供本机命令执行器。' }
        }
        const command = readRequiredString(request.arguments.command, 'command')
        const args = readStringArray(request.arguments.args, 'args')
        const timeoutMs = readOptionalInteger(
          request.arguments.timeoutMs,
          'timeoutMs',
          1_000,
          30_000,
        )
        const maxOutputChars = readOptionalInteger(
          request.arguments.maxOutputChars,
          'maxOutputChars',
          4_096,
          65_536,
        )
        return {
          ok: true,
          value: await context.executeNativeTool(
            'execute_shell',
            {
              command,
              args,
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
              ...(maxOutputChars === undefined ? {} : { maxOutputChars }),
            },
            request.callId,
            request.signal,
          ),
        }
      }
      case 'inspect_environment_paths':
      case 'get_system_info': {
        if (!context.executeNativeTool) {
          return { ok: false, error: '当前环境未提供本机信息执行器。' }
        }
        return {
          ok: true,
          value: await context.executeNativeTool(
            definition.name,
            {},
            request.callId,
            request.signal,
          ),
        }
      }
      case 'discover_local_tools': {
        if (!context.executeNativeTool) {
          return { ok: false, error: '当前环境未提供本机工具发现执行器。' }
        }
        const names = readStringArray(request.arguments.names, 'names', 32)
        return {
          ok: true,
          value: await context.executeNativeTool(
            'discover_local_tools',
            { names },
            request.callId,
            request.signal,
          ),
        }
      }
      case 'create_automation_draft': {
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
          `创建自动化草稿“${name}”？`,
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
      case 'create_skill_draft': {
        if (!context.createSkillDraft) {
          return { ok: false, error: '当前环境未提供 Skill 草稿创建器。' }
        }
        const name = readRequiredString(request.arguments.name, 'name')
        const description = readRequiredString(request.arguments.description, 'description')
        const instructions = readRequiredString(request.arguments.instructions, 'instructions')
        const confirmed = await confirmDraftCreation(
          context,
          `创建 Skill 草稿“${name}”？`,
          '将写入本地 skills 目录并保持停用；你可以在插件技能页审阅和启用。',
        )
        if (!confirmed) return { ok: true, value: { created: false, reason: '用户取消创建。' } }
        throwIfAgentToolAborted(request.signal)
        return {
          ok: true,
          value: await context.createSkillDraft({ name, description, instructions }),
        }
      }
      default:
        return { ok: false, error: `工具 ${definition.name} 尚未接入执行器。` }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

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

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`工具参数 ${field} 不能为空。`)
  return value.trim()
}

function readOptionalString(value: unknown, field: string): string {
  if (value === undefined) return ''
  if (typeof value !== 'string') throw new Error(`工具参数 ${field} 必须是字符串。`)
  return value.trim()
}

function readLimit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(Math.round(value), 10))
    : fallback
}

function normalizeRegexFlags(value: unknown): string {
  const flags = typeof value === 'string' ? value.replace(/[^gim]/g, '') : ''
  return Array.from(new Set(flags.split(''))).join('')
}

function readStringArray(value: unknown, field: string, maxItems = 12): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`工具参数 ${field} 必须是字符串数组。`)
  }
  if (value.length > maxItems) throw new Error(`工具参数 ${field} 最多包含 ${maxItems} 项。`)
  return value as string[]
}

function readOptionalInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`工具参数 ${field} 必须是 ${minimum} 到 ${maximum} 之间的整数。`)
  }
  return value
}
