import { createImRepository } from '@/infrastructure/database/inbox/imRepositoryFactory'
import { createEntityId } from '@/models/shared/id'
import { DingTalkService } from '@/services/inbox/DingTalkService'

export async function createDingTalkService(): Promise<DingTalkService> {
  return new DingTalkService(await createImRepository(), createEntityId, Date.now)
}
