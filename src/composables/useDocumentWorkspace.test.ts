import { describe, expect, it } from 'vitest'
import { effectScope, ref } from 'vue'

import { useDocumentWorkspace } from './useDocumentWorkspace'
import type {
  CreateDocumentInput,
  DocumentId,
  DocumentRecord,
  DocumentSummary,
  SaveDocumentInput,
  UpdateDocumentInput,
} from '@/models/document'
import { err, ok, type AppResult } from '@/models/result'
import type { DocumentBlock } from '@/models/documentBlock'
import type { DocumentRepository } from '@/repositories/DocumentRepository'
import { DocumentService } from '@/services/DocumentService'

describe('useDocumentWorkspace', () => {
  it('initializes an empty workspace and creates its first document', async () => {
    const repository = new MemoryDocumentRepository()
    const workspace = createWorkspace(repository)

    await workspace.initializeDocuments()

    expect(workspace.documents.value).toHaveLength(1)
    expect(workspace.currentDocument.value?.title).toBe('未命名文档')
    expect(workspace.autosave.revision.value).toBe(1)
    expect(workspace.state.currentDocument).toBe(workspace.currentDocument)
    expect(workspace.lifecycle.select).toBe(workspace.selectDocument)
  })

  it('flushes the active document before selecting another document', async () => {
    const repository = new MemoryDocumentRepository()
    const workspace = createWorkspace(repository)
    await workspace.initializeDocuments()
    const firstId = workspace.currentDocumentId.value
    const second = await workspace.createDocument('第二页')
    expect(second).not.toBeNull()

    workspace.documentTitle.value = '已保存的新标题'
    workspace.autosave.markDirty()
    await workspace.selectDocument(second!.id)

    expect((await repository.findById(firstId)).value.title).toBe('已保存的新标题')
    expect(workspace.currentDocumentId.value).toBe(second!.id)
  })

  it('renames, updates properties, and soft deletes through one transaction boundary', async () => {
    const repository = new MemoryDocumentRepository()
    const workspace = createWorkspace(repository)
    await workspace.initializeDocuments()
    const document = workspace.currentDocument.value!

    workspace.startRename(document)
    expect(workspace.metadata.rename.document.value?.id).toBe(document.id)
    workspace.renameTitle.value = '项目说明'
    await workspace.commitRename()
    workspace.openDocumentProperties(workspace.currentDocument.value!)
    workspace.propertiesDraftTags.value = '设计、需求'
    workspace.propertiesDraftAuthor.value = 'Codex'
    await workspace.saveDocumentProperties()

    expect(workspace.currentDocument.value?.tags).toEqual(['设计', '需求'])
    expect(workspace.currentDocument.value?.author).toBe('Codex')

    await workspace.deleteDocument(workspace.currentDocument.value!)
    expect(workspace.trash.delete).toBe(workspace.deleteDocument)
    expect(workspace.deletedDocuments.value.some((item) => item.id === document.id)).toBe(true)
    expect(workspace.currentDocumentId.value).not.toBe(document.id)
  })
})

function createWorkspace(repository: MemoryDocumentRepository) {
  const scope = effectScope()
  let sequence = 0
  return scope.run(() =>
    useDocumentWorkspace({
      settings: ref({
        autosaveDelay: 60_000,
        confirmBeforeDelete: false,
        startupBehavior: 'first',
      }),
      createService: async () => new DocumentService(repository),
      createId: () => `doc-${++sequence}`,
      authorize: async () => true,
      storage: null,
    }),
  )!
}

class MemoryDocumentRepository implements DocumentRepository {
  private records = new Map<DocumentId, DocumentRecord>()

  async create(input: CreateDocumentInput): Promise<AppResult<DocumentRecord>> {
    return this.save({
      id: input.id,
      expectedRevision: null,
      parentId: input.parentId,
      documentKind: input.documentKind,
      title: input.title ?? '',
      tags: input.tags,
      sourceUrl: input.sourceUrl,
      author: input.author,
      description: input.description,
      contentJson: input.contentJson ?? '{"type":"doc"}',
      plainText: input.plainText ?? '',
      sortOrder: input.sortOrder,
    })
  }

  async findById(id: DocumentId): Promise<AppResult<DocumentRecord>> {
    const record = this.records.get(id)
    return record ? ok({ ...record }) : err({ code: 'not-found', message: 'Not found' })
  }

  async listByParent(parentId: DocumentId | null): Promise<AppResult<DocumentSummary[]>> {
    return ok(this.active().filter((item) => item.parentId === parentId))
  }

  async listRecent(): Promise<AppResult<DocumentSummary[]>> {
    return ok(this.active())
  }

  async listDeleted(): Promise<AppResult<DocumentSummary[]>> {
    return ok([...this.records.values()].filter((item) => item.isDeleted))
  }

  async searchKnowledge(): Promise<AppResult<DocumentSummary[]>> {
    return ok(this.active())
  }

  async listBlocks(): Promise<AppResult<DocumentBlock[]>> {
    return ok([])
  }

  async update(input: UpdateDocumentInput): Promise<AppResult<DocumentRecord>> {
    const current = this.records.get(input.id)
    if (!current || current.revision !== input.expectedRevision) {
      return err({ code: 'revision-conflict', message: 'Revision conflict' })
    }
    return this.store({ ...current, ...input, revision: current.revision + 1 })
  }

  async save(input: SaveDocumentInput): Promise<AppResult<DocumentRecord>> {
    const current = this.records.get(input.id)
    if (current && current.revision !== input.expectedRevision) {
      return err({ code: 'revision-conflict', message: 'Revision conflict' })
    }
    const now = Date.now()
    return this.store({
      id: input.id,
      parentId: input.parentId ?? null,
      documentKind: input.documentKind ?? 'article',
      title: input.title,
      tags: input.tags ?? current?.tags ?? [],
      sourceUrl: input.sourceUrl ?? current?.sourceUrl ?? '',
      author: input.author ?? current?.author ?? '',
      description: input.description ?? current?.description ?? '',
      contentJson: input.contentJson,
      plainText: input.plainText,
      schemaVersion: 2,
      revision: (current?.revision ?? 0) + 1,
      sortOrder: input.sortOrder ?? 0,
      isDeleted: false,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    })
  }

  async softDelete(id: DocumentId, expectedRevision: number): Promise<AppResult<DocumentRecord>> {
    return this.setDeleted(id, expectedRevision, true)
  }

  async restore(id: DocumentId, expectedRevision: number): Promise<AppResult<DocumentRecord>> {
    return this.setDeleted(id, expectedRevision, false)
  }

  async hardDelete(id: DocumentId, expectedRevision: number): Promise<AppResult<DocumentRecord>> {
    const current = this.records.get(id)
    if (!current || current.revision !== expectedRevision) {
      return err({ code: 'revision-conflict', message: 'Revision conflict' })
    }
    this.records.delete(id)
    return ok(current)
  }

  private active(): DocumentRecord[] {
    return [...this.records.values()].filter((item) => !item.isDeleted)
  }

  private store(record: DocumentRecord): AppResult<DocumentRecord> {
    this.records.set(record.id, record)
    return ok({ ...record })
  }

  private setDeleted(
    id: DocumentId,
    expectedRevision: number,
    isDeleted: boolean,
  ): Promise<AppResult<DocumentRecord>> {
    const current = this.records.get(id)
    if (!current || current.revision !== expectedRevision) {
      return Promise.resolve(err({ code: 'revision-conflict', message: 'Revision conflict' }))
    }
    return Promise.resolve(this.store({ ...current, isDeleted, revision: current.revision + 1 }))
  }
}
