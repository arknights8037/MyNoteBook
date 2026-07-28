import { describe, expect, it } from 'vitest'
import {
  applyWorkspaceViewOperation,
  createDefaultWorkspaceViewPayload,
  normalizeWorkspaceViewPayload,
  parseMermaidFlowNodes,
  renameMermaidNode,
  validateWorkspaceViewPayload,
} from '@/models/workspace/workspaceView'
import { parseSlidevDeck } from '@/models/workspace/slidevDeck'

describe('workspace view model', () => {
  it('creates constrained defaults for every structured view type', () => {
    const id = (prefix: string) => `${prefix}-1`
    expect(createDefaultWorkspaceViewPayload('slides', id)).toMatchObject({
      type: 'slides',
      format: 'slidev',
    })
    expect(createDefaultWorkspaceViewPayload('uml', id)).toMatchObject({
      type: 'uml',
      diagramType: 'flow',
    })
    expect(createDefaultWorkspaceViewPayload('table', id)).toMatchObject({
      type: 'table',
      rows: [
        ['字段', '说明'],
        ['', ''],
      ],
    })
    expect(createDefaultWorkspaceViewPayload('dashboard', id)).toMatchObject({
      type: 'dashboard',
      layoutVersion: 1,
      widgets: [
        expect.objectContaining({ widgetType: 'automation-results' }),
        expect.objectContaining({ widgetType: 'agent-work-status' }),
      ],
    })
  })
  it('parses semantic Mermaid nodes and patches only the requested label', () => {
    const source = 'flowchart LR\n  start[开始] --> check{通过吗}\n  check --> done((完成))'
    expect(parseMermaidFlowNodes(source)).toEqual([
      { id: 'start', label: '开始' },
      { id: 'check', label: '通过吗' },
      { id: 'done', label: '完成' },
    ])
    expect(renameMermaidNode(source, 'check', '是否通过')).toContain('check{是否通过}')
  })
  it('exposes the same semantic operations to humans and future agents', () => {
    const payload = {
      type: 'slides' as const,
      format: 'slidev' as const,
      source: '# 旧标题',
      assetIds: [],
    }
    expect(
      applyWorkspaceViewOperation(payload, { type: 'set_slidev_source', source: '# 新标题' }),
    ).toMatchObject({ source: '# 新标题' })
  })
  it('normalizes dashboard widgets through a fixed registry-shaped payload', () => {
    const payload = normalizeWorkspaceViewPayload(
      'dashboard',
      {
        type: 'dashboard',
        scope: { kind: 'project', projectId: 'project-1' },
        widgets: [
          {
            id: 'automation-1',
            widgetType: 'automation-results',
            widgetVersion: 99,
            query: { limit: 500, arbitraryUrl: 'https://example.com' },
            settings: { title: '最近运行', script: 'alert(1)' },
            layout: { desktop: { x: 11, y: 0, w: 8, h: 4 } },
          },
          { id: 'unknown', widgetType: 'arbitrary-html' },
        ],
      },
      (prefix) => `${prefix}-1`,
    )

    expect(payload).toEqual({
      type: 'dashboard',
      scope: { kind: 'project', projectId: 'project-1' },
      layoutVersion: 1,
      widgets: [
        {
          id: 'automation-1',
          widgetType: 'automation-results',
          widgetVersion: 1,
          query: { limit: 50 },
          settings: { title: '最近运行' },
          layout: { desktop: { x: 4, y: 0, w: 8, h: 4, minW: 4, minH: 3 } },
        },
      ],
    })
    expect(validateWorkspaceViewPayload(payload)).toBeNull()
  })
  it('upgrades legacy template slides to canonical Slidev markdown', () => {
    const payload = normalizeWorkspaceViewPayload(
      'slides',
      {
        type: 'slides',
        pages: [
          {
            id: 'p1',
            templateId: 'cover',
            slots: { title: '旧标题', subtitle: '旧副标题' },
            background: 'gradient',
          },
        ],
      },
      (prefix) => `${prefix}-1`,
    )
    expect(payload).toMatchObject({ type: 'slides', format: 'slidev' })
    if (payload.type !== 'slides') throw new Error('expected slides')
    expect(parseSlidevDeck(payload.source)).toMatchObject([
      { id: 'p1', title: '旧标题', body: '旧副标题' },
    ])
  })
})
