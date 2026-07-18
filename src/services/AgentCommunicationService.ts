import { getDatabase } from '@/infrastructure/database/connection'

export interface AgentCommunicationRequest {
  id: string
  prompt: string
  mode: AgentCommunicationMode
  projectId: string | null
  branchId: string | null
  branchTitle: string | null
  parentConversationId: string | null
  status:
    | 'queued'
    | 'running'
    | 'awaiting_review'
    | 'approved'
    | 'rejected'
    | 'completed'
    | 'failed'
  taskId: string | null
  previousTaskId: string | null
  revisionFeedback: string | null
  revisionCount: number
  result: AgentCommunicationResult | null
  decision: AgentCommunicationDecision | null
}

export type AgentCommunicationMode = 'agent' | 'research' | 'review' | 'learning'

export interface AgentCommunicationResult {
  version: 1
  outcome: 'proposal' | 'no_change' | 'blocked'
  summary: string
  patchCount: number
  targetDocumentIds: string[]
  cognitive?: {
    mode: Exclude<AgentCommunicationMode, 'agent'>
    result: unknown
    state?: unknown
  }
  finishReason?: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
  }
}

export interface AgentCommunicationDecision {
  version: 1
  action: 'approve' | 'reject'
  reply: string
  requestId: string
  taskId: string
  resultVersion: 1 | null
  resultSummary: string
  decidedAt: number
}

interface AgentRequestRow {
  id: string
  prompt: string
  mode?: AgentCommunicationMode
  status: AgentCommunicationRequest['status']
  task_id: string | null
  previous_task_id?: string | null
  revision_feedback?: string | null
  revision_count?: number
  result_json?: string | null
  decision_json?: string | null
  project_id?: string | null
  branch_id?: string | null
  branch_title?: string | null
  parent_conversation_id?: string | null
}

const STALE_RUNNING_REQUEST_MS = 50 * 60 * 1_000
const AGENT_REQUEST_SELECT = `id, prompt, mode, status, task_id, previous_task_id,
  revision_feedback, revision_count, result_json, decision_json, project_id, branch_id,
  (SELECT title FROM agent_branches WHERE id = agent_requests.branch_id) AS branch_title,
  (SELECT parent_conversation_id FROM agent_branches WHERE id = agent_requests.branch_id)
    AS parent_conversation_id`

export class AgentCommunicationService {
  async claimNext(): Promise<AgentCommunicationRequest | null> {
    const database = await getDatabase()
    const staleRunningBefore = Date.now() - STALE_RUNNING_REQUEST_MS
    const rows = await database.select<AgentRequestRow>(
      `SELECT ${AGENT_REQUEST_SELECT} FROM agent_requests
       WHERE previous_task_id IS NULL AND (status = 'queued'
          OR (status = 'running' AND task_id IS NULL AND updated_at < ?))
       ORDER BY created_at ASC LIMIT 1`,
      [staleRunningBefore],
    )
    const row = rows[0]
    if (!row) return null
    const result = await database.execute(
      `UPDATE agent_requests SET status = 'running', updated_at = ?
       WHERE id = ? AND (
         status = 'queued' OR (status = 'running' AND task_id IS NULL AND updated_at < ?)
       )`,
      [Date.now(), row.id, staleRunningBefore],
    )
    if (result.rowsAffected !== 1) return null
    return mapRequest({ ...row, status: 'running' })
  }

  async claimRevisionForTask(taskId: string): Promise<AgentCommunicationRequest | null> {
    const database = await getDatabase()
    const staleRunningBefore = Date.now() - STALE_RUNNING_REQUEST_MS
    const rows = await database.select<AgentRequestRow>(
      `SELECT ${AGENT_REQUEST_SELECT} FROM agent_requests
       WHERE previous_task_id = ? AND (
         status = 'queued' OR (status = 'running' AND task_id IS NULL AND updated_at < ?)
       )
       ORDER BY updated_at ASC LIMIT 1`,
      [taskId, staleRunningBefore],
    )
    const row = rows[0]
    if (!row) return null
    const result = await database.execute(
      `UPDATE agent_requests SET status = 'running', updated_at = ?
       WHERE id = ? AND previous_task_id = ? AND (
         status = 'queued' OR (status = 'running' AND task_id IS NULL AND updated_at < ?)
       )`,
      [Date.now(), row.id, taskId, staleRunningBefore],
    )
    if (result.rowsAffected !== 1) return null
    return mapRequest({ ...row, status: 'running' })
  }

  async findDecisionForTask(taskId: string): Promise<AgentCommunicationRequest | null> {
    const database = await getDatabase()
    const rows = await database.select<AgentRequestRow>(
      `SELECT ${AGENT_REQUEST_SELECT} FROM agent_requests
       WHERE task_id = ? AND status IN ('approved', 'rejected')
       ORDER BY updated_at ASC LIMIT 1`,
      [taskId],
    )
    return rows[0] ? mapRequest(rows[0]) : null
  }

  async findFailedForTask(taskId: string): Promise<AgentCommunicationRequest | null> {
    const database = await getDatabase()
    const rows = await database.select<AgentRequestRow>(
      `SELECT ${AGENT_REQUEST_SELECT} FROM agent_requests
       WHERE task_id = ? AND status = 'failed' ORDER BY updated_at DESC LIMIT 1`,
      [taskId],
    )
    return rows[0] ? mapRequest(rows[0]) : null
  }

  async listRecentCompleted(limit = 20): Promise<AgentCommunicationRequest[]> {
    const database = await getDatabase()
    const rows = await database.select<AgentRequestRow>(
      `SELECT ${AGENT_REQUEST_SELECT} FROM agent_requests
       WHERE status = 'completed' ORDER BY completed_at DESC LIMIT ?`,
      [Math.max(1, Math.min(limit, 100))],
    )
    return rows.map(mapRequest)
  }

  async markAwaitingReview(
    id: string,
    taskId: string,
    result: AgentCommunicationResult,
  ): Promise<void> {
    await this.update(id, 'awaiting_review', taskId, null, null, result)
  }

  async markCompleted(
    id: string,
    taskId: string | null,
    result: AgentCommunicationResult | null = null,
  ): Promise<void> {
    await this.update(id, 'completed', taskId, null, Date.now(), result)
  }

  async markFailed(id: string, taskId: string | null, error: string): Promise<void> {
    await this.update(id, 'failed', taskId, error.slice(0, 2_000), Date.now(), null)
  }

  private async update(
    id: string,
    status: AgentCommunicationRequest['status'],
    taskId: string | null,
    error: string | null,
    completedAt: number | null,
    result: AgentCommunicationResult | null,
  ): Promise<void> {
    const database = await getDatabase()
    await database.execute(
      `UPDATE agent_requests SET status = ?, task_id = COALESCE(?, task_id), error = ?,
       result_json = COALESCE(?, result_json), updated_at = ?, completed_at = ? WHERE id = ?`,
      [status, taskId, error, result ? JSON.stringify(result) : null, Date.now(), completedAt, id],
    )
  }
}

function mapRequest(row: AgentRequestRow): AgentCommunicationRequest {
  return {
    id: row.id,
    prompt: row.prompt,
    mode: row.mode ?? 'agent',
    projectId: row.project_id ?? null,
    branchId: row.branch_id ?? null,
    branchTitle: row.branch_title ?? null,
    parentConversationId: row.parent_conversation_id ?? null,
    status: row.status,
    taskId: row.task_id,
    previousTaskId: row.previous_task_id ?? null,
    revisionFeedback: row.revision_feedback ?? null,
    revisionCount: row.revision_count ?? 0,
    result: parseResult(row.result_json),
    decision: parseDecision(row.decision_json),
  }
}

function parseResult(value: string | null | undefined): AgentCommunicationResult | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as AgentCommunicationResult
    return parsed?.version === 1 ? parsed : null
  } catch {
    return null
  }
}

function parseDecision(value: string | null | undefined): AgentCommunicationDecision | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as AgentCommunicationDecision
    return parsed?.version === 1 ? parsed : null
  } catch {
    return null
  }
}
