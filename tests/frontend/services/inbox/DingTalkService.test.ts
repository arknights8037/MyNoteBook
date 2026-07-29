import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DingTalkService } from '@/services/inbox/DingTalkService'
import { ok } from '@/models/shared/result'
import type { ImRepository } from '@/repositories/inbox/ImRepository'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

describe('DingTalkService', () => {
  beforeEach(() => invoke.mockReset().mockResolvedValue(undefined))

  it('verifies credentials before secure storage, persistence and runtime start', async () => {
    const repository = createRepository()
    const service = new DingTalkService(
      repository,
      () => 'im-connector-1',
      () => 10,
    )

    const result = await service.createConnector({
      displayName: '研发钉钉',
      sourceCategory: '工作消息',
      clientId: 'ding-client-id',
      clientSecret: 'secret-value',
    })

    expect(result).toMatchObject({ ok: true, value: { id: 'im-connector-1' } })
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'test_dingtalk_connection',
      'set_dingtalk_connector_secret',
      'start_dingtalk_connector',
    ])
    expect(repository.createConnector).toHaveBeenCalledOnce()
    expect(invoke.mock.calls[1]?.[1]).toEqual({
      input: { connectorId: 'im-connector-1', clientSecret: 'secret-value' },
    })
  })

  it('does not persist an invalid connector', async () => {
    const repository = createRepository()
    const service = new DingTalkService(
      repository,
      () => 'unused',
      () => 10,
    )

    const result = await service.createConnector({
      displayName: '研发钉钉',
      sourceCategory: '工作消息',
      clientId: '',
      clientSecret: '',
    })

    expect(result.ok).toBe(false)
    expect(repository.createConnector).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })
})

function createRepository() {
  return {
    listConnectors: vi.fn(async () => ok([])),
    getConnector: vi.fn(),
    createConnector: vi.fn(async (connector) => ok(connector)),
    deleteConnector: vi.fn(async () => ok(undefined)),
    updateCategory: vi.fn(),
    setEnabled: vi.fn(async (_id, enabled) =>
      ok({ ...connectorValue(), enabled, runtimeStatus: enabled ? 'connecting' : 'stopped' }),
    ),
    listMessages: vi.fn(async () => ok([])),
    setMessageStatus: vi.fn(),
  } satisfies ImRepository
}

function connectorValue() {
  return {
    id: 'im-connector-1',
    provider: 'dingtalk' as const,
    displayName: '研发钉钉',
    sourceCategory: '工作消息',
    clientId: 'ding-client-id',
    enabled: true,
    runtimeStatus: 'online' as const,
    lastConnectedAt: 10,
    lastEventAt: null,
    lastError: null,
    createdAt: 10,
    updatedAt: 10,
  }
}
