import type { AuditEntry, AuditQuery } from '@/models/audit'
import type { AppResult } from '@/models/result'

export interface AuditRepository {
  listEntries(query?: AuditQuery): Promise<AppResult<AuditEntry[]>>
}
