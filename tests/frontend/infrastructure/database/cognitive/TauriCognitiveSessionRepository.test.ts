import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { CognitiveSessionService } from '@/services/cognitive/CognitiveSessionService'
import { TauriCognitiveSessionRepository } from '@/infrastructure/database/cognitive/TauriCognitiveSessionRepository'

describe('TauriCognitiveSessionRepository', () => {
  beforeEach(() => invoke.mockReset())

  it('uses Rust commands for session lifecycle operations', async () => {
    invoke.mockResolvedValueOnce(session({ status: 'active', version: 1 }))
    invoke.mockResolvedValueOnce(session({ status: 'waiting_user', version: 2 }))
    invoke.mockResolvedValueOnce([session({ status: 'waiting_user', version: 2 })])
    const service = new CognitiveSessionService(new TauriCognitiveSessionRepository())

    expect((await service.start(input())).ok).toBe(true)
    expect((await service.waitForUser('session-1', 1, { phase: 'waiting' })).ok).toBe(true)
    expect(await service.listByConversation('conversation-1')).toMatchObject({
      ok: true,
      value: [{ status: 'waiting_user', version: 2 }],
    })
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'create_cognitive_session',
      'update_cognitive_session',
      'list_cognitive_sessions',
    ])
  })
})

function input() {
  return {
    id: 'session-1',
    conversationId: 'conversation-1',
    modeId: 'learning' as const,
    modeVersion: 1,
    templateId: 'template',
    templateVersion: 1,
    skillIds: [],
    targetDocumentIds: ['doc-1'],
    targetBlockIds: [],
    state: { phase: 'running' },
    createdAt: 1,
  }
}

function session(overrides: Record<string, unknown>) {
  return {
    id: 'session-1',
    conversationId: 'conversation-1',
    modeId: 'learning',
    modeVersion: 1,
    templateId: 'template',
    templateVersion: 1,
    skillIds: [],
    targetDocumentIds: ['doc-1'],
    targetBlockIds: [],
    state: { phase: 'running' },
    status: 'active',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}
