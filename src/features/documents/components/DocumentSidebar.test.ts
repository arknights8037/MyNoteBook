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
    await wrapper.get('.document-group .document-card-menu__item').trigger('select')

    expect(wrapper.emitted('create-view')).toContainEqual(['group'])
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

  it('renders persisted mind-map views in the workspace and opens them by id', async () => {
    const wrapper = createWrapper([])
    await wrapper.setProps({
      mindMaps: [
        {
          id: 'map-1',
          parentId: null,
          sortOrder: 0,
          title: '产品规划',
          rootNodeId: 'root',
          nodeCount: 4,
          version: 2,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      activeMindMapId: 'map-1',
    })

    expect(wrapper.get('.document-list__item--mindmap').text()).toContain('产品规划')
    expect(wrapper.get('.document-list__item--mindmap').classes()).toContain(
      'document-list__item--active',
    )
    await wrapper.get('.document-list__item--mindmap .document-list__select').trigger('click')
    expect(wrapper.emitted('select-mind-map')).toEqual([['map-1']])
  })

  it('places mind maps in the same hierarchy as documents and groups', async () => {
    const wrapper = createWrapper([
      summary('group', null, 'group'),
      summary('child-document', 'map-1'),
    ])
    await wrapper.setProps({
      mindMaps: [{
        id: 'map-1', parentId: 'group', sortOrder: 0, title: '研究地图', rootNodeId: 'root',
        nodeCount: 3, version: 1, createdAt: 1, updatedAt: 2,
      }],
    })

    const rows = wrapper.findAll('.document-list__item--tree')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.text()).toContain('研究地图')
    expect(rows[0]?.attributes('style')).toContain('--document-tree-depth: 1')
    expect(rows[1]?.attributes('style')).toContain('--document-tree-depth: 2')
  })

  it('places tables in the same hierarchy and gives them the shared content menu', async () => {
    const wrapper = createWrapper([summary('group', null, 'group')])
    await wrapper.setProps({
      workspaceViews: [{
        id: 'table-1', parentId: 'group', sortOrder: 0, viewType: 'table', title: '项目表',
        pinnedAt: null, version: 1, createdAt: 1, updatedAt: 2,
      }],
      activeWorkspaceViewId: 'table-1',
    })

    const row = wrapper.get('.document-list__item--workspace-view')
    expect(row.text()).toContain('项目表')
    expect(row.text()).toContain('表格')
    await row.get('.document-list__select').trigger('click')
    await row.get('.document-card-menu__item').trigger('select')

    expect(wrapper.emitted('select-workspace-view')).toEqual([['table-1']])
    expect(wrapper.emitted('create-view')).toContainEqual(['table-1'])
  })

  it('routes structured view metadata and pin actions through the shared more menu', async () => {
    const wrapper = createWrapper([])
    await wrapper.setProps({
      workspaceViews: [{
        id: 'view-1', parentId: null, sortOrder: 0, viewType: 'uml', title: '系统图',
        pinnedAt: null, version: 1, createdAt: 1, updatedAt: 2,
      }],
    })

    const items = wrapper.get('.document-list__item--workspace-view').findAll('.document-card-menu__item')
    await items.find((item) => item.text() === '置顶')!.trigger('select')
    await items.find((item) => item.text() === '属性')!.trigger('select')
    await items.find((item) => item.text() === '重命名')!.trigger('select')

    expect(wrapper.emitted('pin-workspace-view')).toEqual([['view-1']])
    expect(wrapper.emitted('properties-workspace-view')).toEqual([['view-1']])
    expect(wrapper.emitted('rename-workspace-view')).toEqual([['view-1']])
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
      mindMaps: [],
      activeMindMapId: null,
      workspaceViews: [],
      activeWorkspaceViewId: null,
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
