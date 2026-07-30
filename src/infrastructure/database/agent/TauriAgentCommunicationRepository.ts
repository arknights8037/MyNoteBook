import type {
  AgentCommunicationDecision,
  AgentCommunicationMode,
  AgentCommunicationRepository,
  AgentCommunicationRequest,
  AgentCommunicationResult,
  AgentCommunicationStatus,
} from '@/repositories/agent/AgentCommunicationRepository'
import type { SqlClient } from '@/repositories/shared/SqlClient'
import { parseVersionedJson } from '@/repositories/shared/jsonCodec'
import { invoke } from '@tauri-apps/api/core'
import { loadAppSettings } from '@/models/settings/settings'

interface AgentRequestRow extends Record<string, unknown> {
  id: string
  prompt: string
  mode?: AgentCommunicationMode
  status: AgentCommunicationStatus
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

const AGENT_REQUEST_SELECT = `id, prompt, mode, status, task_id, previous_task_id,
  revision_feedback, revision_count, result_json, decision_json, project_id, branch_id,
  (SELECT title FROM agent_branches WHERE id = agent_requests.branch_id) AS branch_title,
  (SELECT parent_conversation_id FROM agent_branches WHERE id = agent_requests.branch_id)
    AS parent_conversation_id`

export class TauriAgentCommunicationRepository implements AgentCommunicationRepository {
  constructor(
    private readonly database: SqlClient,
    private readonly now: () => number = Date.now,
  ) {}

  async claimNext(): Promise<AgentCommunicationRequest | null> {
    return invoke<AgentCommunicationRequest | null>('claim_agent_request', {
      input: { dataDirectory: loadAppSettings().dataDirectory, previousTaskId: null },
    })
  }

  async claimRevisionForTask(taskId: string): Promise<AgentCommunicationRequest | null> {
    return invoke<AgentCommunicationRequest | null>('claim_agent_request', {
      input: { dataDirectory: loadAppSettings().dataDirectory, previousTaskId: taskId },
    })
  }

  async findDecisionForTask(taskId: string): Promise<AgentCommunicationRequest | null> {
    const rows = await this.database.select<AgentRequestRow>(
      `SELECT ${AGENT_REQUEST_SELECT} FROM agent_requests
       WHERE task_id = ? AND status IN ('approved', 'rejected')
       ORDER BY updated_at ASC LIMIT 1`,
      [taskId],
    )
    return rows[0] ? mapRequest(rows[0]) : null
  }

  async findFailedForTask(taskId: string): Promise<AgentCommunicationRequest | null> {
    const rows = await this.database.select<AgentRequestRow>(
      `SELECT ${AGENT_REQUEST_SELECT} FROM agent_requests
       WHERE task_id = ? AND status = 'failed' ORDER BY updated_at DESC LIMIT 1`,
      [taskId],
    )
    return rows[0] ? mapRequest(rows[0]) : null
  }

  async listRecentCompleted(limit = 20): Promise<AgentCommunicationRequest[]> {
    const rows = await this.database.select<AgentRequestRow>(
      `SELECT ${AGENT_REQUEST_SELECT} FROM agent_requests
       WHERE status = 'completed' ORDER BY completed_at DESC LIMIT ?`,
      [Math.max(1, Math.min(limit, 100))],
    )
    return rows.map(mapRequest)
  }

  markAwaitingReview(id: string, taskId: string, result: AgentCommunicationResult): Promise<void> {
    return this.update(id, 'awaiting_review', taskId, null, null, result)
  }

  markCompleted(
    id: string,
    taskId: string | null,
    result: AgentCommunicationResult | null = null,
  ): Promise<void> {
    return this.update(id, 'completed', taskId, null, this.now(), result)
  }

  markFailed(id: string, taskId: string | null, error: string): Promise<void> {
    return this.update(id, 'failed', taskId, error.slice(0, 2_000), this.now(), null)
  }

  private async update(
    id: string,
    status: AgentCommunicationStatus,
    taskId: string | null,
    error: string | null,
    completedAt: number | null,
    result: AgentCommunicationResult | null,
  ): Promise<void> {
    await invoke('settle_agent_request', {
      input: {
        dataDirectory: loadAppSettings().dataDirectory,
        id,
        status,
        taskId,
        error,
        result,
        completedAt,
      },
    })
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
    result: parseVersionedJson<AgentCommunicationResult>(row.result_json),
    decision: parseVersionedJson<AgentCommunicationDecision>(row.decision_json),
  }
}
