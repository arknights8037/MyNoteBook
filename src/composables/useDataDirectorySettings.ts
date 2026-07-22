import { ref, type Ref, type ShallowRef } from 'vue'

import { saveAppSettings, type AppSettings } from '@/models/settings/settings'
import type { DocumentService } from '@/services/documents/DocumentService'
import type { DataDirectoryPort } from '@/services/ports/DataDirectoryPort'

interface DataDirectoryAutosave {
  flushBeforeDocumentChange: () => Promise<{ ok: boolean }>
}

interface DataDirectoryMessage {
  success: (message: string) => void
  error: (message: string) => void
}

interface UseDataDirectorySettingsOptions {
  settings: Ref<AppSettings>
  documentService: ShallowRef<DocumentService | null>
  autosave: DataDirectoryAutosave
  requestAuthorization: (title: string, description: string) => Promise<boolean>
  initializeDocuments: () => Promise<void>
  message: DataDirectoryMessage
  dataDirectoryPort: DataDirectoryPort
}

export function useDataDirectorySettings(options: UseDataDirectorySettingsOptions) {
  const defaultDataDirectory = ref('')
  const isChangingDataDirectory = ref(false)

  async function initializeDefaultDataDirectory(): Promise<void> {
    try {
      defaultDataDirectory.value = await options.dataDirectoryPort.getDefaultDirectory()
    } catch {
      // Browser development builds do not expose native Tauri paths.
    }
  }

  async function chooseDataDirectory(): Promise<void> {
    const authorized = await options.requestAuthorization(
      '更改数据位置',
      '此操作会迁移本机知识库数据库、附件、技能、MCP 配置及受管交付文件；目标目录原有数据会先整体备份。',
    )
    if (!authorized) return

    const selected = await options.dataDirectoryPort.chooseDirectory(
      (options.settings.value.dataDirectory ?? defaultDataDirectory.value) || undefined,
    )
    if (!selected) return
    if (selected === options.settings.value.dataDirectory) return
    await changeDataDirectory(selected)
  }

  async function restoreDefaultDataDirectory(): Promise<void> {
    if (!options.settings.value.dataDirectory) return
    const authorized = await options.requestAuthorization(
      '恢复默认数据位置',
      '此操作会把当前知识库数据库及全部受管文件迁回应用默认数据目录。',
    )
    if (!authorized) return

    await changeDataDirectory(null)
  }

  async function changeDataDirectory(destinationDirectory: string | null): Promise<void> {
    if (isChangingDataDirectory.value) return
    isChangingDataDirectory.value = true
    const previousSettings = options.settings.value

    try {
      const flushResult = await options.autosave.flushBeforeDocumentChange()
      if (!flushResult.ok) {
        options.message.error('当前文档保存失败，未切换数据目录')
        return
      }

      await options.dataDirectoryPort.closeDatabase()
      const change = await options.dataDirectoryPort.migrate(
        previousSettings.dataDirectory,
        destinationDirectory,
      )
      options.settings.value = { ...previousSettings, dataDirectory: destinationDirectory }
      saveAppSettings(options.settings.value)
      options.documentService.value = null
      await options.initializeDocuments()
      const migrationSummary = `已迁移 ${change.migratedFileCount} 个文件${
        change.rewrittenMetadataCount > 0
          ? `，并重写 ${change.rewrittenMetadataCount} 条路径元数据`
          : ''
      }`
      options.message.success(
        change.backupPath
          ? `数据位置已切换；${migrationSummary}；目标目录原有数据已整体备份`
          : `数据位置已切换；${migrationSummary}`,
      )
    } catch (error) {
      options.settings.value = previousSettings
      saveAppSettings(previousSettings)
      options.documentService.value = null
      try {
        await options.initializeDocuments()
      } catch {
        // initializeDocuments exposes its own load error state.
      }
      options.message.error(error instanceof Error ? error.message : String(error))
    } finally {
      isChangingDataDirectory.value = false
    }
  }

  return {
    defaultDataDirectory,
    isChangingDataDirectory,
    initializeDefaultDataDirectory,
    chooseDataDirectory,
    restoreDefaultDataDirectory,
  }
}
