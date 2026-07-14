import type { KnowledgeObject, KnowledgeObjectType } from '@/models/knowledge'
import type { DelegationGrant } from '@/models/governance'
import type { TaskRun } from '@/models/work'
import type { ViewDefinition, ViewType, ViewWritebackPolicy } from '@/models/view'
import type { DocumentRepository } from '@/repositories/DocumentRepository'
import type { GovernanceRepository } from '@/repositories/GovernanceRepository'
import type { KnowledgeRepository } from '@/repositories/KnowledgeRepository'
import type { ViewRepository } from '@/repositories/ViewRepository'
import type { WorkRepository } from '@/repositories/WorkRepository'
import type { CliAgentFilePort } from './CliAgentAdapter'
import { CliAgentAdapter } from './CliAgentAdapter'
import { DelegationService } from './DelegationService'
import { ResultVerifier } from './ResultVerifier'
import { ViewService, type GeneratedViewExecutor } from './ViewService'

export interface KnowledgeControlState {
  objects: KnowledgeObject[]
  views: ViewDefinition[]
  taskRuns: TaskRun[]
}

export class KnowledgeControlService {
  private readonly viewService: ViewService
  private readonly delegationService: DelegationService
  private readonly cliAdapter: CliAgentAdapter

  constructor(
    private readonly knowledge: KnowledgeRepository,
    private readonly views: ViewRepository,
    private readonly work: WorkRepository,
    private readonly documents: DocumentRepository,
    governance: GovernanceRepository,
    cliFiles: CliAgentFilePort,
    private readonly createId: (prefix: string) => string,
    private readonly now: () => number,
    generatedViewExecutor: GeneratedViewExecutor,
  ) {
    this.viewService = new ViewService(
      views,
      documents,
      knowledge,
      createId,
      now,
      work,
      generatedViewExecutor,
    )
    this.delegationService = new DelegationService(governance, createId, now)
    this.cliAdapter = new CliAgentAdapter(cliFiles, this.delegationService)
  }

  async load(): Promise<KnowledgeControlState> {
    const [objects, views, taskRuns] = await Promise.all([
      this.knowledge.listObjects({ limit: 200 }),
      this.views.listDefinitions(),
      this.work.listRuns(100),
    ])
    if (!objects.ok) throw new Error(objects.error.message)
    if (!views.ok) throw new Error(views.error.message)
    if (!taskRuns.ok) throw new Error(taskRuns.error.message)
    return { objects: objects.value, views: views.value, taskRuns: taskRuns.value }
  }

  async createKnowledgeObject(input: {
    type: KnowledgeObjectType
    title: string
    documentId: string
    documentRevision: number
  }): Promise<void> {
    const result = await this.knowledge.createObject({
      id: this.createId('knowledge'),
      objectType: input.type,
      status: input.type === 'rule' || input.type === 'decision' ? 'active' : 'draft',
      title: input.title,
      documentId: input.documentId || null,
      sourceRevision: input.documentRevision || null,
      authorityLevel: 'local_user',
      verifiedAt: this.now(),
    })
    if (!result.ok) throw new Error(result.error.message)
  }

  async verifyRun(run: TaskRun): Promise<void> {
    const verifier = new ResultVerifier(
      this.work,
      this.createId,
      this.now,
      async (documentId) => {
        const result = await this.documents.findById(documentId)
        return result.ok ? result.value.revision : null
      },
    )
    const result = await verifier.verify(run.id)
    if (!result.ok) throw new Error(result.error.message)
  }

  async createView(input: {
    name: string
    type: ViewType
    query: string
    prompt: string
    writebackPolicy: ViewWritebackPolicy
    currentDocumentId: string
    provider: string
    model: string
  }): Promise<void> {
    const result = await this.views.createDefinition({
      id: this.createId('view'),
      name: input.name,
      viewType: input.type,
      scopeQuery:
        input.type === 'query'
          ? { query: input.query, limit: 20 }
          : { documentIds: input.currentDocumentId ? [input.currentDocumentId] : [] },
      projectionSchema: input.type === 'projection' ? { version: 1 } : null,
      renderSpec: { format: 'json' },
      writebackPolicy: input.writebackPolicy,
      targetDocumentId: input.currentDocumentId || null,
      generation:
        input.type === 'generated'
          ? { prompt: input.prompt, provider: input.provider, model: input.model, skillVersions: [] }
          : null,
    })
    if (!result.ok) throw new Error(result.error.message)
  }

  async refreshView(viewId: string) {
    const result = await this.viewService.refresh(viewId)
    if (!result.ok) throw new Error(result.error.message)
    return result.value.render
  }

  async protectViewOverride(viewId: string, content: unknown): Promise<void> {
    const result = await this.viewService.setManualOverride(viewId, content)
    if (!result.ok) throw new Error(result.error.message)
  }

  async proposeViewWriteback(view: ViewDefinition): Promise<void> {
    const result = await this.viewService.proposeWriteback({
      viewId: view.id,
      title: `${view.name} 回写提案`,
      description: '由 View 手动生成的 ChangeSet 草案；审批前不会修改规范知识。',
    })
    if (!result.ok) throw new Error(result.error.message)
  }

  async forkView(viewId: string): Promise<void> {
    const result = await this.viewService.forkToDocument(viewId)
    if (!result.ok) throw new Error(result.error.message)
  }

  async delegateRun(run: TaskRun): Promise<DelegationGrant> {
    const result = await this.delegationService.create({
      taskRunId: run.id,
      delegateType: 'cli',
      externalActorId: 'local-cli-agent',
      contextBundleId: run.contextBundleId,
      allowedOperations: [
        'read_context', 'read_task', 'submit_artifact', 'submit_evidence',
        'submit_result', 'propose_change_set',
      ],
    })
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }

  exportCliEnvelope(path: string, grant: DelegationGrant, run: TaskRun): Promise<void> {
    return this.cliAdapter.export(path, grant, run, null)
  }

  async importCliSubmission(path: string, capabilityToken: string): Promise<void> {
    const result = await this.cliAdapter.importSubmission(path, capabilityToken)
    if (!result.ok) throw new Error(result.error.message)
  }
}
