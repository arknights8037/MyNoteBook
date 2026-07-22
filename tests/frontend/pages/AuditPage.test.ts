import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import AuditPage from '@/pages/AuditPage.vue'
import { ok } from '@/models/shared/result'
import type { AuditRepository } from '@/repositories/audit/AuditRepository'

const repository = vi.hoisted(() => ({ listEntries: vi.fn() }))

vi.mock('@/infrastructure/database/audit/auditRepositoryFactory', () => ({
  createAuditRepository: async () => repository as AuditRepository,
}))

describe('AuditPage', () => {
  it('renders mixed audit entries with expandable details', async () => {
    repository.listEntries.mockResolvedValue(
      ok([
        {
          id: 'automation_run:run-1',
          category: 'automation_run',
          entityId: 'automation-1',
          title: '每日总结',
          summary: 'manual',
          status: 'queued',
          severity: 'warning',
          detailsJson: '{"documentId":"doc-1"}',
          createdAt: 200,
          completedAt: null,
        },
        {
          id: 'tool_call:call-1',
          category: 'tool_call',
          entityId: 'task-1',
          title: 'search_documents',
          summary: '工具调用',
          status: 'completed',
          severity: 'success',
          detailsJson: '[]',
          createdAt: 100,
          completedAt: 120,
        },
      ]),
    )

    const wrapper = mount(AuditPage, { global: { stubs: { Teleport: true } } })
    await flushPromises()

    expect(wrapper.get('.operations-page__header').text()).toContain('2 条记录')
    expect(wrapper.findAll('.audit-row')).toHaveLength(2)
    expect(wrapper.get('.audit-table').text()).toContain('search_documents')
  })
})
