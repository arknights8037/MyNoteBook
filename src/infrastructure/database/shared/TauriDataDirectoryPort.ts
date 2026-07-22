import { open } from '@tauri-apps/plugin-dialog'

import { closeDatabase } from '@/infrastructure/database/shared/connection'
import {
  getDefaultDataDirectory,
  migrateDataDirectory,
} from '@/infrastructure/database/shared/dataDirectory'
import type { DataDirectoryPort } from '@/services/ports/DataDirectoryPort'

export const tauriDataDirectoryPort: DataDirectoryPort = {
  getDefaultDirectory: getDefaultDataDirectory,
  async chooseDirectory(defaultPath) {
    const selected = await open({
      title: '选择知识库数据目录',
      directory: true,
      multiple: false,
      defaultPath,
    })
    return typeof selected === 'string' && selected.trim() ? selected : null
  },
  closeDatabase,
  migrate: migrateDataDirectory,
}
