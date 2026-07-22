import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import KnowledgeAssetsPanel from '@/features/knowledge-control/components/KnowledgeAssetsPanel.vue'
import type { KnowledgeAsset } from '@/models/knowledge/knowledgeAsset'

describe('KnowledgeAssetsPanel', () => {
  it('actively starts Research for a selected asset', async () => {
    const asset: KnowledgeAsset = {
      id: 'asset-1',
      title: '季度复盘.pdf',
      sourceType: 'office_file',
      format: 'PDF',
      documentId: null,
      assetId: 'stored-1',
      originalName: '季度复盘.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      characterCount: 120,
      provider: '',
      model: '',
      conversationId: '',
      messageCount: 0,
      importBatchId: '',
      importBatchName: '',
      archivePath: '',
      importedFromArchive: false,
      processingStatus: 'ready',
      content: '复盘正文',
      createdAt: 1,
      updatedAt: 1,
    }
    const wrapper = mount(KnowledgeAssetsPanel, {
      props: { assets: [asset], conversations: [], loading: false, importNotice: '' },
    })

    const research = wrapper.findAll('button').find((button) => button.text().includes('Research'))
    expect(research).toBeDefined()
    await research!.trigger('click')

    expect(wrapper.emitted('research')?.at(-1)).toEqual([[asset]])
  })

  it('starts one Research run for all checked assets', async () => {
    const base = {
      sourceType: 'text_file' as const,
      format: 'MD',
      documentId: null,
      assetId: null,
      originalName: '',
      mimeType: 'text/markdown',
      sizeBytes: 10,
      characterCount: 10,
      provider: '',
      model: '',
      conversationId: '',
      messageCount: 0,
      importBatchId: '',
      importBatchName: '',
      archivePath: '',
      importedFromArchive: false,
      processingStatus: 'ready',
      content: '正文',
      createdAt: 1,
      updatedAt: 1,
    }
    const assets: KnowledgeAsset[] = [
      { ...base, id: 'asset-1', title: '文件一' },
      { ...base, id: 'asset-2', title: '文件二' },
    ]
    const wrapper = mount(KnowledgeAssetsPanel, {
      props: { assets, conversations: [], loading: false, importNotice: '' },
    })

    for (const checkbox of wrapper.findAll('.knowledge-assets-list__checkbox')) {
      await checkbox.setValue(true)
    }
    const batchButton = wrapper
      .findAll('button')
      .find((button) => button.text().includes('Research 2 个文件'))
    await batchButton!.trigger('click')

    expect(wrapper.emitted('research')?.at(-1)).toEqual([assets])
  })
})
