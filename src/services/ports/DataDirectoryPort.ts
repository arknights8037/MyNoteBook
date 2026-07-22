export interface DataDirectoryChange {
  databasePath: string
  backupPath: string | null
  migratedFileCount: number
  rewrittenMetadataCount: number
}

export interface DataDirectoryPort {
  getDefaultDirectory(): Promise<string>
  chooseDirectory(defaultPath?: string): Promise<string | null>
  closeDatabase(): Promise<void>
  migrate(
    currentDirectory: string | null,
    destinationDirectory: string | null,
  ): Promise<DataDirectoryChange>
}
