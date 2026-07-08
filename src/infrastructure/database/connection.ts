import Database from '@tauri-apps/plugin-sql'

import { getDatabaseUrl } from './constants'
import {
  CREATE_ASSETS_TABLE_SQL,
  CREATE_DOCUMENT_TAGS_TABLE_SQL,
  CREATE_DOCUMENTS_PARENT_INDEX_SQL,
  CREATE_DOCUMENTS_TABLE_SQL,
  CREATE_DOCUMENTS_UPDATED_INDEX_SQL,
  CREATE_DOCUMENT_TAGS_TAG_INDEX_SQL,
  CREATE_TAGS_TABLE_SQL,
} from './schema'
import { loadAppSettings } from '@/models/settings'
import type { SqlClient } from '@/repositories/SqlClient'

let databasePromise: Promise<SqlClient> | null = null
let activeDatabaseUrl: string | null = null

export function getDatabase(): Promise<SqlClient> {
  const databaseUrl = getDatabaseUrl(loadAppSettings().dataDirectory)
  if (activeDatabaseUrl !== databaseUrl) {
    activeDatabaseUrl = databaseUrl
    databasePromise = null
  }

  databasePromise ??= Database.load(databaseUrl).then(async (database) => {
    await ensureDatabaseSchema(database)
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

async function ensureDatabaseSchema(database: SqlClient): Promise<void> {
  await database.execute(CREATE_DOCUMENTS_TABLE_SQL)

  const columns = await database.select<{ name: string }>('PRAGMA table_info(documents)')
  await ensureColumn(
    database,
    columns,
    'document_kind',
    "ALTER TABLE documents ADD COLUMN document_kind TEXT NOT NULL DEFAULT 'article'",
  )
  await ensureColumn(
    database,
    columns,
    'source_url',
    "ALTER TABLE documents ADD COLUMN source_url TEXT NOT NULL DEFAULT ''",
  )
  await ensureColumn(
    database,
    columns,
    'author',
    "ALTER TABLE documents ADD COLUMN author TEXT NOT NULL DEFAULT ''",
  )
  await ensureColumn(
    database,
    columns,
    'description',
    "ALTER TABLE documents ADD COLUMN description TEXT NOT NULL DEFAULT ''",
  )

  await database.execute(CREATE_DOCUMENTS_PARENT_INDEX_SQL)
  await database.execute(CREATE_DOCUMENTS_UPDATED_INDEX_SQL)
  await database.execute(CREATE_ASSETS_TABLE_SQL)

  const assetColumns = await database.select<{ name: string }>('PRAGMA table_info(assets)')
  await ensureColumn(
    database,
    assetColumns,
    'content_hash',
    "ALTER TABLE assets ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''",
  )
  await ensureColumn(
    database,
    assetColumns,
    'updated_at',
    'ALTER TABLE assets ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0',
  )

  await database.execute(CREATE_TAGS_TABLE_SQL)
  await database.execute(CREATE_DOCUMENT_TAGS_TABLE_SQL)
  await database.execute(CREATE_DOCUMENT_TAGS_TAG_INDEX_SQL)
}

async function ensureColumn(
  database: SqlClient,
  columns: Array<{ name: string }>,
  columnName: string,
  alterSql: string,
): Promise<void> {
  if (!columns.some((column) => column.name === columnName)) {
    await database.execute(alterSql)
  }
}
