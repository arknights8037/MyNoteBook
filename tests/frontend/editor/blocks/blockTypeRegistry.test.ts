import { describe, expect, it } from 'vitest'

import {
  BLOCK_TYPE_REGISTRY,
  CONTEXT_INSERT_BLOCK_TYPES,
  getContextInsertContent,
} from '@/editor/blocks/blockTypeRegistry'

describe('blockTypeRegistry', () => {
  it('registers ordinary and collapsible headings at levels one through four', () => {
    expect(
      BLOCK_TYPE_REGISTRY.filter((blockType) => /^heading-\d$/.test(blockType.id)).map(
        (blockType) => blockType.id,
      ),
    ).toEqual(['heading-1', 'heading-2', 'heading-3', 'heading-4'])

    expect(
      CONTEXT_INSERT_BLOCK_TYPES.filter((blockType) =>
        blockType.id.startsWith('collapsible-heading-'),
      ).map((blockType) => blockType.id),
    ).toEqual([
      'collapsible-heading-1',
      'collapsible-heading-2',
      'collapsible-heading-3',
      'collapsible-heading-4',
    ])
  })

  it('stores the selected level on inserted collapsible headings', () => {
    const levels = CONTEXT_INSERT_BLOCK_TYPES.filter((blockType) =>
      blockType.id.startsWith('collapsible-heading-'),
    ).map((blockType) => {
      const content = getContextInsertContent(blockType)
      return Array.isArray(content) ? undefined : content?.attrs?.headingLevel
    })

    expect(levels).toEqual([1, 2, 3, 4])
  })
})
