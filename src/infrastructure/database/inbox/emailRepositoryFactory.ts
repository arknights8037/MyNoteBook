import { TauriEmailRepository } from '@/infrastructure/database/inbox/TauriEmailRepository'
import { getDatabase } from '@/infrastructure/database/shared/connection'

export async function createEmailRepository(): Promise<TauriEmailRepository> {
  return new TauriEmailRepository(await getDatabase())
}
