import { save } from '@tauri-apps/plugin-dialog'
import { writeTextFile } from '@tauri-apps/plugin-fs'

import type { DocumentTransferFilePort } from '@/services/documents/DocumentTransferService'

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
    await writeTextFile(path, content)
  },
}
