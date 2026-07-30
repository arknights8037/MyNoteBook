import { invoke } from '@tauri-apps/api/core'

import { loadAppSettings } from '@/models/settings/settings'
import type {
  DatabaseMutation,
  SqlClient,
  SqlExecuteResult,
  SqlValue,
} from '@/repositories/shared/SqlClient'

let databasePromise: Promise<SqlClient> | null = null
let activeDataDirectory: string | null = null

export function getDatabase(): Promise<SqlClient> {
  const dataDirectory = loadAppSettings().dataDirectory
  if (activeDataDirectory !== dataDirectory) {
    activeDataDirectory = dataDirectory
    databasePromise = null
  }

  // Rust owns schema migration and both read/write database connections. The WebView only sends
  // scalar bind values and receives serialized rows; it never receives a SQLite handle.
  databasePromise ??= invoke('prepare_database', {
    dataDirectory,
  }).then(async () => {
    await invoke('resume_dingtalk_connectors', { dataDirectory }).catch((error) => {
      console.warn('Unable to resume DingTalk connectors', error)
    })
    return {
      mutate: (mutation: DatabaseMutation, values: SqlValue[] = []) =>
        invoke<SqlExecuteResult>('execute_database_mutation', {
          input: { dataDirectory, mutation, values },
        }),
      select: <T extends Record<string, unknown>>(sql: string, values: SqlValue[] = []) =>
        invoke<T[]>('execute_database_query', {
          input: { dataDirectory, query: sql, values },
        }),
      close: () => invoke<boolean>('close_database_read_pool', { dataDirectory }),
    } satisfies SqlClient
  })
  return databasePromise
}

export async function closeDatabase(): Promise<void> {
  const database = await databasePromise?.catch(() => null)
  if (database?.close) {
    await database.close()
  }
  databasePromise = null
  activeDataDirectory = null
}

export function resetDatabaseConnectionForTests(): void {
  databasePromise = null
  activeDataDirectory = null
}
