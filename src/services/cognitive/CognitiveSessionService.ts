import type { CognitiveSession, CreateCognitiveSessionInput } from '@/models/cognitive/cognitive'
import type { AppResult } from '@/models/shared/result'
import type { CognitiveSessionRepository } from '@/repositories/cognitive/CognitiveSessionRepository'

export class CognitiveSessionService {
  constructor(private readonly sessions: CognitiveSessionRepository) {}

  start(input: CreateCognitiveSessionInput): Promise<AppResult<CognitiveSession>> {
    return this.sessions.create({ ...input, status: 'active' })
  }

  listByConversation(conversationId: string): Promise<AppResult<CognitiveSession[]>> {
    return this.sessions.listByConversation(conversationId)
  }

  waitForUser(
    id: string,
    expectedVersion: number,
    state: Record<string, unknown>,
  ): Promise<AppResult<CognitiveSession>> {
    return this.sessions.update({ id, expectedVersion, state, status: 'waiting_user' })
  }

  resume(id: string, expectedVersion: number): Promise<AppResult<CognitiveSession>> {
    return this.sessions.update({ id, expectedVersion, status: 'active' })
  }

  complete(
    id: string,
    expectedVersion: number,
    state?: Record<string, unknown>,
  ): Promise<AppResult<CognitiveSession>> {
    return this.sessions.update({ id, expectedVersion, state, status: 'completed' })
  }

  cancel(id: string, expectedVersion: number): Promise<AppResult<CognitiveSession>> {
    return this.sessions.update({ id, expectedVersion, status: 'cancelled' })
  }
}
