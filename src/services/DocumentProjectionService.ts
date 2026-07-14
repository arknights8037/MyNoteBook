import { invoke } from '@tauri-apps/api/core'

import { loadAppSettings } from '@/models/settings'

export interface ProjectionRebuildResult {
  scanned: number
  repaired: number
  errors: string[]
}

export function rebuildDocumentProjections(
  documentId?: string,
): Promise<ProjectionRebuildResult> {
  return invoke('rebuild_document_projections', {
    input: {
      dataDirectory: loadAppSettings().dataDirectory,
      documentId: documentId ?? null,
    },
  })
}
