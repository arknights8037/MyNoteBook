import { describe, expect, it } from 'vitest'

import { compileContextBundle } from './contextBundle'
import { createDefaultExecutionPolicy } from './executionPolicy'

describe('Context Bundle v2', () => {
  it('produces a stable snapshot hash from versioned sources and execution policy', async () => {
    const input = {
      id: 'bundle-1',
      taskId: 'task-1',
      correlationId: 'corr-1',
      query: '检查规则',
      documentId: 'doc-1',
      contextScope: 'current_document',
      currentRevision: 4,
      provider: 'openai' as const,
      model: 'gpt-test',
      executionPolicy: createDefaultExecutionPolicy({
        tokenBudget: 4096,
        allowedTools: ['read_document'],
      }),
      sources: [
        {
          documentId: 'doc-1',
          blockId: 'block-1',
          documentTitle: '规则',
          revision: 4,
          contentSnippet: '必须经过审批。',
        },
      ],
      createdAt: 100,
    }
    const first = await compileContextBundle(input)
    const second = await compileContextBundle({ ...input, id: 'bundle-2', createdAt: 200 })

    expect(first.snapshotHash).toHaveLength(64)
    expect(second.snapshotHash).toBe(first.snapshotHash)
    expect(first.sources[0]).toMatchObject({
      documentId: 'doc-1',
      blockId: 'block-1',
      revision: 4,
      contentSnapshot: '必须经过审批。',
    })
    expect(first.version).toBe(2)
  })
})
