import { invoke } from '@tauri-apps/api/core'

import { loadAppSettings } from '@/models/settings/settings'

export interface PublishSignalRefreshOptions {
  since?: number
  triggerSource?: 'manual' | 'sync' | 'connector'
  importedCount?: number
}

export interface PublishedSignalRefresh {
  eventId: string
  status: 'accepted'
}

export function publishSignalRefresh(
  options: PublishSignalRefreshOptions = {},
): Promise<PublishedSignalRefresh> {
  return invoke<PublishedSignalRefresh>('publish_signal_refresh_event', {
    input: {
      dataDirectory: loadAppSettings().dataDirectory,
      since: options.since,
      triggerSource: options.triggerSource ?? 'manual',
      importedCount: options.importedCount ?? 0,
    },
  })
}
