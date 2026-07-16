import type { AppResult } from '@/models/result'
import type { StructuredWorkspaceView, StructuredWorkspaceViewPayload, StructuredWorkspaceViewSummary, StructuredWorkspaceViewType } from '@/models/workspaceView'

export interface WorkspaceViewRepository {
  create(input: { id: string; parentId?: string | null; sortOrder?: number; viewType: StructuredWorkspaceViewType; title: string; payload: StructuredWorkspaceViewPayload; createdAt?: number }): Promise<AppResult<StructuredWorkspaceView>>
  get(id: string): Promise<AppResult<StructuredWorkspaceView>>
  list(): Promise<AppResult<StructuredWorkspaceViewSummary[]>>
  update(input: { id: string; expectedVersion: number; title: string; payload: StructuredWorkspaceViewPayload; updatedAt?: number }): Promise<AppResult<StructuredWorkspaceView>>
  move(input: { id: string; expectedVersion: number; parentId: string | null; sortOrder?: number; updatedAt?: number }): Promise<AppResult<StructuredWorkspaceView>>
  delete(id: string): Promise<AppResult<void>>
}
