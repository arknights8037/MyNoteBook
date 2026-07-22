import { describe, expect, it, vi } from 'vitest'

import { ResultVerifier } from '@/services/cognitive/ResultVerifier'
import type { TaskRun, WorkArtifact, WorkEvidence } from '@/models/knowledge/work'
import type { WorkRepository } from '@/repositories/knowledge/WorkRepository'

describe('ResultVerifier', () => {
  it('requires Artifact and valid Evidence, then atomically proposes a ChangeSet for approval', async () => {
    const run = createRun()
    const artifacts: WorkArtifact[] = [
      {
        id: 'artifact-1',
        taskRunId: run.id,
        artifactType: 'test_report',
        name: '测试报告',
        uri: null,
        content: { passed: true },
        contentHash: 'hash',
        createdAt: 2,
      },
    ]
    const evidence: WorkEvidence[] = [
      {
        id: 'evidence-1',
        taskRunId: run.id,
        evidenceType: 'test_result',
        status: 'valid',
        documentId: null,
        blockId: null,
        sourceRevision: null,
        artifactId: 'artifact-1',
        claim: '测试通过',
        details: {},
        createdAt: 3,
      },
    ]
    const finalizeVerification = vi.fn(async ({ verification }) => ({
      ok: true as const,
      value: verification,
    }))
    const repository = {
      getRun: vi.fn(async () => ({ ok: true as const, value: run })),
      listArtifacts: vi.fn(async () => ({ ok: true as const, value: artifacts })),
      listEvidence: vi.fn(async () => ({ ok: true as const, value: evidence })),
      finalizeVerification,
    } as unknown as WorkRepository
    let index = 0
    const verifier = new ResultVerifier(
      repository,
      (prefix) => `${prefix}-${++index}`,
      () => 10,
    )

    const result = await verifier.verify(run.id)

    expect(result.ok).toBe(true)
    expect(result.ok && result.value.confirmationHash).toMatch(/^[a-f0-9]{64}$/)
    expect(result.ok && result.value.confirmationEnvelope).toMatchObject({
      version: 1,
      task: { id: 'run-1' },
      artifacts: [{ id: 'artifact-1' }],
      evidence: [{ id: 'evidence-1' }],
    })
    expect(finalizeVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedStatus: 'running',
        nextStatus: 'waiting_approval',
        proposedChangeSet: expect.objectContaining({ status: 'proposed' }),
        verification: expect.objectContaining({ verdict: 'needs_approval' }),
      }),
    )
  })

  it('does not trust unverified Evidence or complete the TaskRun', async () => {
    const run = createRun()
    const finalizeVerification = vi.fn(async ({ verification }) => ({
      ok: true as const,
      value: verification,
    }))
    const repository = {
      getRun: vi.fn(async () => ({ ok: true as const, value: run })),
      listArtifacts: vi.fn(async () => ({ ok: true as const, value: [] })),
      listEvidence: vi.fn(async () => ({
        ok: true as const,
        value: [
          {
            id: 'evidence-1',
            taskRunId: run.id,
            evidenceType: 'test_result',
            status: 'unverified',
            documentId: null,
            blockId: null,
            sourceRevision: null,
            artifactId: null,
            claim: 'Agent 声称测试通过',
            details: {},
            createdAt: 3,
          },
        ],
      })),
      finalizeVerification,
    } as unknown as WorkRepository
    const verifier = new ResultVerifier(
      repository,
      (prefix) => `${prefix}-1`,
      () => 10,
    )

    await verifier.verify(run.id)

    expect(finalizeVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        nextStatus: 'blocked',
        proposedChangeSet: null,
        verification: expect.objectContaining({ verdict: 'unverifiable' }),
      }),
    )
  })

  it('blocks confirmation when a referenced Context Bundle cannot be reconstructed', async () => {
    const run = { ...createRun(), contextBundleId: 'bundle-missing' }
    const finalizeVerification = vi.fn(async ({ verification }) => ({
      ok: true as const,
      value: verification,
    }))
    const repository = {
      getRun: vi.fn(async () => ({ ok: true as const, value: run })),
      listArtifacts: vi.fn(async () => ({ ok: true as const, value: [] })),
      listEvidence: vi.fn(async () => ({ ok: true as const, value: [] })),
      finalizeVerification,
    } as unknown as WorkRepository
    const verifier = new ResultVerifier(
      repository,
      (prefix) => `${prefix}-1`,
      () => 10,
      undefined,
      async () => null,
    )

    await verifier.verify(run.id)

    expect(finalizeVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        nextStatus: 'blocked',
        verification: expect.objectContaining({
          verdict: 'unverifiable',
          checks: expect.arrayContaining([
            expect.objectContaining({ key: 'context:bundle', verifiable: false }),
          ]),
        }),
      }),
    )
  })
})

function createRun(): TaskRun {
  return {
    id: 'run-1',
    taskDefinitionId: 'definition-1',
    status: 'running',
    frozenInput: {},
    acceptanceCriteria: {
      requiredArtifacts: [{ artifactType: 'test_report' }],
      minimumEvidence: 1,
      requiredEvidenceTypes: ['test_result'],
      requireValidEvidence: true,
      requireApproval: true,
      proposeChangeSet: { title: '更新知识状态' },
    },
    output: null,
    error: null,
    contextBundleId: null,
    correlationId: 'corr-1',
    causationId: null,
    queuedAt: 1,
    startedAt: 2,
    completedAt: null,
  }
}
