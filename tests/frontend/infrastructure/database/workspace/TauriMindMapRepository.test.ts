import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import { createEmptyMindMapContent } from '@/models/workspace/mindMap'
import type { SqlClient, SqlExecuteResult, SqlValue } from '@/repositories/shared/SqlClient'
import { TauriMindMapRepository } from '@/infrastructure/database/workspace/TauriMindMapRepository'

class Client implements SqlClient {
  readonly database = new DatabaseSync(':memory:')

  async execute(sql: string, values: SqlValue[] = []): Promise<SqlExecuteResult> {
    const result = this.database.prepare(sql).run(...values.map((value) => typeof value === 'boolean' ? Number(value) : value))
    return { rowsAffected: Number(result.changes) }
  }

  async select<T extends Record<string, unknown>>(sql: string, values: SqlValue[] = []): Promise<T[]> {
    return this.database.prepare(sql).all(...values.map((value) => typeof value === 'boolean' ? Number(value) : value)) as T[]
  }
}

describe('TauriMindMapRepository', () => {
  it('persists aggregate versions, revision history and rejects stale writes', async () => {
    const client = new Client()
    client.database.exec(
      readFileSync(join(process.cwd(), 'src-tauri/migrations/0020_add_mind_maps.sql'), 'utf8'),
    )
    client.database.exec(
      readFileSync(
        join(process.cwd(), 'src-tauri/migrations/0022_add_mind_map_tree_position.sql'),
        'utf8',
      ),
    )
    const repository = new TauriMindMapRepository(client)
    const content = createEmptyMindMapContent('root', '产品规划')
    const created = await repository.create({
      id: 'map-1',
      title: '产品规划',
      content,
      actorType: 'user',
      createdAt: 10,
    })
    expect(created).toMatchObject({ ok: true, value: { version: 1 } })

    await expect(repository.move({
      id: 'map-1', expectedVersion: 1, parentId: 'folder-1', actorType: 'user', updatedAt: 15,
    })).resolves.toMatchObject({
      ok: true,
      value: { parentId: 'folder-1', version: 2 },
    })
    await expect(repository.move({
      id: 'map-1', expectedVersion: 1, parentId: 'folder-2', actorType: 'agent', updatedAt: 16,
    })).resolves.toMatchObject({ ok: false, error: { code: 'revision-conflict' } })

    content.nodes.child = {
      id: 'child', parentId: 'root', order: 0, text: '用户需求', note: '', collapsed: false,
      sourceRefs: [], metadata: {}, style: {},
    }
    const updated = await repository.update({
      id: 'map-1', expectedVersion: 2, title: '产品规划', content,
      actorType: 'user', updatedAt: 20,
    })
    expect(updated).toMatchObject({ ok: true, value: { version: 3 } })
    await expect(repository.update({
      id: 'map-1', expectedVersion: 2, title: '旧写入', content,
      actorType: 'agent', updatedAt: 21,
    })).resolves.toMatchObject({ ok: false, error: { code: 'revision-conflict' } })

    const revisions = client.database.prepare(
      'SELECT version, actor_type FROM mind_map_revisions WHERE mind_map_id = ? ORDER BY version',
    ).all('map-1')
    expect(revisions).toEqual([
      { version: 1, actor_type: 'user' },
      { version: 2, actor_type: 'user' },
      { version: 3, actor_type: 'user' },
    ])
    await expect(repository.list()).resolves.toMatchObject({
      ok: true,
      value: [{ id: 'map-1', parentId: 'folder-1', nodeCount: 2, version: 3 }],
    })
    await expect(repository.delete('map-1')).resolves.toEqual({ ok: true, value: undefined })
    await expect(repository.get('map-1')).resolves.toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    })
  })
})
