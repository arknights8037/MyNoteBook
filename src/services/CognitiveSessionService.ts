import type { CognitiveSession, CreateCognitiveSessionInput } from '@/models/cognitive'
import type { AppResult } from '@/models/result'
import type { CognitiveSessionRepository } from '@/repositories/CognitiveSessionRepository'

export class CognitiveSessionService {
  constructor(private readonly sessions: CognitiveSessionRepository) {}

  start(input: CreateCognitiveSessionInput): Promise<AppResult<CognitiveSession>> {
    return this.sessions.create({ ...input, status: 'active' })
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
