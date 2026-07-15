import { describe, expect, it, vi } from 'vitest'

import { executeAgentTool, type AgentToolExecutionContext } from './AgentToolExecutor'

const context: AgentToolExecutionContext = {
  currentDocument: {
    id: 'doc-1',
    title: '任务',
    revision: 2,
    text: 'P0 完成\nP1 进行中',
    blocks: [
      { id: 'p0', type: 'heading', text: 'P0 完成', index: 0 },
      { id: 'p1', type: 'paragraph', text: 'P1 进行中', index: 1 },
    ],
  },
  selectedBlocks: [],
  searchDocuments: async () => [],
  readDocument: async () => null,
}

describe('AgentToolExecutor', () => {
  it('executes whitelisted read tools', async () => {
    const executeNativeTool = vi.fn(async (_name, args) =>
      (args.blocks as AgentToolExecutionContext['currentDocument']['blocks']).filter((block) =>
        block.text.includes('P0'),
      ),
    )
    await expect(
      executeAgentTool(
        { name: 'find_blocks_by_regex', arguments: { pattern: 'P0' } },
        { ...context, executeNativeTool },
      ),
    ).resolves.toMatchObject({ ok: true, value: [{ id: 'p0' }] })
    expect(executeNativeTool).toHaveBeenCalledWith(
      'find_blocks_by_regex',
      expect.objectContaining({ pattern: 'P0', blocks: context.currentDocument.blocks }),
      undefined,
      undefined,
    )
  })

  it('does not execute write tools inside the loop', async () => {
    await expect(
      executeAgentTool({ name: 'replace_text_by_regex', arguments: {} }, context),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('应由 Agent Runtime 捕获'),
    })
  })

  it('lists document groups through the native read tool', async () => {
    const executeNativeTool = vi.fn(async () => [
      { id: 'group-agent-mvp', title: 'agent mvp', childCount: 3 },
    ])
    await expect(
      executeAgentTool(
        { name: 'list_document_groups', arguments: { query: 'agent mvp' } },
        { ...context, executeNativeTool },
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: [{ id: 'group-agent-mvp', title: 'agent mvp' }],
    })
    expect(executeNativeTool).toHaveBeenCalledWith(
      'list_document_groups',
      {
        query: 'agent mvp',
      },
      undefined,
      undefined,
    )
  })

  it('does not start a native tool after cancellation', async () => {
    const controller = new AbortController()
    const executeNativeTool = vi.fn(async () => [])
    controller.abort()

    await expect(
      executeAgentTool(
        {
          callId: 'call-cancelled',
          name: 'find_blocks_by_regex',
          arguments: { pattern: 'P0' },
          signal: controller.signal,
        },
        { ...context, executeNativeTool },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(executeNativeTool).not.toHaveBeenCalled()
  })

  it('delegates the shell tool to the native allowlisted executor', async () => {
    const executeNativeTool = async (name: string, args: Record<string, unknown>) => ({
      name,
      args,
    })
    await expect(
      executeAgentTool(
        {
          name: 'execute_shell',
          arguments: {
            command: 'git',
            args: ['status', '--short'],
            timeoutMs: 5_000,
            maxOutputChars: 8_192,
          },
        },
        { ...context, executeNativeTool },
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        name: 'execute_shell',
        args: {
          command: 'git',
          args: ['status', '--short'],
          timeoutMs: 5_000,
          maxOutputChars: 8_192,
        },
      },
    })
  })

  it('reads a relative file from an enabled skill through the native executor', async () => {
    const executeNativeTool = async (name: string, args: Record<string, unknown>) => ({
      name,
      args,
    })
    await expect(
      executeAgentTool(
        {
          name: 'read_skill_file',
          arguments: { skillId: 'writer', relativePath: 'references/style.md' },
        },
        { ...context, executeNativeTool },
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        name: 'read_skill_file',
        args: { skillId: 'writer', relativePath: 'references/style.md' },
      },
    })
  })

  it('pauses for an authorizer answer and returns it to the model', async () => {
    const requestAuthorizerInput = vi.fn(async () => '保留原结构')
    await expect(
      executeAgentTool(
        {
          name: 'request_authorizer_input',
          arguments: {
            question: '采用哪种结构？',
            context: '两种结构都会改变目录。',
            options: ['保留原结构', '重新分组'],
            allowFreeText: true,
          },
        },
        { ...context, requestAuthorizerInput },
      ),
    ).resolves.toEqual({ ok: true, value: { answer: '保留原结构' } })
    expect(requestAuthorizerInput).toHaveBeenCalledWith({
      question: '采用哪种结构？',
      context: '两种结构都会改变目录。',
      options: ['保留原结构', '重新分组'],
      allowFreeText: true,
    })
  })

  it('rejects shell resource limits outside the native policy', async () => {
    await expect(
      executeAgentTool(
        { name: 'execute_shell', arguments: { command: 'git', timeoutMs: 60_000 } },
        { ...context, executeNativeTool: async () => ({}) },
      ),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('1000 到 30000') })
  })

  it('creates a disabled automation draft only after inline authorization', async () => {
    const requestAuthorizerInput = vi.fn(async () => '创建停用草稿')
    const createAutomationDraft = vi.fn(async (input) => ({ ...input, created: true }))

    await expect(
      executeAgentTool(
        {
          name: 'create_automation_draft',
          arguments: {
            name: '每日摘要',
            instruction: '总结当前文档的新变化',
            triggerType: 'daily',
            dailyTime: '18:30',
          },
        },
        { ...context, requestAuthorizerInput, createAutomationDraft },
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { created: true, name: '每日摘要', triggerConfig: { dailyTime: '18:30' } },
    })
    expect(requestAuthorizerInput).toHaveBeenCalledWith(
      expect.objectContaining({ options: ['创建停用草稿', '取消'], allowFreeText: false }),
    )
    expect(createAutomationDraft).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'doc-1', triggerType: 'daily' }),
    )
  })

  it('does not create a Skill draft when authorization is cancelled', async () => {
    const createSkillDraft = vi.fn(async () => ({ created: true }))
    await expect(
      executeAgentTool(
        {
          name: 'create_skill_draft',
          arguments: {
            name: '周报整理',
            description: '把项目记录整理为周报',
            instructions: '仅在用户要求整理周报时触发。',
          },
        },
        {
          ...context,
          requestAuthorizerInput: async () => '取消',
          createSkillDraft,
        },
      ),
    ).resolves.toEqual({ ok: true, value: { created: false, reason: '用户取消创建。' } })
    expect(createSkillDraft).not.toHaveBeenCalled()
  })
})
