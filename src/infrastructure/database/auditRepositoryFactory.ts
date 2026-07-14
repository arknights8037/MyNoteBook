import { getDatabase } from './connection'
import { TauriAuditRepository } from './TauriAuditRepository'
import type { AuditRepository } from '@/repositories/AuditRepository'

export async function createAuditRepository(): Promise<AuditRepository> {
  return new TauriAuditRepository(await getDatabase())
}
