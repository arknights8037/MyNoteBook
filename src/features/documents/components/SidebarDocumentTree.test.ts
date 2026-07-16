import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import SidebarDocumentTree from './SidebarDocumentTree.vue'
import type { SidebarDocumentNode } from '../documentTree'
import type { DocumentSummary } from '@/models/document'

describe('SidebarDocumentTree', () => {
  it('renders nested pages and emits navigation, expansion, and creation actions', async () => {
    const nodes: SidebarDocumentNode[] = [
      {
        document: createSummary('parent', null),
        children: [
          {
            document: createSummary('child', 'parent'),
            children: [],
          },
        ],
      },
    ]
    const wrapper = mount(SidebarDocumentTree, {
      props: {
        nodes,
        currentDocumentId: 'parent',
        collapsedDocumentIds: new Set(),
        draggedArticleId: null,
        busy: false,
      },
      global: {
        stubs: {
          NTooltip: { template: '<div><slot name="trigger" /><slot /></div>' },
          ContextMenuRoot: { template: '<div><slot /></div>' },
          ContextMenuTrigger: { template: '<div><slot /></div>' },
          ContextMenuPortal: { template: '<div><slot /></div>' },
          ContextMenuContent: { template: '<div><slot /></div>' },
          ContextMenuItem: { template: '<button><slot /></button>' },
          ContextMenuSeparator: { template: '<span />' },
          DropdownMenuRoot: { template: '<div><slot /></div>' },
          DropdownMenuTrigger: { template: '<div><slot /></div>' },
          DropdownMenuPortal: { template: '<div><slot /></div>' },
          DropdownMenuContent: { template: '<div><slot /></div>' },
          DropdownMenuItem: { template: '<button><slot /></button>' },
          DropdownMenuSeparator: { template: '<span />' },
        },
      },
    })

    const rows = wrapper.findAll('.document-list__item--tree')
    expect(rows).toHaveLength(2)
    expect(rows[1]?.attributes('style')).toContain('--document-tree-depth: 1')

    await rows[0]?.get('.document-list__select').trigger('click')
    await rows[0]?.get('.document-list__toggle').trigger('click')
    await wrapper.get('button[aria-label="parent中新建内容"]').trigger('click')

    expect(wrapper.emitted('select')).toContainEqual(['parent'])
    expect(wrapper.emitted('toggle')).toContainEqual(['parent'])
    expect(wrapper.emitted('createChildView')).toContainEqual(['parent'])
  })
})

function createSummary(id: string, parentId: string | null): DocumentSummary {
  return {
    id,
    parentId,
    documentKind: 'article',
    title: id,
    plainText: '',
    revision: 1,
    sortOrder: 0,
    isDeleted: false,
    createdAt: 1,
    updatedAt: 1,
  }
}
