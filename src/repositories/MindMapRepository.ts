import type { AppResult } from '@/models/result'
import type { MindMapContent, MindMapDocument, MindMapSummary } from '@/models/mindMap'

export interface MindMapRepository {
  create(input: {
    id: string
    parentId?: string | null
    sortOrder?: number
    title: string
    content: MindMapContent
    actorType: 'user' | 'agent' | 'system'
    actorId?: string | null
    createdAt?: number
  }): Promise<AppResult<MindMapDocument>>
  get(id: string): Promise<AppResult<MindMapDocument>>
  list(): Promise<AppResult<MindMapSummary[]>>
  move(input: {
    id: string
    expectedVersion: number
    parentId: string | null
    sortOrder?: number
    actorType: 'user' | 'agent' | 'system'
    actorId?: string | null
    updatedAt?: number
  }): Promise<AppResult<MindMapDocument>>
  delete(id: string): Promise<AppResult<void>>
  update(input: {
    id: string
    expectedVersion: number
    title: string
    content: MindMapContent
    actorType: 'user' | 'agent' | 'system'
    actorId?: string | null
    updatedAt?: number
  }): Promise<AppResult<MindMapDocument>>
}
