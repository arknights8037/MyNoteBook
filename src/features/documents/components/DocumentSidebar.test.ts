import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import DocumentSidebar from './DocumentSidebar.vue'
import type { DocumentId, DocumentSummary } from '@/models/document'

const menuStubs = {
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
}

describe('DocumentSidebar', () => {
  it('projects grouped documents and emits semantic document actions', async () => {
    const wrapper = createWrapper([
      summary('group', null, 'group'),
      summary('parent', 'group'),
      summary('child', 'parent'),
    ])

    expect(wrapper.text()).toContain('2 个页面')
    await wrapper.get('button[aria-label="group中新建页面"]').trigger('click')

    expect(wrapper.emitted('create-document')).toContainEqual(['group'])
  })

  it('owns the file input and exposes a narrow picker command', () => {
    const click = vi.spyOn(globalThis.HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    const wrapper = createWrapper([])

    ;(wrapper.vm as unknown as { openFilePicker: () => void }).openFilePicker()

    expect(click).toHaveBeenCalledOnce()
    click.mockRestore()
  })

  it('requests a view change without mutating parent state', async () => {
    const wrapper = createWrapper([], 'trash')
    await wrapper.get('.market-link').trigger('click')
    expect(wrapper.emitted('update:view')).toEqual([['documents']])
  })

  it('renders the primary workspace navigation and emits its actions', async () => {
    const wrapper = createWrapper([])

    expect(wrapper.get('.sidebar-primary-nav__item--active').text()).toContain('Agent Work')
    await wrapper.get('.sidebar-primary-nav button:nth-child(2)').trigger('click')
    await wrapper.get('.sidebar-primary-nav button:nth-child(3)').trigger('click')
    await wrapper.get('.sidebar-primary-nav button:nth-child(4)').trigger('click')

    expect(wrapper.emitted('knowledge')).toHaveLength(1)
    expect(wrapper.emitted('new-view')).toHaveLength(1)
    expect(wrapper.emitted('plugins')).toHaveLength(1)
  })
})

function createWrapper(documents: DocumentSummary[], view: 'documents' | 'trash' = 'documents') {
  return mount(DocumentSidebar, {
    props: {
      documents,
      deletedDocuments: [],
      view,
      activeSurface: 'agent',
      currentDocumentId: 'current',
      selectedGroupId: null,
      collapsedGroupIds: new Set<DocumentId>(),
      collapsedDocumentIds: new Set<DocumentId>(),
      draggedArticleId: null,
      dropTargetGroupId: null,
      importFileAccept: '.md',
      busy: false,
    },
    global: { stubs: menuStubs },
  })
}

function summary(
  id: string,
  parentId: string | null,
  documentKind: 'article' | 'group' = 'article',
): DocumentSummary {
  return {
    id,
    parentId,
    documentKind,
    title: id,
    plainText: '',
    revision: 1,
    sortOrder: 0,
    isDeleted: false,
    createdAt: 1,
    updatedAt: 1,
  }
}
