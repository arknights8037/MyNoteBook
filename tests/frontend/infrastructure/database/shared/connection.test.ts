import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@/models/settings/settings', () => ({
  loadAppSettings: () => ({ dataDirectory: 'C:/data' }),
}))

import {
  closeDatabase,
  getDatabase,
  resetDatabaseConnectionForTests,
} from '@/infrastructure/database/shared/connection'

describe('database connection ownership', () => {
  beforeEach(() => {
    resetDatabaseConnectionForTests()
    invoke.mockReset()
    invoke.mockImplementation(async (command: string) => {
      if (command === 'execute_database_query') return [{ id: 'task-1' }]
      if (command === 'execute_database_mutation') return { rowsAffected: 1, lastInsertId: 0 }
      if (command === 'close_database_read_pool') return true
      return undefined
    })
  })

  it('routes reads, catalogued writes, and connection close through Rust', async () => {
    const client = await getDatabase()

    await expect(client.select('SELECT id FROM agent_tasks')).resolves.toEqual([{ id: 'task-1' }])
    await expect(client.mutate('deleteAutomationTask', ['task-1'])).resolves.toEqual({
      rowsAffected: 1,
      lastInsertId: 0,
    })
    await closeDatabase()

    expect(invoke).toHaveBeenCalledWith('execute_database_query', {
      input: {
        dataDirectory: 'C:/data',
        query: 'SELECT id FROM agent_tasks',
        values: [],
      },
    })
    expect(invoke).toHaveBeenCalledWith('execute_database_mutation', {
      input: {
        dataDirectory: 'C:/data',
        mutation: 'deleteAutomationTask',
        values: ['task-1'],
      },
    })
    expect(invoke).toHaveBeenCalledWith('close_database_read_pool', {
      dataDirectory: 'C:/data',
    })
  })
})
