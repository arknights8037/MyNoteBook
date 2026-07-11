import { describe, expect, it } from 'vitest'

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
    await expect(
      executeAgentTool(
        { name: 'find_blocks_by_regex', arguments: { pattern: 'P0' } },
        context,
      ),
    ).resolves.toMatchObject({ ok: true, value: [{ id: 'p0' }] })
  })

  it('does not execute write tools inside the loop', async () => {
    await expect(
      executeAgentTool({ name: 'replace_text_by_regex', arguments: {} }, context),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('不能在 loop 中直接执行') })
  })
})
