import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { SqlClient, SqlExecuteResult, SqlValue } from '@/repositories/SqlClient'
import { TauriWorkspaceViewRepository } from './TauriWorkspaceViewRepository'

class Client implements SqlClient {
  database = new DatabaseSync(':memory:')
  async execute(sql: string, values: SqlValue[] = []): Promise<SqlExecuteResult> { const result = this.database.prepare(sql).run(...values.map((value) => typeof value === 'boolean' ? Number(value) : value)); return { rowsAffected: Number(result.changes) } }
  async select<T extends Record<string, unknown>>(sql: string, values: SqlValue[] = []): Promise<T[]> { return this.database.prepare(sql).all(...values.map((value) => typeof value === 'boolean' ? Number(value) : value)) as T[] }
}

describe('TauriWorkspaceViewRepository', () => {
  it('persists typed payloads, revisions and optimistic versions', async () => {
    const client = new Client()
    client.database.exec(readFileSync(join(process.cwd(), 'src-tauri/migrations/0021_add_workspace_views.sql'), 'utf8'))
    client.database.exec(readFileSync(join(process.cwd(), 'src-tauri/migrations/0023_add_workspace_view_tree_position.sql'), 'utf8'))
    client.database.exec(readFileSync(join(process.cwd(), 'src-tauri/migrations/0026_add_workspace_view_pinning.sql'), 'utf8'))
    const repository = new TauriWorkspaceViewRepository(client)
    const payload = { type: 'uml' as const, diagramType: 'flow' as const, source: 'flowchart LR\n  a[A] --> b[B]' }
    expect(await repository.create({ id: 'view-1', parentId: 'folder-1', viewType: 'uml', title: '流程', payload, createdAt: 1 })).toMatchObject({ ok: true, value: { parentId: 'folder-1', version: 1 } })
    const updated = await repository.update({ id: 'view-1', expectedVersion: 1, title: '流程', payload: { ...payload, source: 'flowchart LR\n  a[开始] --> b[完成]' }, updatedAt: 2 })
    expect(updated).toMatchObject({ ok: true, value: { version: 2 } })
    expect(await repository.update({ id: 'view-1', expectedVersion: 1, title: '旧', payload, updatedAt: 3 })).toMatchObject({ ok: false, error: { code: 'revision-conflict' } })
    expect(client.database.prepare('SELECT count(*) count FROM workspace_view_revisions').get()).toEqual({ count: 2 })
    expect(await repository.move({ id: 'view-1', expectedVersion: 2, parentId: null, updatedAt: 3 })).toMatchObject({ ok: true, value: { parentId: null } })
    expect(await repository.setPinned({ id: 'view-1', pinnedAt: 4 })).toMatchObject({ ok: true, value: { pinnedAt: 4 } })
    expect(await repository.list()).toMatchObject({ ok: true, value: [{ id: 'view-1', pinnedAt: 4 }] })
    expect(await repository.delete('view-1')).toMatchObject({ ok: true })
  })
})
