import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import AiChatPanel from './AiChatPanel.vue'
import { createAiSettings } from '@/models/ai'
import type { AgentRuntimeViewState } from '@/models/agentRuntime'

function runtimeState(status: AgentRuntimeViewState['status'] = 'running'): AgentRuntimeViewState {
  return {
    status,
    phase:
      status === 'running'
        ? 'tool_running'
        : status === 'waiting_authorizer'
          ? 'waiting_authorizer'
          : 'completed',
    detail:
      status === 'running'
        ? '正在搜索知识库'
        : status === 'waiting_authorizer'
          ? '等待授权人回答'
          : '修改提案已准备，等待确认',
    startedAt: 1_000,
    completedAt: status === 'running' ? null : 2_500,
    rounds: status === 'running' ? 0 : 2,
    toolCalls: [
      {
        id: 'call-1',
        taskId: 'task-1',
        toolName: 'search_documents',
        argumentsJson: JSON.stringify({ query: '差旅报销', limit: 5 }),
        resultJson:
          status === 'running'
            ? null
            : JSON.stringify([{ documentId: 'policy-1', title: '差旅制度' }]),
        status: status === 'running' ? 'running' : 'completed',
        startedAt: 1_200,
        completedAt: status === 'running' ? null : 1_700,
        error: null,
      },
    ],
    authorizationRequest: null,
  }
}

function createWrapper(state = runtimeState()) {
  const settings = createAiSettings('openai')
  settings.model = 'test-model'
  const isActive = state.status === 'running' || state.status === 'waiting_authorizer'
  return mount(AiChatPanel, {
    props: {
      workspace: false,
      mode: 'agent',
      modeLabel: 'Agent',
      modeOptions: [],
      providerLabel: 'OpenAI',
      providerOptions: [],
      reasoningLabel: '标准',
      reasoningOptions: [],
      modelOptions: ['test-model'],
      settings,
      messages: [
        {
          id: 'message-user',
          role: 'user',
          mode: 'agent',
          content: '查找差旅制度',
          status: 'done',
        },
        {
          id: 'message-assistant',
          role: 'assistant',
          mode: 'agent',
          content: isActive ? '' : '已根据制度完成处理。',
          status: isActive ? 'streaming' : 'done',
        },
      ],
      currentDocumentTitle: '差旅说明',
      knowledgeSourceCount: 4,
      prompt: '',
      promptPlaceholder: '描述任务',
      error: '',
      isRunning: isActive,
      agentStep: state.detail,
      runtimeState: state,
      renderMarkdownMessage: (markdown: string) => markdown,
    },
    global: {
      stubs: { Teleport: true },
    },
  })
}

describe('AiChatPanel runtime visibility', () => {
  it('shows the live loop inside the current assistant message', () => {
    const wrapper = createWrapper()

    const assistantMessage = wrapper.get('.ai-chat-message--assistant')
    expect(assistantMessage.get('.ai-agent-loop').text()).toContain('正在搜索知识库')
    expect(assistantMessage.get('.ai-agent-loop').text()).toContain('运行中')
    expect(wrapper.get('.ai-agent-tool-list').text()).toContain('搜索知识库')
    expect(wrapper.get('.ai-agent-tool-list').text()).toContain('search_documents')
    expect(wrapper.get('.ai-agent-tool-list').text()).toContain('差旅报销')
    expect(wrapper.get('.ai-agent-tool-step').attributes('open')).toBeUndefined()
    expect(wrapper.find('.ai-chat-message__waiting').exists()).toBe(false)
  })

  it('keeps the latest tool trace visible after completion', () => {
    const wrapper = createWrapper(runtimeState('completed'))

    expect(wrapper.get('.ai-agent-loop').text()).toContain('已完成')
    expect(wrapper.get('.ai-agent-loop').text()).toContain('2 轮')
    expect(wrapper.get('.ai-agent-tool-step__preview').text()).toContain('差旅制度')
    expect(wrapper.get('.ai-agent-tool-step__status').text()).toContain('返回 1 项')
    expect(wrapper.find('button[aria-label="停止 Agent"]').exists()).toBe(false)
  })

  it('opens the slash menu and selects plan mode with the keyboard', async () => {
    const wrapper = createWrapper(runtimeState('completed'))
    await wrapper.get('button[aria-label="打开 Agent 斜杠菜单"]').trigger('click')
    expect(wrapper.emitted('update:prompt')?.at(-1)).toEqual(['/'])

    await wrapper.setProps({ prompt: '/pla' })
    expect(wrapper.get('.ai-slash-menu').text()).toContain('/plan · 计划模式')
    expect(wrapper.find('.ai-slash-menu > header').exists()).toBe(false)
    expect(wrapper.find('.ai-slash-menu em').exists()).toBe(false)
    await wrapper.get('textarea[aria-label="AI 输入"]').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('select-mode')?.at(-1)).toEqual(['agent'])
    expect(wrapper.emitted('update:prompt')?.at(-1)).toEqual(['/plan '])
  })
})
