import { createSnapshotHash } from '@/models/contextBundle'
import type { KnowledgeObject } from '@/models/knowledge'
import type { AppResult } from '@/models/result'
import type { ViewDefinition, ViewDependency, ViewSnapshot } from '@/models/view'
import type { DocumentRepository } from '@/repositories/DocumentRepository'
import type { KnowledgeRepository } from '@/repositories/KnowledgeRepository'
import type { ViewRepository } from '@/repositories/ViewRepository'
import type { WorkRepository } from '@/repositories/WorkRepository'
import { parseMarkdownDocument } from '@/editor/markdownImport'

export interface GeneratedViewExecutor {
  generate(input: {
    prompt: string
    provider: string
    model: string
    sources: unknown
  }): Promise<AppResult<unknown>>
}

export class ViewService {
  constructor(
    private readonly views: ViewRepository,
    private readonly documents: DocumentRepository,
    private readonly knowledge: KnowledgeRepository,
    private readonly createId: (prefix: string) => string,
    private readonly now: () => number = Date.now,
    private readonly work?: WorkRepository,
    private readonly generatedViewExecutor?: GeneratedViewExecutor,
  ) {}

  async refresh(viewId: string): Promise<AppResult<ViewSnapshot>> {
    const definitionResult = await this.views.getDefinition(viewId)
    if (!definitionResult.ok) return definitionResult
    const definition = definitionResult.value
    if (definition.viewType === 'generated') {
      return this.refreshGenerated(definition)
    }
    const dependencies: ViewDependency[] = []
    let render: unknown
    if (definition.viewType === 'query') {
      const query = typeof definition.scopeQuery.query === 'string' ? definition.scopeQuery.query : ''
      if (!query.trim()) {
        return { ok: false, error: { code: 'validation-error', message: 'Query View 缺少 query。' } }
      }
      const limit = Math.max(1, Math.min(Number(definition.scopeQuery.limit ?? 20), 100))
      const result = await this.documents.searchKnowledge(query, { limit })
      if (!result.ok) return result
      render = result.value.map((document) => ({
        documentId: document.id,
        title: document.title,
        revision: document.revision,
        snippet: document.plainText.slice(0, 500),
      }))
      dependencies.push(
        ...result.value.map((document) => ({
          sourceType: 'document_block' as const,
          knowledgeObjectId: null,
          documentId: document.id,
          blockId: null,
          sourceRevision: document.revision,
        })),
      )
    } else {
      const sources = await this.loadExplicitSources(definition.scopeQuery)
      if (!sources.ok) return sources
      render = sources.value.render
      dependencies.push(...sources.value.dependencies)
    }
    const createdAt = this.now()
    const snapshot: ViewSnapshot = {
      id: this.createId('view-snapshot'),
      viewId,
      status: 'fresh',
      sourceSnapshotHash: await createSnapshotHash({ dependencies, render }),
      render,
      provider: null,
      model: null,
      skillVersions: [],
      generatedAt: null,
      protectedByOverride: false,
      correlationId: `view-refresh-${viewId}-${createdAt}`,
      causationId: null,
      error: null,
      createdAt,
    }
    return this.views.commitRefresh({ definition, snapshot, dependencies })
  }

  async setManualOverride(viewId: string, content: unknown): Promise<AppResult<unknown>> {
    const definition = await this.views.getDefinition(viewId)
    if (!definition.ok) return definition
    if (definition.value.viewType !== 'generated') {
      return { ok: false, error: { code: 'validation-error', message: '只有 Generated View 支持手动覆盖。' } }
    }
    const updatedAt = this.now()
    return this.views.setManualOverride({
      viewId,
      expectedVersion: definition.value.version,
      content,
      correlationId: `view-override-${viewId}-${updatedAt}`,
      updatedAt,
    })
  }

  async proposeWriteback(input: {
    viewId: string
    taskRunId?: string | null
    title: string
    description: string
  }) {
    const definition = await this.views.getDefinition(input.viewId)
    if (!definition.ok) return definition
    if (definition.value.writebackPolicy !== 'propose_changeset') {
      return {
        ok: false as const,
        error: { code: 'validation-error' as const, message: '该 View 是只读视图。' },
      }
    }
    if (!this.work) {
      return {
        ok: false as const,
        error: { code: 'database-unavailable' as const, message: 'Work Repository 不可用。' },
      }
    }
    const now = this.now()
    return this.work.createChangeSet({
      id: this.createId('changeset'),
      taskRunId: input.taskRunId ?? null,
      agentTaskId: null,
      status: 'proposed',
      title: input.title,
      description: input.description,
      patchSetTaskId: null,
      createdAt: now,
      updatedAt: now,
    })
  }

  async forkToDocument(viewId: string): Promise<AppResult<{ id: string }>> {
    const definition = await this.views.getDefinition(viewId)
    if (!definition.ok) return definition
    if (definition.value.writebackPolicy !== 'fork_document') {
      return { ok: false, error: { code: 'validation-error', message: '该 View 未启用分叉文档策略。' } }
    }
    const latest = await this.views.getLatestSnapshot(viewId)
    if (!latest.ok) return latest
    const source = definition.value.manualOverride
      ? definition.value.overrideContent
      : latest.value?.render
    const markdown = extractMarkdown(source)
    if (!markdown.trim()) {
      return { ok: false, error: { code: 'validation-error', message: 'View 没有可分叉的内容。' } }
    }
    const id = this.createId('document')
    const created = await this.documents.create({
      id,
      title: `${definition.value.name}（分叉）`,
      description: `由 View ${definition.value.id} 显式分叉；后续不再自动跟随来源。`,
      contentJson: JSON.stringify(parseMarkdownDocument(markdown)),
      plainText: markdown,
    })
    return created.ok ? { ok: true, value: { id: created.value.id } } : created
  }

  private async refreshGenerated(definition: ViewDefinition): Promise<AppResult<ViewSnapshot>> {
    if (!definition.generation || !this.generatedViewExecutor) {
      return { ok: false, error: { code: 'validation-error', message: 'Generated View 缺少生成配置或执行器。' } }
    }
    const sources = await this.loadExplicitSources(definition.scopeQuery)
    if (!sources.ok) return sources
    const generated = await this.generatedViewExecutor.generate({
      prompt: definition.generation.prompt,
      provider: definition.generation.provider,
      model: definition.generation.model,
      sources: sources.value.render,
    })
    if (!generated.ok) return generated
    const dependencies = sources.value.dependencies
    const createdAt = this.now()
    const snapshot: ViewSnapshot = {
      id: this.createId('view-snapshot'),
      viewId: definition.id,
      status: definition.manualOverride ? 'preview' : 'fresh',
      sourceSnapshotHash: await createSnapshotHash({ dependencies, render: generated.value }),
      render: generated.value,
      provider: definition.generation.provider,
      model: definition.generation.model,
      skillVersions: definition.generation.skillVersions,
      generatedAt: createdAt,
      protectedByOverride: definition.manualOverride,
      correlationId: `view-generation-${definition.id}-${createdAt}`,
      causationId: null,
      error: null,
      createdAt,
    }
    return this.views.commitRefresh({ definition, snapshot, dependencies })
  }

  private async loadExplicitSources(scopeQuery: Record<string, unknown>): Promise<AppResult<{
    render: { documents: unknown[]; knowledge: unknown[] }
    dependencies: ViewDependency[]
  }>> {
    const documentResults = await Promise.all(
      readStringArray(scopeQuery.documentIds).map((id) => this.documents.findById(id)),
    )
    const failedDocument = documentResults.find((result) => !result.ok)
    if (failedDocument && !failedDocument.ok) return { ok: false, error: failedDocument.error }
    const knowledgeResults = await Promise.all(
      readStringArray(scopeQuery.knowledgeObjectIds).map((id) => this.knowledge.getObject(id)),
    )
    const failedKnowledge = knowledgeResults.find((result) => !result.ok)
    if (failedKnowledge && !failedKnowledge.ok) return { ok: false, error: failedKnowledge.error }
    const documents = documentResults.flatMap((result) => (result.ok ? [result.value] : []))
    const objects = knowledgeResults.flatMap((result) => (result.ok ? [result.value] : []))
    return {
      ok: true,
      value: {
        render: {
          documents: documents.map((document) => ({
            id: document.id,
            title: document.title,
            revision: document.revision,
            plainText: document.plainText,
          })),
          knowledge: objects.map(projectKnowledgeObject),
        },
        dependencies: [
          ...documents.map((document) => ({
            sourceType: 'document_block' as const,
            knowledgeObjectId: null,
            documentId: document.id,
            blockId: null,
            sourceRevision: document.revision,
          })),
          ...objects.map((object) => ({
            sourceType: 'knowledge_object' as const,
            knowledgeObjectId: object.id,
            documentId: null,
            blockId: null,
            sourceRevision: object.version,
          })),
        ],
      },
    }
  }
}

function extractMarkdown(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof (value as { content?: unknown }).content === 'string') {
    return (value as { content: string }).content
  }
  return value == null ? '' : `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((item): item is string => typeof item === 'string' && item.trim())))
    : []
}

function projectKnowledgeObject(object: KnowledgeObject) {
  return {
    id: object.id,
    objectType: object.objectType,
    status: object.status,
    title: object.title,
    documentId: object.documentId,
    blockId: object.blockId,
    sourceRevision: object.sourceRevision,
    version: object.version,
  }
}
