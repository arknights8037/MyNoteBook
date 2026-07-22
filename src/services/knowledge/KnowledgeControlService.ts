import type {
  KnowledgeObject,
  KnowledgeObjectSource,
  KnowledgeObjectType,
  KnowledgeRelation,
  KnowledgeValidation,
} from '@/models/knowledge/knowledge'
import {
  knowledgeAssetFromObject,
  isKnowledgeAssetObject,
  type KnowledgeAsset,
} from '@/models/knowledge/knowledgeAsset'
import type { AiChatHistoryItem } from '@/models/ai/aiChatHistory'
import type { AssetPort } from '@/services/ports/AssetPort'
import {
  aiConversationToKnowledgeAsset,
  extractKnowledgeAssetFile,
  materializeAiConversationImport,
  parseAiConversationImport,
  type AiConversationImportBatch,
  type AiConversationImportSelection,
} from '@/services/knowledge/KnowledgeAssetImporter'
import type { DelegationGrant } from '@/models/knowledge/governance'
import type { TaskRun } from '@/models/knowledge/work'
import type { ViewDefinition, ViewType, ViewWritebackPolicy } from '@/models/knowledge/view'
import type { DocumentRepository } from '@/repositories/documents/DocumentRepository'
import type { GovernanceRepository } from '@/repositories/knowledge/GovernanceRepository'
import type { KnowledgeRepository } from '@/repositories/knowledge/KnowledgeRepository'
import type { ViewRepository } from '@/repositories/knowledge/ViewRepository'
import type { WorkRepository } from '@/repositories/knowledge/WorkRepository'
import type { CliAgentFilePort } from '@/services/agent/CliAgentAdapter'
import { CliAgentAdapter } from '@/services/agent/CliAgentAdapter'
import { DelegationService } from '@/services/agent/DelegationService'
import { ResultVerifier } from '@/services/cognitive/ResultVerifier'
import { ViewService, type GeneratedViewExecutor } from '@/services/workspace/ViewService'

export interface KnowledgeControlState {
  objects: KnowledgeObject[]
  assets: KnowledgeAsset[]
  views: ViewDefinition[]
  taskRuns: TaskRun[]
}

export interface KnowledgeObjectDetail {
  object: KnowledgeObject
  sources: KnowledgeObjectSource[]
  validations: KnowledgeValidation[]
  relations: KnowledgeRelation[]
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
    private readonly assets?: AssetPort,
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
    return {
      objects: objects.value.filter((object) => !isKnowledgeAssetObject(object)),
      assets: objects.value
        .map(knowledgeAssetFromObject)
        .filter((asset): asset is KnowledgeAsset => Boolean(asset)),
      views: views.value,
      taskRuns: taskRuns.value,
    }
  }

  async importKnowledgeFile(file: File): Promise<void> {
    if (!this.assets) throw new Error('知识资产存储尚未配置。')
    const extracted = await extractKnowledgeAssetFile(file)
    const stored = await this.assets.storeFile(file)
    await this.persistKnowledgeAsset({
      title: extracted.title,
      text: extracted.text,
      sourceType: extracted.sourceType,
      format: extracted.format,
      assetId: stored.id,
      originalName: stored.originalName,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
    })
  }

  async importAiConversation(conversation: AiChatHistoryItem): Promise<void> {
    const extracted = aiConversationToKnowledgeAsset(conversation)
    await this.persistKnowledgeAsset({
      title: extracted.title,
      text: extracted.text,
      sourceType: 'ai_chat',
      format: extracted.format,
      assetId: null,
      originalName: `${extracted.title}.chat.md`,
      mimeType: 'text/markdown',
      sizeBytes: new TextEncoder().encode(extracted.text).byteLength,
      provider: conversation.provider,
      model: conversation.model,
      conversationId: conversation.id,
      messageCount: conversation.messageCount,
    })
  }

  async importAiConversationFile(file: File): Promise<{ imported: number; failures: string[] }> {
    const batch = await this.prepareAiConversationImport(file)
    return this.importAiConversationSelections(
      batch.conversations.map((candidate) => ({ candidate, mode: candidate.defaultMode })),
      batch.failures,
      file.name,
    )
  }

  prepareAiConversationImport(file: File): Promise<AiConversationImportBatch> {
    return parseAiConversationImport(file)
  }

  async importAiConversationSelections(
    selections: AiConversationImportSelection[],
    initialFailures: string[] = [],
    importSourceName = '',
  ): Promise<{ imported: number; failures: string[] }> {
    if (!this.assets) throw new Error('知识资产存储尚未配置。')
    const failures = [...initialFailures]
    const importedFromArchive = /\.zip$/i.test(importSourceName)
    const importBatchId = importedFromArchive ? this.createId('asset-batch') : ''
    let imported = 0
    for (const selection of selections) {
      const conversation = selection.candidate
      try {
        const materialized = materializeAiConversationImport(selection)
        const stored = await this.assets.storeFile(conversation.file)
        await this.persistKnowledgeAsset({
          title: materialized.title,
          text: materialized.text,
          sourceType: materialized.sourceType,
          format: materialized.format,
          assetId: stored.id,
          originalName: stored.originalName,
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
          provider: materialized.provider,
          model: materialized.model,
          messageCount: materialized.messageCount,
          importBatchId,
          importBatchName: importedFromArchive ? importSourceName : '',
          archivePath: importedFromArchive ? conversation.originalPath : '',
          importedFromArchive,
        })
        imported += 1
      } catch (error) {
        failures.push(
          `${conversation.originalPath}：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return { imported, failures }
  }

  async openOriginalAsset(assetId: string): Promise<void> {
    if (!this.assets || !assetId) return
    await this.assets.openAsset(assetId)
  }

  async deleteKnowledgeAsset(asset: KnowledgeAsset): Promise<void> {
    const current = await this.knowledge.getObject(asset.id)
    if (!current.ok) throw new Error(current.error.message)
    if (!isKnowledgeAssetObject(current.value)) throw new Error('该记录不是知识资产。')

    const deleted = await this.knowledge.deleteObject(asset.id, current.value.version)
    if (!deleted.ok) throw new Error(deleted.error.message)
    if (asset.assetId && this.assets) await this.assets.deleteAsset(asset.assetId)
  }

  private async persistKnowledgeAsset(input: {
    title: string
    text: string
    sourceType: 'office_file' | 'text_file' | 'ai_chat'
    format: string
    assetId: string | null
    originalName: string
    mimeType: string
    sizeBytes: number
    provider?: string
    model?: string
    conversationId?: string
    messageCount?: number
    importBatchId?: string
    importBatchName?: string
    archivePath?: string
    importedFromArchive?: boolean
  }): Promise<void> {
    const created = await this.knowledge.createObject({
      id: this.createId('knowledge-asset'),
      objectType: 'evidence',
      status: 'active',
      title: input.title,
      content: input.text,
      structuredData: {
        kind: 'document_asset',
        sourceType: input.sourceType,
        format: input.format,
        assetId: input.assetId,
        originalName: input.originalName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        characterCount: Array.from(input.text).length,
        provider: input.provider ?? '',
        model: input.model ?? '',
        conversationId: input.conversationId ?? '',
        messageCount: input.messageCount ?? 0,
        importBatchId: input.importBatchId ?? '',
        importBatchName: input.importBatchName ?? '',
        archivePath: input.archivePath ?? '',
        importedFromArchive: input.importedFromArchive ?? false,
        contentFormat: 'markdown',
        processingStatus: 'pending',
        automationPurpose: 'summarize_and_index',
      },
      scope: { backgroundProcessing: true, directlyVisible: false },
      documentId: null,
      sourceRevision: null,
      authorityLevel: 'local_user',
      verifiedAt: this.now(),
    })
    if (!created.ok) throw new Error(created.error.message)
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

  async getKnowledgeObjectDetail(id: string): Promise<KnowledgeObjectDetail> {
    const [object, sources, validations, relations] = await Promise.all([
      this.knowledge.getObject(id),
      this.knowledge.listSources(id),
      this.knowledge.listValidations(id),
      this.knowledge.listRelations(id),
    ])
    if (!object.ok) throw new Error(object.error.message)
    if (!sources.ok) throw new Error(sources.error.message)
    if (!validations.ok) throw new Error(validations.error.message)
    if (!relations.ok) throw new Error(relations.error.message)
    return {
      object: object.value,
      sources: sources.value,
      validations: validations.value,
      relations: relations.value,
    }
  }

  async updateKnowledgeObjectMetadata(input: {
    id: string
    expectedVersion: number
    category: string
    tags: string[]
  }): Promise<KnowledgeObject> {
    const current = await this.knowledge.getObject(input.id)
    if (!current.ok) throw new Error(current.error.message)
    const updated = await this.knowledge.updateObject(input.id, input.expectedVersion, {
      structuredData: {
        ...current.value.structuredData,
        userCategory: input.category.trim(),
        userTags: Array.from(new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))).slice(
          0,
          20,
        ),
      },
    })
    if (!updated.ok) throw new Error(updated.error.message)
    return updated.value
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
      async (contextBundleId) => {
        const result = await this.delegationService.getContextBundle(contextBundleId)
        return result.ok ? result.value : null
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
          ? {
              prompt: input.prompt,
              provider: input.provider,
              model: input.model,
              skillVersions: [],
            }
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
        'read_context',
        'read_task',
        'submit_artifact',
        'submit_evidence',
        'submit_result',
        'propose_change_set',
      ],
    })
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }

  exportCliEnvelope(path: string, grant: DelegationGrant, run: TaskRun): Promise<void> {
    return this.exportCliEnvelopeWithContext(path, grant, run)
  }

  private async exportCliEnvelopeWithContext(
    path: string,
    grant: DelegationGrant,
    run: TaskRun,
  ): Promise<void> {
    let contextBundle = null
    if (grant.delegation.contextBundleId) {
      const context = await this.delegationService.getContextBundle(
        grant.delegation.contextBundleId,
      )
      if (!context.ok) throw new Error(context.error.message)
      contextBundle = context.value
    }
    await this.cliAdapter.export(path, grant, run, contextBundle)
  }

  async importCliSubmission(path: string, capabilityToken: string): Promise<void> {
    const result = await this.cliAdapter.importSubmission(path, capabilityToken)
    if (!result.ok) throw new Error(result.error.message)
  }
}
