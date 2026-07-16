import { getDatabase } from './connection'
import { TauriWorkspaceViewRepository } from './TauriWorkspaceViewRepository'
export async function createWorkspaceViewRepository(): Promise<TauriWorkspaceViewRepository> { return new TauriWorkspaceViewRepository(await getDatabase()) }
