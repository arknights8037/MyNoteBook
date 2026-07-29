import { describe, expect, it } from 'vitest'

import { collectWorkspaceTreeIds } from '@/models/workspace/workspaceTree'

describe('workspaceTree', () => {
  it('collects mixed descendants and ignores cycles outside the selected root', () => {
    const result = collectWorkspaceTreeIds(
      [
        { id: 'page', parentId: 'group' },
        { id: 'nested-page', parentId: 'page' },
        { id: 'map', parentId: 'nested-page' },
        { id: 'cycle-a', parentId: 'cycle-b' },
        { id: 'cycle-b', parentId: 'cycle-a' },
      ],
      'group',
    )

    expect([...result]).toEqual(['group', 'page', 'nested-page', 'map'])
  })
})
