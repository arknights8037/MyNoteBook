import { describe, expect, it, vi } from 'vitest'

import { executeAgentTool, type AgentToolExecutionContext } from './AgentToolExecutor'

const context: AgentToolExecutionContext = {
  currentDocument: {
    id: 'doc-1',
    title: '任务',
    revision: 2,
    text: 'P0 完成\nP1 进行中',
    markdown: '# P0 完成\n\nP1 **进行中**\n',
    blocks: [
      { id: 'p0', type: 'heading', text: 'P0 完成', markdown: '# P0 完成', index: 0 },
      { id: 'p1', type: 'paragraph', text: 'P1 进行中', markdown: 'P1 **进行中**', index: 1 },
    ],
  },
  selectedBlocks: [],
  searchDocuments: async () => [],
  readDocument: async () => null,
}

describe('AgentToolExecutor', () => {
  it('projects the current document and selected blocks as Markdown observations', async () => {
    const current = await executeAgentTool({ name: 'get_current_document', arguments: {} }, context)
    const selected = await executeAgentTool(
      { name: 'get_selected_blocks', arguments: {} },
      { ...context, selectedBlocks: [context.currentDocument.blocks[1]!] },
    )

    expect(current).toMatchObject({
      ok: true,
      value: {
        markdown: '# P0 完成\n\nP1 **进行中**\n',
        blocks: [{ markdown: '# P0 完成' }, { markdown: 'P1 **进行中**' }],
      },
    })
    expect(current.value).not.toHaveProperty('text')
    expect(selected).toMatchObject({
      ok: true,
      value: [{ id: 'p1', markdown: 'P1 **进行中**' }],
    })
  })

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

  it('lists mind maps and reads a bounded subtree through the application reader', async () => {
    const listMindMaps = vi.fn(async () => [
      {
        id: 'map-1',
        title: '规划',
        rootNodeId: 'root',
        nodeCount: 3,
        version: 2,
        createdAt: 1,
        updatedAt: 2,
      },
    ])
    const readMindMap = vi.fn(async (_id, query) => ({
      mindMapId: 'map-1',
      title: '规划',
      version: 2,
      returnedNodes: 1,
      truncated: true,
      root: { id: 'root', text: '规划', children: [] },
      query,
    }))

    await expect(
      executeAgentTool(
        { name: 'list_mind_maps', arguments: {} },
        { ...context, listMindMaps, readMindMap },
      ),
    ).resolves.toMatchObject({ ok: true, value: [{ id: 'map-1', nodeCount: 3 }] })
    await expect(
      executeAgentTool(
        { name: 'read_mind_map', arguments: { mindMapId: 'map-1', depth: 1, maxNodes: 20 } },
        { ...context, listMindMaps, readMindMap },
      ),
    ).resolves.toMatchObject({ ok: true, value: { version: 2, truncated: true } })
    expect(readMindMap).toHaveBeenCalledWith(
      'map-1',
      expect.objectContaining({ depth: 1, maxNodes: 20 }),
    )
  })

  it('searches the configured workspace by default', async () => {
    const executeNativeTool = vi.fn(async () => [{ id: 'doc-workspace', title: 'Workspace' }])
    const onDocumentsDiscovered = vi.fn()

    await expect(
      executeAgentTool(
        { name: 'search_documents', arguments: { query: 'runtime' } },
        {
          ...context,
          workspaceRootIds: ['group-agent-mvp'],
          executeNativeTool,
          onDocumentsDiscovered,
        },
      ),
    ).resolves.toMatchObject({ ok: true })

    expect(executeNativeTool).toHaveBeenCalledWith(
      'search_documents',
      {
        query: 'runtime',
        limit: 5,
        scope: 'workspace',
        workspaceRootIds: ['group-agent-mvp'],
      },
      undefined,
      undefined,
    )
    expect(onDocumentsDiscovered).toHaveBeenCalledWith(['doc-workspace'], 'workspace')
  })

  it('allows an explicit global search to discover an outside document before reading it', async () => {
    const discovered = new Set(['doc-1'])
    const executeNativeTool = vi.fn(async (name: string) =>
      name === 'search_documents'
        ? [{ id: 'doc-outside', title: 'Outside' }]
        : { id: 'doc-outside', title: 'Outside', revision: 1, blocks: [] },
    )
    const scopedContext: AgentToolExecutionContext = {
      ...context,
      workspaceRootIds: ['group-agent-mvp'],
      executeNativeTool,
      onDocumentsDiscovered: (ids) => ids.forEach((id) => discovered.add(id)),
      canReadDocument: (id) => discovered.has(id),
    }

    await expect(
      executeAgentTool(
        { name: 'read_document', arguments: { documentId: 'doc-outside' } },
        scopedContext,
      ),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('scope="global"') })

    await executeAgentTool(
      { name: 'search_documents', arguments: { query: 'outside', scope: 'global' } },
      scopedContext,
    )
    await expect(
      executeAgentTool(
        { name: 'read_document', arguments: { documentId: 'doc-outside' } },
        scopedContext,
      ),
    ).resolves.toMatchObject({ ok: true, value: { id: 'doc-outside' } })
    expect(executeNativeTool).toHaveBeenCalledWith(
      'search_documents',
      expect.objectContaining({ scope: 'global', workspaceRootIds: ['group-agent-mvp'] }),
      undefined,
      undefined,
    )
  })

  it('exposes canonical structured blocks as editable Markdown', async () => {
    const onDocumentRead = vi.fn()
    const executeNativeTool = vi.fn(async () => ({
      id: 'doc-table',
      title: 'Tools',
      revision: 4,
      blocks: [
        {
          id: 'table-1',
          blockType: 'tableBlock',
          blockIndex: 0,
          plainText: '工具\t风险\nread_document\tread',
          contentJson: {
            type: 'tableBlock',
            attrs: {
              id: 'table-1',
              rows: [
                ['工具', '风险'],
                ['read_document', 'read'],
              ],
            },
          },
        },
      ],
    }))

    const result = await executeAgentTool(
      { name: 'read_document', arguments: { documentId: 'doc-table' } },
      { ...context, executeNativeTool, onDocumentRead },
    )

    expect(result).toMatchObject({
      ok: true,
      value: {
        blocks: [
          {
            markdown: '| 工具 | 风险 |\n| --- | --- |\n| read_document | read |',
          },
        ],
      },
    })
    expect(onDocumentRead).toHaveBeenCalledWith(
      'doc-table',
      expect.objectContaining({
        blocks: [expect.objectContaining({ markdown: expect.any(String) })],
      }),
    )
    expect(result.value.blocks[0]).not.toHaveProperty('contentJson')
  })

  it('forwards bounded document paging arguments to the native tool', async () => {
    const executeNativeTool = vi.fn(async () => ({
      id: 'doc-long',
      title: 'Long',
      revision: 2,
      blocks: [],
      truncated: true,
      nextCursor: 12,
    }))

    await executeAgentTool(
      {
        name: 'read_document',
        arguments: { documentId: 'doc-long', cursor: 4, maxChars: 8_192, blockIds: ['block-9'] },
      },
      { ...context, executeNativeTool },
    )

    expect(executeNativeTool).toHaveBeenCalledWith(
      'read_document',
      { documentId: 'doc-long', cursor: 4, maxChars: 8_192, blockIds: ['block-9'] },
      undefined,
      undefined,
    )
  })

  it('marks SQLite busy read failures as retryable', async () => {
    const executeNativeTool = vi.fn(async () => {
      throw new Error('SQLite database is locked')
    })

    await expect(
      executeAgentTool(
        { name: 'read_document', arguments: { documentId: 'doc-locked' } },
        { ...context, executeNativeTool },
      ),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'database_busy',
      retryable: true,
      retryAfterMs: 250,
    })
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

  it('creates a disabled MCP draft only after inline authorization', async () => {
    const createMcpServerDraft = vi.fn(async (input) => ({ ...input, created: true }))
    const requestAuthorizerInput = vi.fn(async () => '创建停用草稿')

    await expect(
      executeAgentTool(
        {
          name: 'create_mcp_server_draft',
          arguments: {
            name: '项目工具',
            transport: 'http',
            url: 'https://mcp.example.test/service',
          },
        },
        { ...context, requestAuthorizerInput, createMcpServerDraft },
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { created: true, name: '项目工具', transport: 'http' },
    })
    expect(requestAuthorizerInput).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.stringContaining('停用且未信任'),
        options: ['创建停用草稿', '取消'],
      }),
    )
    expect(createMcpServerDraft).toHaveBeenCalledWith({
      name: '项目工具',
      transport: 'http',
      url: 'https://mcp.example.test/service',
    })
  })
})
