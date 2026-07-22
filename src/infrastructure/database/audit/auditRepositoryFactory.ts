import { getDatabase } from '@/infrastructure/database/shared/connection'
import { TauriAuditRepository } from '@/infrastructure/database/audit/TauriAuditRepository'
import type { AuditRepository } from '@/repositories/audit/AuditRepository'

export async function createAuditRepository(): Promise<AuditRepository> {
  return new TauriAuditRepository(await getDatabase())
}
