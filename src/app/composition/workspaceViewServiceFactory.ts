import { createWorkspaceViewRepository } from '@/infrastructure/database/workspaceViewRepositoryFactory'
import { createEntityId } from '@/models/id'
import { WorkspaceViewService } from '@/services/WorkspaceViewService'
export async function createWorkspaceViewService(): Promise<WorkspaceViewService> { return new WorkspaceViewService(await createWorkspaceViewRepository(), createEntityId, Date.now) }
