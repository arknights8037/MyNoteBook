import { describe, expect, it, vi } from 'vitest'
import type { DelegationGrant } from '@/models/governance'
import type { TaskRun } from '@/models/work'
import { CliAgentAdapter } from './CliAgentAdapter'
import { DelegationService } from './DelegationService'

describe('CliAgentAdapter', () => {
  it('exports a versioned envelope with the frozen task and allowed submission types', async () => {
    const writeTextFile = vi.fn(async () => undefined)
    const adapter = new CliAgentAdapter(
      { readTextFile: vi.fn(), writeTextFile },
      {} as DelegationService,
    )
    await adapter.export('C:/delegation.json', grant(), run(), null)
    const envelope = JSON.parse(writeTextFile.mock.calls[0][1])
    expect(envelope).toMatchObject({
      version: 2,
      capabilityToken: 'secret',
      taskRun: { id: 'run-1' },
      submissionContract: { confirmationRequired: true },
    })
    expect(envelope.submissionContract.allowedTypes).toEqual(['result', 'change_set'])
  })

  it('imports a submission through DelegationService instead of writing documents', async () => {
    const submit = vi.fn(async () => ({
      ok: true as const,
      value: { entityId: 'result-1', replayed: false },
    }))
    const adapter = new CliAgentAdapter(
      {
        readTextFile: vi.fn(async () =>
          JSON.stringify({
            version: 1,
            delegationId: 'delegation-1',
            idempotencyKey: 'key-1',
            submission: { type: 'result', entityId: 'result-1', output: {} },
          }),
        ),
        writeTextFile: vi.fn(),
      },
      { submit } as unknown as DelegationService,
    )
    await adapter.importSubmission('C:/result.json', 'secret')
    expect(submit).toHaveBeenCalledWith(
      'delegation-1',
      'secret',
      'key-1',
      expect.objectContaining({ type: 'result' }),
    )
  })

  it('imports the preferred completion envelope through the high-level service', async () => {
    const submitCompletion = vi.fn(async () => ({
      ok: true as const,
      value: { entityId: 'result-1', replayed: false },
    }))
    const completion = {
      version: 1,
      result: { type: 'result', entityId: 'result-1', output: { summary: '完成' } },
    }
    const adapter = new CliAgentAdapter(
      {
        readTextFile: vi.fn(async () =>
          JSON.stringify({
            version: 2,
            delegationId: 'delegation-1',
            idempotencyKey: 'complete-1',
            completion,
          }),
        ),
        writeTextFile: vi.fn(),
      },
      { submitCompletion } as unknown as DelegationService,
    )

    await adapter.importSubmission('C:/completion.json', 'secret')

    expect(submitCompletion).toHaveBeenCalledWith(
      'delegation-1',
      'secret',
      'complete-1',
      completion,
    )
  })

  it('rejects a malformed completion before calling the delegation service', async () => {
    const submitCompletion = vi.fn()
    const adapter = new CliAgentAdapter(
      {
        readTextFile: vi.fn(async () =>
          JSON.stringify({
            version: 2,
            delegationId: 'delegation-1',
            idempotencyKey: 'complete-1',
            completion: { version: 1, result: { type: 'artifact', entityId: 'wrong' } },
          }),
        ),
        writeTextFile: vi.fn(),
      },
      { submitCompletion } as unknown as DelegationService,
    )

    await expect(adapter.importSubmission('C:/completion.json', 'secret')).rejects.toThrow(
      'CLI completion envelope 无效。',
    )
    expect(submitCompletion).not.toHaveBeenCalled()
  })
})

function grant(): DelegationGrant {
  return {
    capabilityToken: 'secret',
    delegation: {
      id: 'delegation-1',
      taskRunId: 'run-1',
      delegateType: 'cli',
      externalActorId: 'codex',
      status: 'pending',
      contextBundleId: null,
      allowedOperations: ['read_task', 'submit_result', 'propose_change_set'],
      expiresAt: 1000,
      correlationId: 'corr',
      causationId: null,
      createdAt: 1,
      updatedAt: 1,
    },
  }
}

function run(): TaskRun {
  return {
    id: 'run-1',
    taskDefinitionId: null,
    status: 'running',
    frozenInput: {},
    acceptanceCriteria: {},
    output: null,
    error: null,
    contextBundleId: null,
    correlationId: 'corr',
    causationId: null,
    queuedAt: 1,
    startedAt: 2,
    completedAt: null,
  }
}
