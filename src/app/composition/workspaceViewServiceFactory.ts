import { createWorkspaceViewRepository } from '@/infrastructure/database/workspace/workspaceViewRepositoryFactory'
import { createEntityId } from '@/models/shared/id'
import { WorkspaceViewService } from '@/services/workspace/WorkspaceViewService'
export async function createWorkspaceViewService(): Promise<WorkspaceViewService> { return new WorkspaceViewService(await createWorkspaceViewRepository(), createEntityId, Date.now) }
