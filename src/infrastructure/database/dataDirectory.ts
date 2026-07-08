import { invoke } from '@tauri-apps/api/core'

export interface DataDirectoryChange {
  databasePath: string
  backupPath: string | null
}

export async function getDefaultDataDirectory(): Promise<string> {
  return invoke<string>('get_default_data_directory')
}

export async function migrateDataDirectory(
  currentDirectory: string | null,
  destinationDirectory: string | null,
): Promise<DataDirectoryChange> {
  return invoke<DataDirectoryChange>('migrate_data_directory', {
    currentDirectory,
    destinationDirectory,
  })
}
