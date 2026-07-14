import { getDatabase } from './connection'
import { TauriAutomationRepository } from './TauriAutomationRepository'
import type { AutomationRepository } from '@/repositories/AutomationRepository'

export async function createAutomationRepository(): Promise<AutomationRepository> {
  return new TauriAutomationRepository(await getDatabase())
}
