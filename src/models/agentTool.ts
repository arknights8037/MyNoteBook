export type AgentToolRisk = 'read' | 'write'
export type AgentToolCallStatus = 'pending' | 'running' | 'completed' | 'failed' | 'rejected'

export interface AgentToolDefinition {
  name:
    | 'get_current_document'
    | 'get_selected_blocks'
    | 'get_document_outline'
    | 'search_documents'
    | 'read_document'
    | 'find_blocks_by_regex'
    | 'replace_text_by_regex'
    | 'replace_block'
    | 'insert_blocks'
    | 'create_document'
  description: string
  risk: AgentToolRisk
  requiresConfirmation: boolean
  maxCallsPerTask: number
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
