import type { ImConnector, ImMessage, ImProcessingStatus } from '@/models/inbox/im'
import type { AppResult } from '@/models/shared/result'

export interface ImRepository {
  listConnectors(): Promise<AppResult<ImConnector[]>>
  getConnector(id: string): Promise<AppResult<ImConnector>>
  createConnector(connector: ImConnector): Promise<AppResult<ImConnector>>
  deleteConnector(id: string): Promise<AppResult<void>>
  updateCategory(
    id: string,
    sourceCategory: string,
    updatedAt: number,
  ): Promise<AppResult<ImConnector>>
  setEnabled(id: string, enabled: boolean, updatedAt: number): Promise<AppResult<ImConnector>>
  listMessages(input?: {
    connectorId?: string
    status?: ImProcessingStatus
    limit?: number
  }): Promise<AppResult<ImMessage[]>>
  setMessageStatus(id: string, status: ImProcessingStatus): Promise<AppResult<ImMessage>>
}
