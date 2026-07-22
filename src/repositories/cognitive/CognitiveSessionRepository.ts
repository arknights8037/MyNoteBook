import type {
  CognitiveSession,
  CognitiveSessionStatus,
  CreateCognitiveSessionInput,
} from '@/models/cognitive/cognitive'
import type { AppResult } from '@/models/shared/result'

export interface CognitiveSessionRepository {
  create(input: CreateCognitiveSessionInput): Promise<AppResult<CognitiveSession>>
  get(id: string): Promise<AppResult<CognitiveSession>>
  listByConversation(conversationId: string): Promise<AppResult<CognitiveSession[]>>
  update(input: {
    id: string
    expectedVersion: number
    state?: Record<string, unknown>
    status?: CognitiveSessionStatus
    updatedAt?: number
  }): Promise<AppResult<CognitiveSession>>
}
