import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AutomationRun } from '@/models/automation/automation'
import { ok } from '@/models/shared/result'
import { messageServiceKey } from '@/ui/services'

const service = vi.hoisted(() => ({ listRuns: vi.fn() }))
const tauriEvent = vi.hoisted(() => ({
  handler: null as null | ((event: { payload: { latestUpdateAt?: number } }) => void),
  listen: vi.fn(),
  unlisten: vi.fn(),
}))
const notify = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@/app/composition/surfaceServiceProviders', () => ({
  createAutomationServiceProvider: () => async () => service,
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: tauriEvent.listen }))

describe('AutomationNotificationBridge', () => {
  beforeEach(() => {
    Reflect.set(globalThis, '__TAURI_INTERNALS__', { transformCallback: vi.fn() })
    tauriEvent.handler = null
    tauriEvent.listen.mockImplementation(async (_event, handler) => {
      tauriEvent.handler = handler
      return tauriEvent.unlisten
    })
    service.listRuns.mockResolvedValue(ok(initialRuns))
  })

  afterEach(() => {
    Reflect.deleteProperty(globalThis, '__TAURI_INTERNALS__')
    vi.clearAllMocks()
  })

  it('announces each new terminal automation state once without replaying history', async () => {
    const { default: AutomationNotificationBridge } =
      await import('@/features/automation/components/AutomationNotificationBridge.vue')
    const wrapper = mount(AutomationNotificationBridge, {
      global: { provide: { [messageServiceKey as symbol]: notify } },
    })
    await flushPromises()

    expect(notify.success).not.toHaveBeenCalled()
    service.listRuns.mockResolvedValueOnce(
      ok([
        {
          ...initialRuns[0]!,
          status: 'completed',
          outputJson: JSON.stringify({ summary: '已整理新增条目并生成中文摘要。' }),
          completedAt: 20,
        },
        { ...initialRuns[1]!, status: 'waiting_approval', completedAt: 21 },
        { ...initialRuns[2]!, status: 'failed', error: '模型连接超时', completedAt: 22 },
      ]),
    )
    tauriEvent.handler?.({ payload: { latestUpdateAt: 22 } })
    await flushPromises()

    expect(notify.success).toHaveBeenCalledWith(
      '自动化“RSS 每日速览”已完成：已整理新增条目并生成中文摘要。',
    )
    expect(notify.warning).toHaveBeenCalledWith('自动化“周报检查”已生成结果，正在等待你的确认')
    expect(notify.error).toHaveBeenCalledWith('自动化“失败巡检”运行失败：模型连接超时')

    tauriEvent.handler?.({ payload: { latestUpdateAt: 22 } })
    await flushPromises()
    expect(service.listRuns).toHaveBeenCalledTimes(2)
    expect(notify.success).toHaveBeenCalledTimes(1)
    wrapper.unmount()
    expect(tauriEvent.unlisten).toHaveBeenCalledTimes(1)
  })
})

const initialRuns: AutomationRun[] = [
  run('run-1', 'RSS 每日速览'),
  run('run-2', '周报检查'),
  run('run-3', '失败巡检'),
]

function run(id: string, automationName: string): AutomationRun {
  return {
    id,
    automationId: `task-${id}`,
    automationName,
    triggerSource: 'schedule',
    status: 'running',
    inputJson: '{}',
    outputJson: null,
    error: null,
    queuedAt: 8,
    startedAt: 10,
    completedAt: null,
    runId: `agent-${id}`,
    agentTaskId: null,
    attemptCount: 1,
    nextAttemptAt: null,
    deadLetteredAt: null,
    lastFailureKind: null,
  }
}
