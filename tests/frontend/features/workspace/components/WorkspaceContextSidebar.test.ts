import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import WorkspaceContextSidebar from '@/features/workspace/components/WorkspaceContextSidebar.vue'
import { UNGROUPED_AGENT_PROJECT_ID } from '@/models/ai/aiChatHistory'

describe('WorkspaceContextSidebar Agent tasks', () => {
  it('creates from the selected project and exposes a button on every project row', async () => {
    const wrapper = createWrapper('project-1')

    await wrapper.get('.context-sidebar__actions button:last-child').trigger('click')
    expect(wrapper.emitted('new-task')?.at(-1)).toEqual(['project-1'])

    await wrapper.get('button[aria-label="在项目中新建任务：Project One"]').trigger('click')
    expect(wrapper.emitted('new-task')?.at(-1)).toEqual(['project-1'])
  })

  it('creates an ungrouped draft when no project group is selected', async () => {
    const wrapper = createWrapper(UNGROUPED_AGENT_PROJECT_ID)

    await wrapper.get('.context-sidebar__actions button:last-child').trigger('click')
    expect(wrapper.emitted('new-task')?.at(-1)).toEqual([null])
    expect(wrapper.get('button[aria-label="新建未分组任务"]').exists()).toBe(true)
  })

  it('renders an in-memory new-conversation anchor without destructive actions', () => {
    const wrapper = createWrapper('project-1', [
      {
        id: 'draft-1',
        projectId: 'project-1',
        title: '新对话',
        createdAt: 2,
        updatedAt: 2,
        messageCount: 0,
        provider: 'openai',
        model: 'test-model',
        pinnedAt: null,
        messages: [],
        transient: true,
      },
    ])

    const draft = wrapper.get('.context-sidebar__history-row.is-draft')
    expect(draft.text()).toContain('新对话')
    expect(draft.text()).toContain('尚未保存')
    expect(draft.find('button[aria-label^="删除对话"]').exists()).toBe(false)
  })
})

function createWrapper(
  currentProjectId: string,
  histories: InstanceType<typeof WorkspaceContextSidebar>['$props']['histories'] = [],
) {
  return mount(WorkspaceContextSidebar, {
    props: {
      activeSurface: 'agent',
      knowledgeSection: 'overview',
      pluginSection: 'overview',
      automationSection: 'overview',
      auditCategory: 'all',
      settingsSection: 'general',
      projects: [
        {
          id: 'project-1',
          name: 'Project One',
          workspaceRootIds: ['group-1'],
          pinnedAt: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      histories,
      currentProjectId,
      currentHistoryId: null,
    },
  })
}
