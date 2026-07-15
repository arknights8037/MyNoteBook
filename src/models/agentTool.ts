import type { AgentToolTag } from './cognitive'

export type AgentToolRisk = 'read' | 'draft' | 'write'
export type AgentToolCallStatus = 'pending' | 'running' | 'completed' | 'failed' | 'rejected'

export interface AgentToolDefinition {
  name:
    | 'get_current_document'
    | 'get_selected_blocks'
    | 'get_document_outline'
    | 'search_documents'
    | 'list_document_groups'
    | 'read_document'
    | 'find_blocks_by_regex'
    | 'read_skill_file'
    | 'request_authorizer_input'
    | 'execute_shell'
    | 'inspect_environment_paths'
    | 'discover_local_tools'
    | 'get_system_info'
    | 'create_automation_draft'
    | 'create_skill_draft'
    | 'replace_text_by_regex'
    | 'replace_block'
    | 'insert_blocks'
    | 'create_document'
    | 'create_group'
    | 'propose_document_patches'
  description: string
  risk: AgentToolRisk
  requiresConfirmation: boolean
  maxCallsPerTask: number
  tags: AgentToolTag[]
}

export interface AgentToolCall {
  id: string
  taskId: string
  toolName: string
  argumentsJson: string
  resultJson: string | null
  status: AgentToolCallStatus
  startedAt: number
  completedAt: number | null
  error: string | null
}
