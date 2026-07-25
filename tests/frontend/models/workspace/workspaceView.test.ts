import { describe, expect, it } from 'vitest'
import { applyWorkspaceViewOperation, createDefaultWorkspaceViewPayload, normalizeWorkspaceViewPayload, parseMermaidFlowNodes, renameMermaidNode } from '@/models/workspace/workspaceView'
import { parseSlidevDeck } from '@/models/workspace/slidevDeck'

describe('workspace view model', () => {
  it('creates constrained defaults for every structured view type', () => {
    const id = (prefix: string) => `${prefix}-1`
    expect(createDefaultWorkspaceViewPayload('slides', id)).toMatchObject({ type: 'slides', format: 'slidev' })
    expect(createDefaultWorkspaceViewPayload('uml', id)).toMatchObject({ type: 'uml', diagramType: 'flow' })
    expect(createDefaultWorkspaceViewPayload('table', id)).toMatchObject({ type: 'table', rows: [['字段', '说明'], ['', '']] })
  })
  it('parses semantic Mermaid nodes and patches only the requested label', () => {
    const source = 'flowchart LR\n  start[开始] --> check{通过吗}\n  check --> done((完成))'
    expect(parseMermaidFlowNodes(source)).toEqual([
      { id: 'start', label: '开始' }, { id: 'check', label: '通过吗' }, { id: 'done', label: '完成' },
    ])
    expect(renameMermaidNode(source, 'check', '是否通过')).toContain('check{是否通过}')
  })
  it('exposes the same semantic operations to humans and future agents', () => {
    const payload = { type: 'slides' as const, format: 'slidev' as const, source: '# 旧标题', assetIds: [] }
    expect(applyWorkspaceViewOperation(payload, { type: 'set_slidev_source', source: '# 新标题' })).toMatchObject({ source: '# 新标题' })
  })
  it('upgrades legacy template slides to canonical Slidev markdown', () => {
    const payload = normalizeWorkspaceViewPayload('slides', {
      type: 'slides',
      pages: [{ id: 'p1', templateId: 'cover', slots: { title: '旧标题', subtitle: '旧副标题' }, background: 'gradient' }],
    }, (prefix) => `${prefix}-1`)
    expect(payload).toMatchObject({ type: 'slides', format: 'slidev' })
    if (payload.type !== 'slides') throw new Error('expected slides')
    expect(parseSlidevDeck(payload.source)).toMatchObject([{ id: 'p1', title: '旧标题', body: '旧副标题' }])
  })
})
