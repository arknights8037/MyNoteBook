import { createMindMapRepository } from '@/infrastructure/database/workspace/mindMapRepositoryFactory'
import { createEntityId } from '@/models/shared/id'
import { MindMapService } from '@/services/workspace/MindMapService'

export async function createMindMapService(): Promise<MindMapService> {
  return new MindMapService(await createMindMapRepository(), createEntityId, Date.now)
}
