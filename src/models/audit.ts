export type AuditCategory =
  | 'agent_task'
  | 'tool_call'
  | 'confirmation'
  | 'automation_run'
  | 'task_run'
  | 'knowledge'
  | 'verification'
  | 'change_set'
  | 'approval'
  | 'view_refresh'
  | 'delegation'
  | 'domain_event'
  | 'outbox'
export type AuditSeverity = 'info' | 'success' | 'warning' | 'error'

export interface AuditEntry {
  id: string
  category: AuditCategory
  entityId: string
  title: string
  summary: string
  status: string
  severity: AuditSeverity
  detailsJson: string | null
  createdAt: number
  completedAt: number | null
}

export interface AuditQuery {
  category?: AuditCategory | 'all'
  search?: string
  limit?: number
}
