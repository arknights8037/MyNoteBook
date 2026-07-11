import Database from '@tauri-apps/plugin-sql'
import { invoke } from '@tauri-apps/api/core'

import { getDatabaseUrl } from './constants'
import { loadAppSettings } from '@/models/settings'
import type { SqlClient } from '@/repositories/SqlClient'

let databasePromise: Promise<SqlClient> | null = null
let activeDatabaseUrl: string | null = null

export function getDatabase(): Promise<SqlClient> {
  const dataDirectory = loadAppSettings().dataDirectory
  const databaseUrl = getDatabaseUrl(dataDirectory)
  if (activeDatabaseUrl !== databaseUrl) {
    activeDatabaseUrl = databaseUrl
    databasePromise = null
  }

  // The Rust SQL plugin owns all schema migrations. Do not run CREATE/ALTER statements here:
  // doing so bypasses SQLx's migration checksum and made existing databases appear to need a
  // migration on every startup.
  databasePromise ??= invoke('prepare_database', {
    dataDirectory,
  }).then(() => Database.load(databaseUrl)).then(async (database) => {
    await database.execute('PRAGMA foreign_keys = ON')
    await database.execute('PRAGMA journal_mode = WAL')
    await database.execute('PRAGMA busy_timeout = 5000')
    await database.execute('PRAGMA synchronous = NORMAL')
    await database.execute('PRAGMA temp_store = MEMORY')
    return database
  })
  return databasePromise
}

export async function closeDatabase(): Promise<void> {
  const database = await databasePromise?.catch(() => null)
  if (database?.close) {
    await database.close(activeDatabaseUrl ?? undefined)
  }
  databasePromise = null
  activeDatabaseUrl = null
}

export function resetDatabaseConnectionForTests(): void {
  databasePromise = null
  activeDatabaseUrl = null
}
