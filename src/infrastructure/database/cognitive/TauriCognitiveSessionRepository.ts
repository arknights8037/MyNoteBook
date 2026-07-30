import type {
  CognitiveModeId,
  CognitiveSession,
  CognitiveSessionStatus,
  CreateCognitiveSessionInput,
} from '@/models/cognitive/cognitive'
import { invoke } from '@tauri-apps/api/core'
import { err, normalizeError, ok, type AppResult } from '@/models/shared/result'
import type { CognitiveSessionRepository } from '@/repositories/cognitive/CognitiveSessionRepository'
import { loadAppSettings } from '@/models/settings/settings'

interface CognitiveSessionRow extends Record<string, unknown> {
  id: string
  conversationId: string
  modeId: CognitiveModeId
  modeVersion: number
  templateId: string | null
  templateVersion: number | null
  skillIds: string[]
  targetDocumentIds: string[]
  targetBlockIds: string[]
  state: Record<string, unknown>
  status: CognitiveSessionStatus
  version: number
  createdAt: number
  updatedAt: number
}

export class TauriCognitiveSessionRepository implements CognitiveSessionRepository {
  async create(input: CreateCognitiveSessionInput): Promise<AppResult<CognitiveSession>> {
    if (!input.id.trim() || !input.conversationId.trim() || input.modeVersion < 1) {
      return err({
        code: 'validation-error',
        message: 'Cognitive Session 缺少有效 ID、会话或模式版本。',
      })
    }
    const now = input.createdAt ?? Date.now()
    try {
      const value = await invoke<CognitiveSessionRow>('create_cognitive_session', {
        input: {
          ...input,
          status: input.status ?? 'active',
          createdAt: now,
          dataDirectory: loadAppSettings().dataDirectory,
        },
      })
      return ok(mapSession(value))
    } catch (error) {
      return err(normalizeError(error, '无法创建 Cognitive Session。'))
    }
  }

  async get(id: string): Promise<AppResult<CognitiveSession>> {
    try {
      return ok(
        mapSession(
          await invoke<CognitiveSessionRow>('get_cognitive_session', {
            input: { id, dataDirectory: loadAppSettings().dataDirectory },
          }),
        ),
      )
    } catch (error) {
      return err(normalizeError(error, '无法读取 Cognitive Session。'))
    }
  }

  async listByConversation(conversationId: string): Promise<AppResult<CognitiveSession[]>> {
    try {
      const rows = await invoke<CognitiveSessionRow[]>('list_cognitive_sessions', {
        input: { conversationId, dataDirectory: loadAppSettings().dataDirectory },
      })
      return ok(rows.map(mapSession))
    } catch (error) {
      return err(normalizeError(error, '无法列出 Cognitive Session。'))
    }
  }

  async update(input: {
    id: string
    expectedVersion: number
    state?: Record<string, unknown>
    status?: CognitiveSessionStatus
    updatedAt?: number
  }): Promise<AppResult<CognitiveSession>> {
    try {
      const value = await invoke<CognitiveSessionRow>('update_cognitive_session', {
        input: {
          ...input,
          updatedAt: input.updatedAt ?? Date.now(),
          dataDirectory: loadAppSettings().dataDirectory,
        },
      })
      return ok(mapSession(value))
    } catch (error) {
      return err(normalizeError(error, '无法更新 Cognitive Session。'))
    }
  }
}

function mapSession(row: CognitiveSessionRow): CognitiveSession {
  return {
    ...row,
  }
}
