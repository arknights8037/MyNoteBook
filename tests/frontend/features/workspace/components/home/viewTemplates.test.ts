import { describe, expect, it } from 'vitest'

import { CREATE_VIEW_OPTIONS, CREATE_VIEW_TEMPLATES } from '@/features/workspace/components/home/viewTemplates'

describe('workspace view types', () => {
  it('offers mind maps as a first-class workspace view instead of a document template', () => {
    expect(CREATE_VIEW_OPTIONS).toContainEqual(
      expect.objectContaining({ id: 'mindmap', title: '思维导图' }),
    )
    expect(CREATE_VIEW_TEMPLATES).not.toHaveProperty('mindmap')
    expect(CREATE_VIEW_TEMPLATES).not.toHaveProperty('slides')
    expect(CREATE_VIEW_OPTIONS.map((item) => item.id)).toEqual([
      'document', 'uml', 'mindmap', 'slides', 'table',
    ])
  })
})
