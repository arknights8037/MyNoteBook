import { ref, shallowRef } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import { useDataDirectorySettings } from '@/composables/useDataDirectorySettings'
import { createDefaultAppSettings } from '@/models/settings/settings'
import type { DocumentService } from '@/services/documents/DocumentService'
import type { DataDirectoryPort } from '@/services/ports/DataDirectoryPort'

describe('useDataDirectorySettings', () => {
  it('uses the injected native port for default path discovery', async () => {
    const port = {
      getDefaultDirectory: vi.fn(async () => 'C:\\notebook-data'),
    } as unknown as DataDirectoryPort
    const workflow = useDataDirectorySettings({
      settings: ref(createDefaultAppSettings()),
      documentService: shallowRef<DocumentService | null>(null),
      autosave: { flushBeforeDocumentChange: vi.fn(async () => ({ ok: true })) },
      requestAuthorization: vi.fn(async () => false),
      initializeDocuments: vi.fn(async () => undefined),
      message: { success: vi.fn(), error: vi.fn() },
      dataDirectoryPort: port,
    })

    await workflow.initializeDefaultDataDirectory()

    expect(port.getDefaultDirectory).toHaveBeenCalledOnce()
    expect(workflow.defaultDataDirectory.value).toBe('C:\\notebook-data')
  })
})
