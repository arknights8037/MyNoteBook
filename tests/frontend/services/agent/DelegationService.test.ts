import { describe, expect, it, vi } from 'vitest'
import type { GovernanceRepository } from '@/repositories/knowledge/GovernanceRepository'
import { DelegationService } from '@/services/agent/DelegationService'

describe('DelegationService', () => {
  it('returns a capability once while persisting only its hash', async () => {
    const createDelegation = vi.fn(async (input) => ({ ok: true as const, value: {
      ...input, delegateType: input.delegateType, status: 'pending' as const,
      contextBundleId: null, causationId: null, updatedAt: input.createdAt,
    } }))
    const repository = { createDelegation } as unknown as GovernanceRepository
    const service = new DelegationService(repository, () => 'delegation-1', () => 100)
    const result = await service.create({ taskRunId: 'run-1', delegateType: 'cli', externalActorId: 'codex', allowedOperations: ['read_task', 'submit_result'] })

    expect(result.ok).toBe(true)
    expect(result.ok && result.value.capabilityToken).toMatch(/^[a-f0-9]{64}$/)
    expect(createDelegation.mock.calls[0][0].capabilityTokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(createDelegation.mock.calls[0][0].capabilityTokenHash).not.toBe(result.ok && result.value.capabilityToken)
  })

  it('hashes the full request before an idempotent external submission', async () => {
    const submitExternal = vi.fn(async () => ({ ok: true as const, value: { entityId: 'result-1', replayed: false } }))
    const service = new DelegationService({ submitExternal } as unknown as GovernanceRepository, () => 'id', () => 200)
    await service.submit('delegation-1', 'secret', 'stable-key', { type: 'result', entityId: 'result-1', output: { ok: true } })
    expect(submitExternal).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'stable-key', requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      capabilityTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }))
  })

  it('expands a high-level completion with the result submitted last', async () => {
    const submitExternal = vi.fn(async (input) => ({
      ok: true as const,
      value: { entityId: input.submission.entityId, replayed: false },
    }))
    const service = new DelegationService(
      { submitExternal } as unknown as GovernanceRepository,
      () => 'id',
      () => 200,
    )

    await service.submitCompletion('delegation-1', 'secret', 'complete-1', {
      version: 1,
      artifacts: [
        { type: 'artifact', entityId: 'artifact-1', artifactType: 'report', name: '报告', content: {} },
      ],
      evidence: [
        { type: 'evidence', entityId: 'evidence-1', evidenceType: 'test', claim: '测试通过' },
      ],
      result: { type: 'result', entityId: 'result-1', output: { summary: '完成' } },
    })

    expect(submitExternal.mock.calls.map(([input]) => input.submission.type)).toEqual([
      'artifact',
      'evidence',
      'result',
    ])
    expect(submitExternal.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([
      'complete-1:0:artifact',
      'complete-1:1:evidence',
      'complete-1:2:result',
    ])
  })
})
