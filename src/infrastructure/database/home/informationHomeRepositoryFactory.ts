import { TauriInformationHomeRepository } from '@/infrastructure/database/home/TauriInformationHomeRepository'
import { getDatabase } from '@/infrastructure/database/shared/connection'

export async function createInformationHomeRepository() {
  return new TauriInformationHomeRepository(await getDatabase())
}
