import type {
  ChangeSetRecord,
  ResultVerification,
  VerificationCheck,
} from '@/models/work'
import type { AppResult } from '@/models/result'
import type { WorkRepository } from '@/repositories/WorkRepository'

export class ResultVerifier {
  constructor(
    private readonly repository: WorkRepository,
    private readonly createId: (prefix: string) => string,
    private readonly now: () => number = Date.now,
    private readonly getDocumentRevision?: (documentId: string) => Promise<number | null>,
  ) {}

  async verify(taskRunId: string): Promise<AppResult<ResultVerification>> {
    const runResult = await this.repository.getRun(taskRunId)
    if (!runResult.ok) return runResult
    const [artifactsResult, evidenceResult] = await Promise.all([
      this.repository.listArtifacts(taskRunId),
      this.repository.listEvidence(taskRunId),
    ])
    if (!artifactsResult.ok) return artifactsResult
    if (!evidenceResult.ok) return evidenceResult
    const run = runResult.value
    const artifacts = artifactsResult.value
    const evidence = evidenceResult.value
    const criteria = run.acceptanceCriteria
    const checks: VerificationCheck[] = []

    for (const required of criteria.requiredArtifacts ?? []) {
      const count = artifacts.filter(
        (artifact) => artifact.artifactType === required.artifactType,
      ).length
      const minimum = Math.max(1, required.minCount ?? 1)
      checks.push({
        key: `artifact:${required.artifactType}`,
        passed: count >= minimum,
        verifiable: true,
        message: `${required.artifactType} Artifact：${count}/${minimum}`,
      })
    }
    const minimumEvidence = Math.max(0, criteria.minimumEvidence ?? 0)
    if (minimumEvidence > 0) {
      checks.push({
        key: 'evidence:count',
        passed: evidence.length >= minimumEvidence,
        verifiable: true,
        message: `Evidence：${evidence.length}/${minimumEvidence}`,
      })
    }
    for (const type of criteria.requiredEvidenceTypes ?? []) {
      const matches = evidence.filter((item) => item.evidenceType === type)
      checks.push({
        key: `evidence:${type}`,
        passed: matches.length > 0,
        verifiable: true,
        message: matches.length > 0 ? `已提供 ${type} Evidence` : `缺少 ${type} Evidence`,
      })
    }
    if (evidence.length > 0 || criteria.requireValidEvidence) {
      checks.push({
        key: 'evidence:validity',
        passed: evidence.length > 0 && evidence.every((item) => item.status === 'valid'),
        verifiable: evidence.every((item) => item.status !== 'unverified'),
        message: evidence.some((item) => item.status === 'invalid')
          ? '存在无效 Evidence'
          : evidence.some((item) => item.status === 'unverified')
            ? '存在尚未验证的 Evidence'
            : 'Evidence 均已验证',
      })
    }
    if (criteria.requireTestsPassed) {
      const testReports = artifacts.filter((artifact) => artifact.artifactType === 'test_report')
      checks.push({
        key: 'tests:passed',
        passed: testReports.some(
          (artifact) =>
            artifact.content !== null &&
            typeof artifact.content === 'object' &&
            (artifact.content as Record<string, unknown>).passed === true,
        ),
        verifiable: testReports.length > 0,
        message: testReports.length > 0 ? '已检查测试报告' : '缺少可验证的测试报告',
      })
    }
    if (this.getDocumentRevision) {
      for (const item of evidence.filter(
        (candidate) => candidate.documentId && candidate.sourceRevision,
      )) {
        const currentRevision = await this.getDocumentRevision(item.documentId ?? '')
        checks.push({
          key: `source:${item.id}`,
          passed: currentRevision === item.sourceRevision,
          verifiable: currentRevision !== null,
          message:
            currentRevision === item.sourceRevision
              ? 'Evidence 来源 revision 有效'
              : `Evidence 来源已变化（记录 ${item.sourceRevision}，当前 ${currentRevision ?? '不可读'}）`,
        })
      }
    }

    const unverifiable = checks.some((check) => !check.verifiable)
    const failed = checks.some((check) => check.verifiable && !check.passed)
    let verdict: ResultVerification['verdict'] = unverifiable
      ? 'unverifiable'
      : failed
        ? 'failed'
        : criteria.requireApproval
          ? 'needs_approval'
          : 'passed'
    let proposedChangeSet: ChangeSetRecord | null = null
    if (!failed && !unverifiable && criteria.proposeChangeSet) {
      const now = this.now()
      proposedChangeSet = {
        id: this.createId('changeset'),
        taskRunId,
        agentTaskId: null,
        status: 'proposed',
        title: criteria.proposeChangeSet.title,
        description: criteria.proposeChangeSet.description ?? '',
        patchSetTaskId: null,
        createdAt: now,
        updatedAt: now,
      }
      verdict = 'needs_approval'
    }
    const createdAt = this.now()
    const verification: ResultVerification = {
      id: this.createId('verification'),
      taskRunId,
      verdict,
      checks,
      summary:
        verdict === 'passed'
          ? '验收条件已通过。'
          : verdict === 'needs_approval'
            ? '自动检查已通过，等待人工审批。'
            : verdict === 'unverifiable'
              ? '存在无法自动验证的 Evidence。'
              : '验收条件未通过。',
      proposedChangeSetId: proposedChangeSet?.id ?? null,
      correlationId: run.correlationId,
      createdAt,
    }
    const nextStatus = verdict === 'passed' ? 'completed' : verdict === 'needs_approval' ? 'waiting_approval' : 'blocked'
    return this.repository.finalizeVerification({
      verification,
      proposedChangeSet,
      expectedStatus: run.status,
      nextStatus,
    })
  }
}
