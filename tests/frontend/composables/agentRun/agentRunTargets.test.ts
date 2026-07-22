import { describe, expect, it, vi } from 'vitest'

import type { AgentRunDocumentAdapter, AgentRunSnapshot } from '@/composables/agentRun/types'
import {
  hydrateCanonicalDocumentSnapshot,
  hydrateExplicitDocumentTargets,
} from '@/composables/agentRun/agentRunTargets'

describe('agentRunTargets', () => {
  it('hydrates explicit documents with stable block provenance', async () => {
    const snapshot = createSnapshot()
    snapshot.explicitTargets = [
      { kind: 'document', id: 'other', title: '其他文档', content: '', revision: undefined },
    ]
    const document = createDocumentAdapter()

    const result = await hydrateExplicitDocumentTargets(snapshot, document)

    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.targets[0]?.content).toContain('block id=block-2 revision=7')
  })

  it('fills an empty snapshot from canonical document blocks', async () => {
    const snapshot = createSnapshot().document
    snapshot.blocks = []
    snapshot.text = ''
    snapshot.markdown = ''
    snapshot.revision = null

    const hydrated = await hydrateCanonicalDocumentSnapshot(snapshot, createDocumentAdapter())

    expect(hydrated.blocks).toHaveLength(1)
    expect(hydrated.text).toBe('正文')
    expect(hydrated.revision).toBe(7)
  })
})

function createSnapshot(): AgentRunSnapshot {
  return {
    prompt: '测试',
    requestedMode: 'agent',
    settings: {} as AgentRunSnapshot['settings'],
    document: {
      id: 'current',
      title: '当前文档',
      tags: [],
      sourceUrl: '',
      author: '',
      text: '当前正文',
      markdown: '当前正文',
      revision: 3,
      blocks: [{ id: 'block-1', type: 'paragraph', text: '当前正文', index: 0 }],
      selectedBlocks: [],
      hasBlockSelection: false,
      documents: [],
    },
    explicitTargets: [],
  }
}

function createDocumentAdapter(): AgentRunDocumentAdapter {
  return {
    captureSnapshot: vi.fn(),
    flushBeforeEdit: vi.fn(),
    searchDocuments: vi.fn(),
    readDocument: vi.fn(async () => ({ id: 'other', revision: 7 })),
    listDocumentBlocks: vi.fn(async () => [
      {
        id: 'block-2',
        type: 'paragraph',
        plainText: '正文',
        contentJson: JSON.stringify({ type: 'paragraph', content: [{ type: 'text', text: '正文' }] }),
        index: 0,
        documentRevision: 7,
      },
    ]),
    openDocumentForReview: vi.fn(),
  } as unknown as AgentRunDocumentAdapter
}
