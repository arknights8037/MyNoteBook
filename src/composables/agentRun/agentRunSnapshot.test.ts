import { describe, expect, it } from 'vitest'

import { createAiSettings } from '@/models/ai'
import { captureAgentRunSnapshot, createAgentEditPlan } from './agentRunSnapshot'

describe('agentRunSnapshot', () => {
  it('deeply freezes mutable run inputs', () => {
    const settings = createAiSettings('openai')
    settings.model = 'start-model'
    const document = {
      id: 'doc-1',
      title: '开始标题',
      tags: ['开始标签'],
      sourceUrl: '',
      author: '',
      text: '发布流程正文',
      revision: 1,
      blocks: [{ id: 'b1', type: 'paragraph', text: '发布流程正文', index: 0 }],
      selectedBlocks: [],
      hasBlockSelection: false,
      documents: [],
    }
    const snapshot = captureAgentRunSnapshot({
      prompt: ' 修改发布流程 ',
      requestedMode: 'agent',
      settings,
      document,
    })

    settings.model = 'changed-model'
    document.tags[0] = 'changed-tag'
    document.blocks[0]!.text = 'changed-body'

    expect(snapshot.prompt).toBe('修改发布流程')
    expect(snapshot.settings.model).toBe('start-model')
    expect(snapshot.document.tags).toEqual(['开始标签'])
    expect(snapshot.document.blocks[0]?.text).toBe('发布流程正文')
  })

  it('infers a conservative target scope when no blocks are selected', () => {
    const settings = createAiSettings('openai')
    settings.model = 'test-model'
    const snapshot = captureAgentRunSnapshot({
      prompt: '发布流程',
      requestedMode: 'agent',
      settings,
      document: {
        id: 'doc-1', title: '', tags: [], sourceUrl: '', author: '', text: '', revision: 3,
        blocks: [
          { id: 'release', type: 'paragraph', text: '发布流程与灰度验证', index: 0 },
          { id: 'meeting', type: 'paragraph', text: '会议纪要', index: 1 },
        ],
        selectedBlocks: [], hasBlockSelection: false, documents: [],
      },
    })

    const plan = createAgentEditPlan({ snapshot, mode: 'agent', createId: () => 'task-1' })

    expect(plan?.targetBlocks.map((block) => block.id)).toEqual(['release'])
    expect(plan?.foundTargetScope).toBe(true)
    expect(plan?.task.contextScope).toBe('current_document')
  })
})
