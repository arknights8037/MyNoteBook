import { getDatabase } from '@/infrastructure/database/shared/connection'
import { TauriAutomationRepository } from '@/infrastructure/database/automation/TauriAutomationRepository'
import type { AutomationRepository } from '@/repositories/automation/AutomationRepository'

export async function createAutomationRepository(): Promise<AutomationRepository> {
  return new TauriAutomationRepository(await getDatabase())
}
