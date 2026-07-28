import type {
  EmailAccount,
  EmailMessage,
  EmailProcessingStatus,
  RemoteEmailMessage,
} from '@/models/inbox/email'
import type { AppResult } from '@/models/shared/result'

export interface EmailRepository {
  listAccounts(): Promise<AppResult<EmailAccount[]>>
  getAccount(id: string): Promise<AppResult<EmailAccount>>
  createAccount(account: EmailAccount): Promise<AppResult<EmailAccount>>
  deleteAccount(id: string): Promise<AppResult<void>>
  updateSyncState(
    id: string,
    state: { lastSyncedAt: number | null; lastError: string | null; updatedAt: number },
  ): Promise<AppResult<EmailAccount>>
  upsertMessages(
    account: EmailAccount,
    messages: RemoteEmailMessage[],
    syncedAt: number,
  ): Promise<AppResult<number>>
  listMessages(input?: {
    accountId?: string
    status?: EmailProcessingStatus
    limit?: number
  }): Promise<AppResult<EmailMessage[]>>
  setMessageStatus(id: string, status: EmailProcessingStatus): Promise<AppResult<EmailMessage>>
}
