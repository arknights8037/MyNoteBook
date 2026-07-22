import type { DelegatedCompletion, DelegationGrant, ExternalSubmission } from '@/models/knowledge/governance'
import type { TaskRun } from '@/models/knowledge/work'
import type { ContextBundle } from '@/models/agent/contextBundle'
import { DelegationService } from '@/services/agent/DelegationService'

export interface CliAgentFilePort {
  readTextFile(path: string): Promise<string>
  writeTextFile(path: string, content: string): Promise<void>
}

export interface CliDelegationEnvelope {
  version: 2
  delegation: DelegationGrant['delegation']
  capabilityToken: string
  taskRun: TaskRun
  contextBundle: ContextBundle | null
  submissionContract: {
    idempotencyKey: string
    allowedTypes: ExternalSubmission['type'][]
    confirmationRequired: true
    preferredEnvelope: 'delegated-completion-v1'
  }
}

export class CliAgentAdapter {
  constructor(
    private readonly files: CliAgentFilePort,
    private readonly delegations: DelegationService,
  ) {}

  async export(
    path: string,
    grant: DelegationGrant,
    taskRun: TaskRun,
    contextBundle: ContextBundle | null,
  ): Promise<void> {
    const allowedTypes = grant.delegation.allowedOperations.flatMap(
      (operation) =>
        ({
          submit_artifact: ['artifact' as const],
          submit_evidence: ['evidence' as const],
          submit_result: ['result' as const],
          propose_change_set: ['change_set' as const],
          read_context: [],
          read_task: [],
        })[operation],
    )
    const envelope: CliDelegationEnvelope = {
      version: 2,
      delegation: grant.delegation,
      capabilityToken: grant.capabilityToken,
      taskRun,
      contextBundle,
      submissionContract: {
        idempotencyKey: '由 CLI Agent 生成稳定唯一值',
        allowedTypes,
        confirmationRequired: true,
        preferredEnvelope: 'delegated-completion-v1',
      },
    }
    await this.files.writeTextFile(path, JSON.stringify(envelope, null, 2))
  }

  async importSubmission(path: string, capabilityToken: string) {
    const parsed = JSON.parse(await this.files.readTextFile(path)) as {
      version?: unknown
      delegationId?: unknown
      idempotencyKey?: unknown
      submission?: unknown
      completion?: unknown
    }
    if (
      (parsed.version !== 1 && parsed.version !== 2) ||
      typeof parsed.delegationId !== 'string' ||
      typeof parsed.idempotencyKey !== 'string'
    ) {
      throw new Error('CLI submission envelope 无效。')
    }
    if (parsed.version === 2 && parsed.completion) {
      const completion = parseDelegatedCompletion(parsed.completion)
      return this.delegations.submitCompletion(
        parsed.delegationId,
        capabilityToken,
        parsed.idempotencyKey,
        completion,
      )
    }
    return this.delegations.submit(
      parsed.delegationId,
      capabilityToken,
      parsed.idempotencyKey,
      parsed.submission as ExternalSubmission,
    )
  }
}

function parseDelegatedCompletion(value: unknown): DelegatedCompletion {
  if (!isRecord(value) || value.version !== 1 || !isSubmission(value.result, 'result')) {
    throw new Error('CLI completion envelope 无效。')
  }
  if (
    (value.artifacts !== undefined && !isSubmissionArray(value.artifacts, 'artifact')) ||
    (value.evidence !== undefined && !isSubmissionArray(value.evidence, 'evidence')) ||
    (value.changeSet !== undefined &&
      value.changeSet !== null &&
      !isSubmission(value.changeSet, 'change_set'))
  ) {
    throw new Error('CLI completion envelope 无效。')
  }
  return value as unknown as DelegatedCompletion
}

function isSubmissionArray(value: unknown, type: ExternalSubmission['type']): boolean {
  return Array.isArray(value) && value.every((item) => isSubmission(item, type))
}

function isSubmission(value: unknown, type: ExternalSubmission['type']): boolean {
  return isRecord(value) && value.type === type && typeof value.entityId === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
