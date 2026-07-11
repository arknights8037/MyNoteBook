import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'

import type { DocumentTransferFilePort } from '@/services/DocumentTransferService'

export const tauriDocumentTransferFilePort: DocumentTransferFilePort = {
  async chooseSavePath(options) {
    return save({
      title: options.title,
      defaultPath: options.defaultPath,
      filters: [
        {
          name: options.extension === 'md' ? 'Markdown' : 'HTML',
          extensions: [options.extension],
        },
      ],
    })
  },

  async writeTextFile(path, content) {
    await invoke('write_text_file', { path, content })
  },
}
