import type { DelegationGrant, ExternalSubmission } from '@/models/governance'
import type { TaskRun } from '@/models/work'
import type { ContextBundle } from '@/models/contextBundle'
import { DelegationService } from './DelegationService'

export interface CliAgentFilePort {
  readTextFile(path: string): Promise<string>
  writeTextFile(path: string, content: string): Promise<void>
}

export interface CliDelegationEnvelope {
  version: 1
  delegation: DelegationGrant['delegation']
  capabilityToken: string
  taskRun: TaskRun
  contextBundle: ContextBundle | null
  submissionContract: {
    idempotencyKey: string
    allowedTypes: ExternalSubmission['type'][]
  }
}

export class CliAgentAdapter {
  constructor(
    private readonly files: CliAgentFilePort,
    private readonly delegations: DelegationService,
  ) {}

  async export(path: string, grant: DelegationGrant, taskRun: TaskRun, contextBundle: ContextBundle | null): Promise<void> {
    const allowedTypes = grant.delegation.allowedOperations.flatMap((operation) => ({
      submit_artifact: ['artifact' as const], submit_evidence: ['evidence' as const],
      submit_result: ['result' as const], propose_change_set: ['change_set' as const],
      read_context: [], read_task: [],
    })[operation])
    const envelope: CliDelegationEnvelope = {
      version: 1,
      delegation: grant.delegation,
      capabilityToken: grant.capabilityToken,
      taskRun,
      contextBundle,
      submissionContract: { idempotencyKey: '由 CLI Agent 生成稳定唯一值', allowedTypes },
    }
    await this.files.writeTextFile(path, JSON.stringify(envelope, null, 2))
  }

  async importSubmission(path: string, capabilityToken: string) {
    const parsed = JSON.parse(await this.files.readTextFile(path)) as {
      version?: unknown; delegationId?: unknown; idempotencyKey?: unknown; submission?: unknown
    }
    if (parsed.version !== 1 || typeof parsed.delegationId !== 'string' || typeof parsed.idempotencyKey !== 'string') {
      throw new Error('CLI submission envelope 无效。')
    }
    return this.delegations.submit(
      parsed.delegationId,
      capabilityToken,
      parsed.idempotencyKey,
      parsed.submission as ExternalSubmission,
    )
  }
}
