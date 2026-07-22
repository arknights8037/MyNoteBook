import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'

import AiChatPanel from '@/features/ai-chat/components/AiChatPanel.vue'
import { createAiSettings } from '@/models/ai/ai'
import { UNGROUPED_AGENT_PROJECT_ID } from '@/models/ai/aiChatHistory'
import type { AgentRuntimeViewState } from '@/models/agent/agentRuntime'

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
    timelineEvents: [
      {
        id: 'decision:task-1:0',
        kind: 'decision',
        status: 'completed',
        detail: '下一步检索知识库，查询“差旅报销”，确认相关资料。',
        occurredAt: 1_050,
        completedAt: 1_100,
        stepNumber: 1,
      },
      {
        id: 'tool:call-1',
        kind: 'tool',
        status: status === 'running' ? 'running' : 'completed',
        detail: status === 'running' ? '正在搜索知识库' : '已完成知识库检索',
        occurredAt: 1_200,
        completedAt: status === 'running' ? null : 1_700,
        toolCallId: 'call-1',
      },
    ],
    authorizationRequest: null,
    summary: status === 'completed' ? '已完成差旅制度检索并生成处理建议。' : '',
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
          agentRuntime: isActive ? undefined : state,
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
      stubs: { Teleport: { template: '<div><slot /></div>' } },
    },
  })
}

describe('AiChatPanel runtime visibility', () => {
  beforeEach(() => {
    globalThis.localStorage?.removeItem('my-notebook:agent-history-collapsed')
  })

  it('selects an explicit target from the @ file menu', async () => {
    const wrapper = createWrapper(runtimeState('completed'))
    await wrapper.setProps({
      prompt: '@制',
      targetOptions: [
        { kind: 'document', id: 'policy-1', title: '差旅制度', subtitle: '知识库页面' },
      ],
    })

    await wrapper.get('.ai-target-menu button').trigger('click')

    expect(wrapper.emitted('select-target')?.at(-1)).toEqual([
      { kind: 'document', id: 'policy-1', title: '差旅制度', subtitle: '知识库页面' },
    ])
    expect(wrapper.emitted('update:prompt')?.at(-1)).toEqual(['@差旅制度 '])
  })

  it('shows and clears one item from the multi-target mode', async () => {
    const wrapper = createWrapper(runtimeState('completed'))
    await wrapper.setProps({
      explicitTargets: [
        { kind: 'knowledge_asset', id: 'asset-1', title: '季度复盘.pdf' },
        { kind: 'knowledge_asset', id: 'asset-2', title: '客户访谈.docx' },
      ],
    })

    expect(wrapper.findAll('.ai-chat-target-chip')).toHaveLength(2)
    await wrapper.findAll('.ai-chat-target-chip button')[0]!.trigger('click')
    expect(wrapper.emitted('clear-target')?.at(-1)).toEqual(['asset-1'])
  })

  it('shows the live loop inside the current assistant message', () => {
    const wrapper = createWrapper()

    const assistantMessage = wrapper.get('.ai-chat-message--assistant')
    expect(assistantMessage.get('.ai-agent-loop').text()).toContain('正在搜索知识库')
    expect(assistantMessage.get('.ai-agent-loop').text()).toContain('运行中')
    expect(wrapper.get('.ai-agent-tool-list').text()).toContain('搜索知识库')
    expect(wrapper.get('.ai-agent-tool-list').text()).toContain('search_documents')
    expect(wrapper.get('.ai-agent-tool-list').text()).toContain('差旅报销')
    expect(wrapper.get('.ai-agent-timeline').text()).toContain('第 1 轮决策')
    expect(wrapper.get('.ai-agent-timeline').text()).toContain('下一步检索知识库')
    expect(wrapper.get('.ai-agent-tool-step').attributes('open')).toBeUndefined()
    expect(wrapper.get('.ai-agent-loop__trace').attributes('open')).toBe('')
    expect(wrapper.get('.ai-agent-timeline__narrative').text()).toContain('下一步检索知识库')
    expect(wrapper.find('.ai-chat-message__waiting').exists()).toBe(false)
  })

  it('keeps the latest tool trace visible after completion', () => {
    const wrapper = createWrapper(runtimeState('completed'))

    expect(wrapper.get('.ai-agent-loop').text()).toContain('已完成')
    expect(wrapper.get('.ai-agent-loop__header').text()).toContain('执行了 1.5 秒')
    expect(wrapper.get('.ai-agent-loop__trace').attributes('open')).toBeUndefined()
    expect(wrapper.get('.ai-agent-loop__trace-summary').text()).toContain('已完成差旅制度检索')
    expect(wrapper.get('.ai-agent-loop').text()).toContain('2 轮')
    expect(wrapper.get('.ai-agent-timeline__decision .ai-agent-timeline__kind').text()).toBe('判断')
    expect(wrapper.get('.ai-agent-tool-step .ai-agent-timeline__kind').text()).toBe('工具')
    expect(wrapper.get('.ai-agent-tool-step__preview').text()).toContain('输出')
    expect(wrapper.get('.ai-agent-tool-step__preview').text()).toContain('差旅制度')
    expect(wrapper.get('.ai-agent-tool-step__status').text()).toContain('返回 1 项')
    expect(wrapper.find('button[aria-label="停止 Agent"]').exists()).toBe(false)
  })

  it('opens an internal document directly from a tool result', async () => {
    const wrapper = createWrapper(runtimeState('completed'))

    await wrapper.get('.ai-agent-tool-results__document').trigger('click')

    expect(wrapper.emitted('open-source')?.at(-1)).toEqual(['policy-1', null])
    expect(wrapper.get('.ai-agent-tool-results__document').text()).toContain('差旅制度')
  })

  it('keeps an earlier Agent reply expandable after a newer reply becomes active', async () => {
    const previousState = runtimeState('completed')
    const activeState = runtimeState('running')
    const wrapper = createWrapper(activeState)
    await wrapper.setProps({
      messages: [
        { id: 'u1', role: 'user', mode: 'agent', content: '第一次任务', status: 'done' },
        {
          id: 'a1',
          role: 'assistant',
          mode: 'agent',
          content: '第一次完成',
          agentRuntime: previousState,
          status: 'done',
        },
        { id: 'u2', role: 'user', mode: 'agent', content: '第二次任务', status: 'done' },
        {
          id: 'a2',
          role: 'assistant',
          mode: 'agent',
          content: '',
          status: 'streaming',
        },
      ],
    })

    const loops = wrapper.findAll('.ai-agent-loop')
    expect(loops).toHaveLength(2)
    expect(loops[0]!.text()).toContain('执行了 1.5 秒')
    expect(loops[0]!.get('.ai-agent-loop__trace').attributes('open')).toBeUndefined()
    expect(loops[1]!.get('.ai-agent-loop__trace').attributes('open')).toBe('')
  })

  it('renders MCP web search results as links and keeps raw JSON secondary', () => {
    const state = runtimeState('completed')
    state.toolCalls[0] = {
      ...state.toolCalls[0]!,
      toolName: 'mcp__exa__web_search_exa',
      argumentsJson: JSON.stringify({ query: 'agent loop UX' }),
      resultJson: JSON.stringify({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              results: [
                {
                  title: 'Agent loop UX guide',
                  url: 'https://example.com/agent-loop',
                  text: 'Use narrative progress around tool calls.',
                },
              ],
            }),
          },
        ],
      }),
    }
    const wrapper = createWrapper(state)

    expect(wrapper.get('.ai-agent-tool-step__fields').text()).toContain('搜索内容')
    expect(wrapper.get('.ai-agent-tool-step__copy strong').text()).toContain('Exa · 网页搜索')
    expect(wrapper.get('.ai-agent-tool-results a').attributes('href')).toBe(
      'https://example.com/agent-loop',
    )
    expect(wrapper.get('.ai-agent-tool-results').text()).toContain('Agent loop UX guide')
    expect(wrapper.get('.ai-agent-tool-step__raw').attributes('open')).toBeUndefined()
  })

  it('renders structured research items and opens their stable source', async () => {
    const wrapper = createWrapper(runtimeState('completed'))
    const messages = [...wrapper.props('messages')]
    messages[1] = {
      ...messages[1]!,
      content: '调研完成。',
      researchResult: {
        summary: '制度存在明确差异。',
        items: [
          {
            id: 'E1',
            kind: 'evidence',
            title: '审批范围',
            content: '制度要求跨部门审批。',
            confidence: 0.95,
            validationStatus: 'verified',
            validationMessage: '来源 revision 与读取时一致。',
            sources: [
              { documentId: 'policy-1', blockId: 'block-7', revision: 4, quote: '需跨部门审批' },
            ],
          },
        ],
        relations: [
          {
            fromItemId: 'E1',
            relationType: 'supports',
            toItemId: 'E1',
            explanation: '来源内容支持该发现。',
          },
        ],
        unresolvedQuestions: ['新制度何时生效？'],
      },
      researchCandidates: [
        {
          itemId: 'E1',
          candidateId: 'candidate-1',
          version: 1,
          decision: 'pending',
          sourceState: 'fresh',
          title: '审批范围',
          content: '制度要求跨部门审批。',
          error: '',
        },
      ],
    }
    await wrapper.setProps({ messages })

    expect(wrapper.get('.ai-research-result__header').text()).toContain('/research')
    expect(wrapper.get('.ai-structured-result__summary').text()).toContain('制度存在明确差异')
    expect(wrapper.get('.ai-research-result').text()).toContain('证据')
    expect(wrapper.get('.ai-research-result').text()).toContain('已定位来源')
    expect(wrapper.get('.ai-research-result__validation').text()).toContain('置信度 95%')
    expect(wrapper.get('.ai-research-result__relations').text()).toContain('E1支持E1')
    expect(wrapper.get('.ai-research-result__questions').text()).toContain('新制度何时生效')
    await wrapper.get('.ai-research-result__sources button').trigger('click')
    expect(wrapper.emitted('open-source')?.at(-1)).toEqual(['policy-1', 'block-7'])
    expect(wrapper.get('.ai-research-candidate__decision').text()).toContain('等待确认 · v1')
    await wrapper.get('.ai-research-candidate__decision button').trigger('click')
    expect(wrapper.emitted('research-candidate-action')?.at(-1)).toEqual([
      {
        messageId: 'message-assistant',
        itemId: 'E1',
        candidateId: 'candidate-1',
        expectedVersion: 1,
        action: 'approve',
      },
    ])
  })

  it('submits edited candidate content as an explicit approval', async () => {
    const wrapper = createWrapper(runtimeState('completed'))
    const messages = [...wrapper.props('messages')]
    messages[1] = {
      ...messages[1]!,
      researchResult: {
        summary: '调研摘要',
        items: [
          {
            id: 'C1',
            kind: 'claim',
            title: '原标题',
            content: '原内容',
            confidence: null,
            validationStatus: 'unverified',
            validationMessage: '无来源',
            sources: [],
          },
        ],
        relations: [],
        unresolvedQuestions: [],
      },
      researchCandidates: [
        {
          itemId: 'C1',
          candidateId: 'candidate-1',
          version: 2,
          decision: 'kept',
          sourceState: 'unverified',
          title: '原标题',
          content: '原内容',
          error: '',
        },
      ],
    }
    await wrapper.setProps({ messages })
    const buttons = wrapper.findAll('.ai-research-candidate__decision button')
    await buttons.find((button) => button.text().includes('编辑'))!.trigger('click')
    await wrapper.get('input[aria-label="候选标题"]').setValue('修订标题')
    await wrapper.get('textarea[aria-label="候选内容"]').setValue('修订内容')
    await wrapper.get('.ai-research-candidate__editor').trigger('submit')

    expect(wrapper.emitted('research-candidate-action')?.at(-1)).toEqual([
      {
        messageId: 'message-assistant',
        itemId: 'C1',
        candidateId: 'candidate-1',
        expectedVersion: 2,
        action: 'approve',
        title: '修订标题',
        content: '修订内容',
      },
    ])
  })

  it('renders read-only Review issues and explicitly requests Patch handling', async () => {
    const wrapper = createWrapper(runtimeState('completed'))
    const messages = [...wrapper.props('messages')]
    messages[1] = {
      ...messages[1]!,
      content: '审阅完成。',
      reviewResult: {
        summary: '发现证据不匹配。',
        issues: [
          {
            id: 'I1',
            issueType: 'evidence_mismatch',
            severity: 'error',
            title: '结论超出证据范围',
            explanation: '证据只覆盖部分场景。',
            affectedText: '适用于所有场景',
            suggestedAction: '收窄结论范围。',
            sources: [
              { documentId: 'policy-1', blockId: 'block-7', revision: 4, quote: '部分场景' },
            ],
            sourceState: 'fresh',
          },
        ],
        unresolvedQuestions: ['是否存在补充证据？'],
      },
      cognitiveProvenance: {
        sessionId: 'review-session',
        runId: 'review-run',
        modeId: 'review',
        modeVersion: 1,
        templateId: 'review-findings',
        templateVersion: 1,
        outputContractId: 'review-result',
        createdAt: 10,
      },
    }
    await wrapper.setProps({ messages })

    expect(wrapper.get('.ai-review-result').text()).toContain('证据不匹配')
    expect(wrapper.get('.ai-review-result__header').text()).toContain('/review')
    expect(wrapper.get('.ai-review-result').text()).toContain('严重度 高')
    expect(wrapper.get('.ai-review-result__suggestion').text()).toContain('建议收窄结论范围')
    expect(wrapper.get('.ai-review-result__questions').text()).toContain('是否存在补充证据')
    await wrapper.get('.ai-review-result__sources button').trigger('click')
    expect(wrapper.emitted('open-source')?.at(-1)).toEqual(['policy-1', 'block-7'])
    await wrapper.get('.ai-review-result__actions button').trigger('click')
    expect(wrapper.emitted('resolve-review-issue')?.at(-1)).toEqual([
      {
        messageId: 'message-assistant',
        issue: messages[1]!.reviewResult!.issues[0],
      },
    ])
  })

  it('renders evidenced Learning feedback, next prompt and non-persisted understanding candidate', async () => {
    const wrapper = createWrapper(runtimeState('completed'))
    const messages = [...wrapper.props('messages')]
    messages[1] = {
      ...messages[1]!,
      content: '已分析本轮尝试。',
      learningResult: {
        phase: 'waiting_user',
        feedback: {
          correctPoints: ['理解了微任务优先级'],
          omissions: ['尚未说明渲染时机'],
          misconceptions: [],
        },
        understandingState: 'partial',
        evidence: '用户明确提到微任务队列会先清空。',
        nextPrompt: { kind: 'guided_question', content: '渲染在哪一步发生？', hintLevel: 1 },
        candidateUnderstanding: {
          title: '事件循环的阶段顺序',
          content: '用户已能说明任务队列的基本顺序。',
          confidence: 0.72,
        },
      },
      learningState: {
        version: 1,
        topic: '事件循环',
        currentPrompt: '渲染在哪一步发生？',
        promptKind: 'guided_question',
        hintLevel: 1,
        attempts: [
          {
            id: 'attempt-1',
            response: '微任务先执行',
            feedback: {
              correctPoints: ['理解了微任务优先级'],
              omissions: ['尚未说明渲染时机'],
              misconceptions: [],
            },
            understandingState: 'partial',
            evidence: '用户明确提到微任务队列会先清空。',
            createdAt: 10,
          },
        ],
        understandingState: 'partial',
        nextStep: 'continue',
      },
      cognitiveProvenance: {
        sessionId: 'learning-session',
        runId: 'learning-run',
        modeId: 'learning',
        modeVersion: 1,
        templateId: 'learning-coach',
        templateVersion: 1,
        outputContractId: 'learning-turn',
        createdAt: 10,
      },
    }
    await wrapper.setProps({ messages })

    expect(wrapper.get('.ai-learning-result__header').text()).toContain('/learning')
    expect(wrapper.get('.ai-learning-result').text()).toContain('部分理解 · 1 次尝试')
    expect(wrapper.get('.ai-learning-result__feedback .is-correct').text()).toContain('已掌握')
    expect(wrapper.get('.ai-learning-result__feedback .is-omission').text()).toContain('仍有遗漏')
    expect(wrapper.get('.ai-learning-result__feedback').text()).toContain('尚未说明渲染时机')
    expect(wrapper.get('.ai-learning-result__evidence').text()).toContain('用户明确提到')
    expect(wrapper.get('.ai-learning-result__next').text()).toContain('渲染在哪一步发生')
    expect(wrapper.get('.ai-learning-result__candidate').text()).toContain('未写入正式知识')
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

  it('manages persistent work history from a collapsible left rail', async () => {
    const wrapper = createWrapper(runtimeState('completed'))
    await wrapper.setProps({
      docked: true,
      currentHistoryId: 'history-1',
      currentProjectId: 'project-1',
      projects: [
        {
          id: 'project-1',
          name: 'StudioSite',
          workspaceRootIds: ['group-1'],
          pinnedAt: null,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      chatHistory: [
        {
          id: 'history-1',
          projectId: 'project-1',
          title: '检查差旅制度',
          updatedAt: Date.now(),
          messageCount: 4,
          provider: 'openai',
          model: 'test-model',
          pinnedAt: null,
        },
      ],
    })

    expect(wrapper.get('.ai-chat-history').text()).toContain('检查差旅制度')
    expect(wrapper.get('.ai-chat-history__item').classes()).toContain('is-active')
    await wrapper.get('.ai-chat-history__select').trigger('click')
    expect(wrapper.emitted('select-history')?.at(-1)).toEqual(['history-1'])
    await wrapper.get('button[aria-label="置顶项目：StudioSite"]').trigger('click')
    expect(wrapper.emitted('pin-project')?.at(-1)).toEqual(['project-1'])
    await wrapper.get('button[aria-label="置顶对话：检查差旅制度"]').trigger('click')
    expect(wrapper.emitted('pin-history')?.at(-1)).toEqual(['history-1'])

    await wrapper.get('button[aria-label="折叠对话历史"]').trigger('click')
    expect(wrapper.get('.ai-chat-history').classes()).toContain('ai-chat-history--collapsed')
    expect(globalThis.localStorage?.getItem('my-notebook:agent-history-collapsed')).toBe('true')
    await wrapper.get('.ai-chat-history__new').trigger('click')
    expect(wrapper.emitted('new-task')?.at(-1)).toEqual([null])
  })

  it('separates ungrouped tasks from project task creation', async () => {
    const wrapper = createWrapper(runtimeState('completed'))
    await wrapper.setProps({
      docked: true,
      currentProjectId: 'project-1',
      projects: [
        {
          id: 'project-1',
          name: 'StudioSite',
          workspaceRootIds: [],
          pinnedAt: null,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    })

    await wrapper.get('button[aria-label="新建未分组任务"]').trigger('click')
    expect(wrapper.emitted('new-task')?.at(-1)).toEqual([null])

    await wrapper.get('button[aria-label="在项目中新建任务：StudioSite"]').trigger('click')
    expect(wrapper.emitted('new-task')?.at(-1)).toEqual(['project-1'])
  })

  it('offers project workspace choices for an ungrouped task', async () => {
    const wrapper = createWrapper(runtimeState('completed'))
    await wrapper.setProps({
      docked: true,
      currentProjectId: UNGROUPED_AGENT_PROJECT_ID,
      projects: [
        {
          id: 'project-1',
          name: '制度项目',
          workspaceRootIds: ['group-policy', 'group-expense'],
          pinnedAt: null,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      chatHistory: [
        {
          id: 'history-loose',
          projectId: UNGROUPED_AGENT_PROJECT_ID,
          title: '未分组调研',
          updatedAt: 2,
          messageCount: 2,
          provider: 'openai',
          model: 'test-model',
          pinnedAt: null,
        },
      ],
    })

    await wrapper.get('button[aria-label="将任务加入项目：未分组调研"]').trigger('click')
    expect(wrapper.get('.ai-chat-history-move-menu').text()).toContain('2 个资料分组')
    await wrapper.get('.ai-chat-history-move-menu__item').trigger('click')
    expect(wrapper.emitted('move-history')?.at(-1)).toEqual(['history-loose', 'project-1'])
  })

  it('creates a project together with its document workspace', async () => {
    const wrapper = createWrapper(runtimeState('completed'))
    await wrapper.setProps({
      docked: true,
      workspaceOptions: [
        { label: 'Agent MVP', value: 'group-agent' },
        { label: 'StudioSite', value: 'group-studio' },
      ],
    })

    await wrapper.get('button[aria-label="新建 Agent 项目"]').trigger('click')
    expect(wrapper.get('.ai-chat-project-dialog').attributes('aria-modal')).toBe('true')
    const workspaceInputs = wrapper.findAll('.ai-chat-project-dialog input[type="checkbox"]')
    await workspaceInputs[1]!.setValue(true)
    expect(wrapper.get('.ai-chat-project-dialog__name input').element).toHaveProperty(
      'value',
      'StudioSite',
    )
    await wrapper.get('.ai-chat-project-dialog__form').trigger('submit')

    expect(wrapper.emitted('create-project')?.at(-1)).toEqual([
      { name: 'StudioSite', workspaceRootIds: ['group-studio'] },
    ])
  })

  it('can create an empty project without requiring a name or workspace', async () => {
    const wrapper = createWrapper(runtimeState('completed'))
    await wrapper.setProps({
      docked: true,
      projects: [
        {
          id: 'project-1',
          name: 'Agent MVP',
          workspaceRootIds: [],
          pinnedAt: null,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    })

    await wrapper.get('button[aria-label="新建 Agent 项目"]').trigger('click')
    await wrapper.get('.ai-chat-project-dialog__form').trigger('submit')

    expect(wrapper.emitted('create-project')?.at(-1)).toEqual([
      { name: '新项目 2', workspaceRootIds: [] },
    ])
    expect(wrapper.find('.ai-chat-project-dialog').exists()).toBe(false)
  })
})
