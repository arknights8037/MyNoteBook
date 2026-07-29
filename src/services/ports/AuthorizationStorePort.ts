import type { ApprovalStatus, AuthorizationRecordInput } from '@/models/agent/authorization'

export interface AuthorizationStorePort {
  record(input: AuthorizationRecordInput): Promise<void>
  resolve(input: {
    id: string
    status: Exclude<ApprovalStatus, 'pending'>
    details: Record<string, unknown>
    decidedAt: number
  }): Promise<void>
}
