import { createMindMapRepository } from '@/infrastructure/database/mindMapRepositoryFactory'
import { createEntityId } from '@/models/id'
import { MindMapService } from '@/services/MindMapService'

export async function createMindMapService(): Promise<MindMapService> {
  return new MindMapService(await createMindMapRepository(), createEntityId, Date.now)
}
