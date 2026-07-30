import type { AgentToolTag } from '@/models/cognitive/cognitive'

export type AgentToolRisk = 'read' | 'draft' | 'write'
export type AgentToolCallStatus = 'pending' | 'running' | 'completed' | 'failed' | 'rejected'
export type AgentAuthorizationRequirement = 'not_required' | 'required'

export interface AgentToolPresentationMetadata {
  label: string
  category: 'document' | 'knowledge' | 'system' | 'interaction' | 'external'
}

export interface AgentToolDefinition {
  name:
    | 'get_current_document'
    | 'get_selected_blocks'
    | 'get_document_outline'
    | 'search_documents'
    | 'list_document_groups'
    | 'read_document'
    | 'list_mind_maps'
    | 'read_mind_map'
    | 'find_blocks_by_regex'
    | 'read_skill_file'
    | 'read_personal_organizer'
    | 'upsert_personal_todo'
    | 'upsert_personal_calendar_event'
    | 'request_authorizer_input'
    | 'report_progress'
    | 'execute_shell'
    | 'inspect_environment_paths'
    | 'discover_local_tools'
    | 'get_system_info'
    | 'create_automation_draft'
    | 'create_mcp_server_draft'
    | 'create_skill_draft'
    | 'replace_text_by_regex'
    | 'replace_block'
    | 'insert_blocks'
    | 'create_document'
    | 'create_group'
    | 'submit_document_edits'
  description: string
  risk: AgentToolRisk
  executionAuthorization: AgentAuthorizationRequirement
  mutationApproval: AgentAuthorizationRequirement
  externalActionApproval: AgentAuthorizationRequirement
  maxCallsPerRun: number
  tags: AgentToolTag[]
  presentation: AgentToolPresentationMetadata
}

export interface AgentToolCall {
  id: string
  taskId: string
  runId: string
  turnId: string | null
  providerToolCallId: string | null
  toolName: string
  argumentsJson: string
  resultJson: string | null
  status: AgentToolCallStatus
  startedAt: number
  completedAt: number | null
  error: string | null
}
