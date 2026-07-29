import { invoke } from '@tauri-apps/api/core'

import type { AuthorizationStorePort } from '@/services/ports/AuthorizationStorePort'
import { loadAppSettings } from '@/models/settings/settings'

export class TauriAuthorizationStore implements AuthorizationStorePort {
  async record(input: Parameters<AuthorizationStorePort['record']>[0]): Promise<void> {
    await invoke('record_authorization', {
      input: {
        dataDirectory: loadAppSettings().dataDirectory,
        id: input.id,
        approvalKind: input.approvalKind,
        entityType: input.entityType,
        entityId: input.entityId,
        requestJson: JSON.stringify(input.request),
        runId: input.runId,
        correlationId: input.correlationId,
        causationId: input.causationId,
        createdAt: input.createdAt,
      },
    })
  }

  async resolve(input: Parameters<AuthorizationStorePort['resolve']>[0]): Promise<void> {
    await invoke('resolve_authorization', {
      input: {
        dataDirectory: loadAppSettings().dataDirectory,
        id: input.id,
        status: input.status,
        detailsJson: JSON.stringify(input.details),
        decidedAt: input.decidedAt,
      },
    })
  }
}
