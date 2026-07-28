import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import DashboardSurface from '@/features/dashboard/components/DashboardSurface.vue'
import type { DashboardViewPayload } from '@/models/workspace/workspaceView'
import type { AutomationService } from '@/services/automation/AutomationService'

describe('DashboardSurface', () => {
  it('keeps layout changes local until the user saves', async () => {
    const payload: DashboardViewPayload = {
      type: 'dashboard',
      scope: { kind: 'global' },
      layoutVersion: 1,
      widgets: [],
    }
    const wrapper = mount(DashboardSurface, {
      props: {
        payload,
        agentTasks: [],
        getAutomationService: vi.fn(async () => ({}) as AutomationService),
      },
      global: {
        stubs: { DashboardGrid: { template: '<div data-test="dashboard-grid" />' } },
      },
    })

    await findButton(wrapper, '编辑面板').trigger('click')
    await findButton(wrapper, '组件库').trigger('click')
    await findButton(wrapper, '自动化结果').trigger('click')

    expect(wrapper.emitted('update')).toBeUndefined()
    await findButton(wrapper, '保存布局').trigger('click')

    const saved = wrapper.emitted<DashboardViewPayload[]>('update')?.[0]?.[0]
    expect(saved?.widgets).toHaveLength(1)
    expect(saved?.widgets[0]).toMatchObject({ widgetType: 'automation-results' })
  })
})

function findButton(wrapper: ReturnType<typeof mount>, label: string) {
  const button = wrapper.findAll('button').find((candidate) => candidate.text().includes(label))
  if (!button) throw new Error(`Button not found: ${label}`)
  return button
}
