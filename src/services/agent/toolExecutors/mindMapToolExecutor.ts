import type {
  AgentToolExecutionContext,
  AgentToolExecutionResult,
  AgentToolRequest,
} from '@/services/agent/AgentToolExecutor'
import {
  readOptionalInteger,
  readOptionalString,
  readRequiredString,
} from './toolArgumentParsers'

export function executeMindMapTool(
  request: AgentToolRequest,
  context: AgentToolExecutionContext,
  toolName: string,
): Promise<AgentToolExecutionResult> | AgentToolExecutionResult {
  switch (toolName) {
    case 'list_mind_maps':
      return executeListMindMaps(context)
    case 'read_mind_map':
      return executeReadMindMap(request, context)
    default:
      return { ok: false, error: `思维导图工具 ${toolName} 未识别。` }
  }
}

async function executeListMindMaps(
  context: AgentToolExecutionContext,
): Promise<AgentToolExecutionResult> {
  if (!context.listMindMaps) return { ok: false, error: '当前环境未提供思维导图读取器。' }
  return { ok: true, value: await context.listMindMaps() }
}

async function executeReadMindMap(
  request: AgentToolRequest,
  context: AgentToolExecutionContext,
): Promise<AgentToolExecutionResult> {
  if (!context.readMindMap) return { ok: false, error: '当前环境未提供思维导图读取器。' }
  const mindMapId = readRequiredString(request.arguments.mindMapId, 'mindMapId')
  const nodeId = readOptionalString(request.arguments.nodeId, 'nodeId')
  const depth = readOptionalInteger(request.arguments.depth, 'depth', 0, 32)
  const maxNodes = readOptionalInteger(request.arguments.maxNodes, 'maxNodes', 1, 1_000)
  const value = await context.readMindMap(mindMapId, {
    ...(nodeId ? { nodeId } : {}),
    ...(depth === undefined ? {} : { depth }),
    ...(maxNodes === undefined ? {} : { maxNodes }),
    includeNotes: request.arguments.includeNotes === true,
    includeSources: request.arguments.includeSources === true,
  })
  return value
    ? { ok: true, value }
    : { ok: false, error: `思维导图 ${mindMapId} 不存在或不可读取。` }
}
