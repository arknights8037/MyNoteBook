import { describe, expect, it } from 'vitest'
import { applyWorkspaceViewOperation, createDefaultWorkspaceViewPayload, parseMermaidFlowNodes, renameMermaidNode } from './workspaceView'

describe('workspace view model', () => {
  it('creates constrained defaults for every structured view type', () => {
    const id = (prefix: string) => `${prefix}-1`
    expect(createDefaultWorkspaceViewPayload('slides', id)).toMatchObject({ type: 'slides', pages: [{ templateId: 'cover' }] })
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
    const payload = { type: 'slides' as const, pages: [{ id: 'p1', templateId: 'cover' as const, slots: { title: '旧标题' }, background: 'plain' as const }] }
    expect(applyWorkspaceViewOperation(payload, { type: 'set_slide_slot', pageId: 'p1', slot: 'title', value: '新标题' })).toMatchObject({ pages: [{ slots: { title: '新标题' } }] })
  })
})
