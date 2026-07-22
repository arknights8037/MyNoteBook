import {
  createEmptyMindMapContent,
  mindMapToDirectionalText,
  readMindMapSubtree,
  type MindMapContent,
  type MindMapDocument,
  type MindMapSubtreeQuery,
  type MindMapSubtreeResult,
  type MindMapSummary,
} from '@/models/workspace/mindMap'
import type { AppResult } from '@/models/shared/result'
import type { MindMapRepository } from '@/repositories/workspace/MindMapRepository'

export class MindMapService {
  constructor(
    private readonly repository: MindMapRepository,
    private readonly createId: (prefix: string) => string,
    private readonly now: () => number = Date.now,
  ) {}

  list(): Promise<AppResult<MindMapSummary[]>> {
    return this.repository.list()
  }

  get(id: string): Promise<AppResult<MindMapDocument>> {
    return this.repository.get(id)
  }

  create(title: string, parentId: string | null = null): Promise<AppResult<MindMapDocument>> {
    const id = this.createId('mindmap')
    const rootNodeId = this.createId('mindmap-node')
    return this.repository.create({
      id,
      parentId,
      title,
      content: createEmptyMindMapContent(rootNodeId, title),
      actorType: 'user',
      createdAt: this.now(),
    })
  }

  move(input: {
    id: string
    expectedVersion: number
    parentId: string | null
    sortOrder?: number
  }): Promise<AppResult<MindMapDocument>> {
    return this.repository.move({ ...input, actorType: 'user', updatedAt: this.now() })
  }

  delete(id: string): Promise<AppResult<void>> {
    return this.repository.delete(id)
  }

  update(input: {
    id: string
    expectedVersion: number
    title: string
    content: MindMapContent
  }): Promise<AppResult<MindMapDocument>> {
    return this.repository.update({ ...input, actorType: 'user', updatedAt: this.now() })
  }

  async toDirectionalText(id: string): Promise<AppResult<string>> {
    const document = await this.repository.get(id)
    return document.ok ? { ok: true, value: mindMapToDirectionalText(document.value) } : document
  }

  async readSubtree(id: string, query: MindMapSubtreeQuery): Promise<AppResult<MindMapSubtreeResult>> {
    const document = await this.repository.get(id)
    if (!document.ok) return document
    try {
      return { ok: true, value: readMindMapSubtree(document.value, query) }
    } catch (error) {
      return {
        ok: false,
        error: { code: 'validation-error', message: error instanceof Error ? error.message : String(error) },
      }
    }
  }
}
