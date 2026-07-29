import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import { TauriInformationHomeRepository } from '@/infrastructure/database/home/TauriInformationHomeRepository'
import { createInformationHome } from '@/models/home/informationHome'
import type { SqlClient, SqlExecuteResult, SqlValue } from '@/repositories/shared/SqlClient'

class Client implements SqlClient {
  database = new DatabaseSync(':memory:')
  async execute(sql: string, values: SqlValue[] = []): Promise<SqlExecuteResult> {
    const result = this.database.prepare(sql).run(...values.map(normalizeValue))
    return { rowsAffected: Number(result.changes) }
  }
  async select<T extends Record<string, unknown>>(
    sql: string,
    values: SqlValue[] = [],
  ): Promise<T[]> {
    return this.database.prepare(sql).all(...values.map(normalizeValue)) as T[]
  }
}

describe('TauriInformationHomeRepository', () => {
  it('persists the singleton layout and summary history outside workspace views', async () => {
    const client = new Client()
    client.database.exec(
      readFileSync(
        join(process.cwd(), 'src-tauri/migrations/0035_add_information_home.sql'),
        'utf8',
      ),
    )
    const repository = new TauriInformationHomeRepository(client)
    const home = createInformationHome((prefix) => `${prefix}-1`, 10)

    expect(await repository.create(home)).toMatchObject({
      ok: true,
      value: { id: 'default', version: 1 },
    })
    expect(await repository.updatePayload(home.payload, 1, 20)).toMatchObject({
      ok: true,
      value: { version: 2, updatedAt: 20 },
    })
    expect(await repository.updatePayload(home.payload, 1, 30)).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    })
    expect(await repository.updateSummarySettings(true, 120, 30)).toMatchObject({
      ok: true,
      value: { autoSummaryEnabled: true, summaryIntervalMinutes: 120 },
    })
    await repository.createSummary({
      id: 'summary-1',
      homeId: 'default',
      sourceCursorAt: 25,
      triggerSource: 'auto',
      status: 'completed',
      content: '摘要',
      provider: 'openai',
      model: 'model',
      error: null,
      generatedAt: 40,
    })
    expect(await repository.listSummaries()).toMatchObject({
      ok: true,
      value: [{ id: 'summary-1', content: '摘要', triggerSource: 'auto' }],
    })
    expect(
      client.database
        .prepare(
          "SELECT count(*) count FROM sqlite_master WHERE type='table' AND name='workspace_views'",
        )
        .get(),
    ).toEqual({ count: 0 })
  })
})

function normalizeValue(value: SqlValue) {
  return typeof value === 'boolean' ? Number(value) : value
}
