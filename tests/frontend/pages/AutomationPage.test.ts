import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import AutomationPage from '@/pages/AutomationPage.vue'
import type { AutomationTask } from '@/models/automation/automation'
import { ok } from '@/models/shared/result'
import type { AutomationRepository } from '@/repositories/automation/AutomationRepository'

const repository = vi.hoisted(() => ({
  listTasks: vi.fn(),
  listDueTasks: vi.fn(),
  createTask: vi.fn(),
  setTaskEnabled: vi.fn(),
  deleteTask: vi.fn(),
  enqueueRun: vi.fn(),
  listRuns: vi.fn(),
  updateRunStatus: vi.fn(),
}))

vi.mock('@/infrastructure/database/automation/automationRepositoryFactory', () => ({
  createAutomationRepository: async () => repository as unknown as AutomationRepository,
}))

describe('AutomationPage', () => {
  it('shows persisted task definitions and queue state', async () => {
    repository.listTasks.mockResolvedValue(ok([task()]))
    repository.listRuns.mockResolvedValue(
      ok([
        {
          id: 'run-1',
          automationId: 'automation-1',
          automationName: '每日总结',
          triggerSource: 'manual',
          status: 'queued',
          inputJson: '{}',
          outputJson: null,
          error: null,
          queuedAt: 200,
          startedAt: null,
          completedAt: null,
        },
      ]),
    )

    const wrapper = mount(AutomationPage, {
      props: { currentDocumentId: 'doc-1', currentDocumentTitle: '项目记录' },
      global: { stubs: { Teleport: true } },
    })
    await flushPromises()

    expect(wrapper.get('.operations-page__header').text()).toContain('自动化任务')
    expect(wrapper.get('.automation-row').text()).toContain('每日总结')

    const runsTab = wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text().includes('运行记录'))
    await runsTab?.trigger('click')
    expect(wrapper.get('.automation-run-row').text()).toContain('等待执行器')
  })
})

function task(): AutomationTask {
  return {
    id: 'automation-1',
    name: '每日总结',
    instruction: '总结项目进展',
    triggerType: 'daily',
    triggerConfig: { dailyTime: '09:00' },
    documentId: 'doc-1',
    enabled: true,
    nextRunAt: 1_000,
    lastRunAt: null,
    createdAt: 1,
    updatedAt: 1,
  }
}
