import { getDatabase } from '@/infrastructure/database/shared/connection'
import { TauriWorkspaceViewRepository } from '@/infrastructure/database/workspace/TauriWorkspaceViewRepository'
export async function createWorkspaceViewRepository(): Promise<TauriWorkspaceViewRepository> { return new TauriWorkspaceViewRepository(await getDatabase()) }
