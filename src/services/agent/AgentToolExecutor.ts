import type { SelectedBlock } from '@/models/agent/agent'
import type { DocumentRecord, DocumentSummary } from '@/models/documents/document'
import type { MindMapSubtreeQuery, MindMapSubtreeResult, MindMapSummary } from '@/models/workspace/mindMap'
import type { AgentAuthorizationRequest } from '@/models/agent/agentRuntime'
import type { AutomationTriggerConfig, AutomationTriggerType } from '@/models/automation/automation'
import type { McpTransport } from '@/models/integrations/mcp'
import { getAgentToolDefinition } from '@/services/agent/AgentToolRegistry'
import { throwIfAgentToolAborted } from '@/services/agent/AgentToolCancellation'

import { executeDocumentTool } from './toolExecutors/documentToolExecutor'
import { executeMindMapTool } from './toolExecutors/mindMapToolExecutor'
import { executeSystemTool } from './toolExecutors/systemToolExecutor'
import { executeInteractiveTool } from './toolExecutors/interactiveToolExecutor'
import { executeDraftTool } from './toolExecutors/draftToolExecutor'

export { prepareReadDocumentObservation } from './toolExecutors/documentToolExecutor'

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
    markdown: string
    blocks: SelectedBlock[]
  }
  selectedBlocks: SelectedBlock[]
  workspaceRootIds?: string[]
  workspaceDocumentIds?: string[]
  onDocumentsDiscovered?: (documentIds: string[], scope: 'workspace' | 'global') => void
  canReadDocument?: (documentId: string) => boolean
  searchDocuments: (query: string, limit: number) => Promise<DocumentSummary[]>
  readDocument: (documentId: string) => Promise<DocumentRecord | null>
  listMindMaps?: () => Promise<MindMapSummary[]>
  readMindMap?: (
    mindMapId: string,
    query: MindMapSubtreeQuery,
  ) => Promise<MindMapSubtreeResult | null>
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
  createMcpServerDraft?: (input: {
    name: string
    transport: McpTransport
    command?: string
    args?: string[]
    cwd?: string
    url?: string
  }) => Promise<unknown>
}

export interface AgentToolExecutionResult {
  ok: boolean
  value?: unknown
  error?: string
  errorCode?: string
  retryable?: boolean
  retryAfterMs?: number
}

const DOCUMENT_TOOLS = new Set([
  'get_current_document',
  'get_selected_blocks',
  'get_document_outline',
  'search_documents',
  'list_document_groups',
  'read_document',
  'find_blocks_by_regex',
])

const MIND_MAP_TOOLS = new Set(['list_mind_maps', 'read_mind_map'])

const SYSTEM_TOOLS = new Set([
  'execute_shell',
  'inspect_environment_paths',
  'discover_local_tools',
  'get_system_info',
])

const INTERACTIVE_TOOLS = new Set(['request_authorizer_input', 'read_skill_file'])

const DRAFT_TOOLS = new Set(['create_automation_draft', 'create_skill_draft', 'create_mcp_server_draft'])

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
    if (DOCUMENT_TOOLS.has(definition.name)) {
      return await executeDocumentTool(request, context, definition.name)
    }
    if (MIND_MAP_TOOLS.has(definition.name)) {
      return await executeMindMapTool(request, context, definition.name)
    }
    if (SYSTEM_TOOLS.has(definition.name)) {
      return await executeSystemTool(request, context, definition.name)
    }
    if (INTERACTIVE_TOOLS.has(definition.name)) {
      return await executeInteractiveTool(request, context, definition.name)
    }
    if (DRAFT_TOOLS.has(definition.name)) {
      return await executeDraftTool(request, context, definition.name)
    }
    return { ok: false, error: `工具 ${definition.name} 尚未接入执行器。` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const transientDatabaseFailure =
      /(?:database|sqlite).*(?:busy|locked)|(?:busy|locked).*(?:database|sqlite)/i.test(message)
    return {
      ok: false,
      error: message,
      ...(transientDatabaseFailure
        ? { errorCode: 'database_busy', retryable: true, retryAfterMs: 250 }
        : {}),
    }
  }
}
