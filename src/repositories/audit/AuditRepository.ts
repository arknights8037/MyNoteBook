import type { AuditEntry, AuditQuery } from '@/models/shared/audit'
import type { AppResult } from '@/models/shared/result'

export interface AuditRepository {
  listEntries(query?: AuditQuery): Promise<AppResult<AuditEntry[]>>
}
