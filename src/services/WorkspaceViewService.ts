import { createDefaultWorkspaceViewPayload, type StructuredWorkspaceViewPayload, type StructuredWorkspaceViewType, type WorkspaceViewOperation, applyWorkspaceViewOperation } from '@/models/workspaceView'
import type { WorkspaceViewRepository } from '@/repositories/WorkspaceViewRepository'

export class WorkspaceViewService {
  constructor(private readonly repository: WorkspaceViewRepository, private readonly createId: (prefix: string) => string, private readonly now: () => number = Date.now) {}
  list() { return this.repository.list() }
  get(id: string) { return this.repository.get(id) }
  create(type: StructuredWorkspaceViewType, title: string, parentId: string | null = null) { return this.repository.create({ id: this.createId('workspace-view'), parentId, viewType: type, title, payload: createDefaultWorkspaceViewPayload(type, this.createId), createdAt: this.now() }) }
  update(input: { id: string; expectedVersion: number; title: string; payload: StructuredWorkspaceViewPayload }) { return this.repository.update({ ...input, updatedAt: this.now() }) }
  move(input: { id: string; expectedVersion: number; parentId: string | null; sortOrder?: number }) { return this.repository.move({ ...input, updatedAt: this.now() }) }
  delete(id: string) { return this.repository.delete(id) }
  async applyOperation(id: string, expectedVersion: number, operation: WorkspaceViewOperation) {
    const current = await this.repository.get(id)
    if (!current.ok) return current
    if (current.value.version !== expectedVersion) return { ok: false as const, error: { code: 'revision-conflict' as const, message: '视图版本已变化。' } }
    return this.update({ id, expectedVersion, title: current.value.title, payload: applyWorkspaceViewOperation(current.value.payload, operation) })
  }
}
