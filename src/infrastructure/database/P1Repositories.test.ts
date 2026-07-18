import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'

import { TauriKnowledgeRepository } from './TauriKnowledgeRepository'
import { TauriWorkRepository } from './TauriWorkRepository'
import type { SqlClient, SqlExecuteResult, SqlValue } from '@/repositories/SqlClient'

class SqliteClient implements SqlClient {
  readonly database = new DatabaseSync(':memory:')

  async execute(sql: string, bindValues: SqlValue[] = []): Promise<SqlExecuteResult> {
    const result = this.database.prepare(sql).run(...bindValues.map(toSqliteValue))
    return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) }
  }

  async select<T extends Record<string, unknown>>(
    sql: string,
    bindValues: SqlValue[] = [],
  ): Promise<T[]> {
    return this.database.prepare(sql).all(...bindValues.map(toSqliteValue)) as T[]
  }
}

function toSqliteValue(value: SqlValue): string | number | null {
  return typeof value === 'boolean' ? Number(value) : value
}

describe('P1 repositories', () => {
  let client: SqliteClient

  beforeEach(() => {
    client = new SqliteClient()
    client.database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE documents (id TEXT PRIMARY KEY);
      INSERT INTO documents VALUES ('doc-1');
      CREATE TABLE knowledge_objects (
        id TEXT PRIMARY KEY, object_type TEXT NOT NULL, status TEXT NOT NULL,
        title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', structured_data_json TEXT NOT NULL DEFAULT '{}',
        generated_run_id TEXT, cognitive_mode TEXT, template_id TEXT, template_version INTEGER,
        owner_id TEXT, scope_json TEXT NOT NULL,
        document_id TEXT, block_id TEXT, source_revision INTEGER,
        authority_level TEXT NOT NULL, confidence REAL, valid_from INTEGER,
        valid_until INTEGER, verified_at INTEGER, version INTEGER NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        FOREIGN KEY (document_id) REFERENCES documents(id)
      );
      CREATE TABLE knowledge_object_relations (
        id TEXT PRIMARY KEY, from_object_id TEXT NOT NULL, relation_type TEXT NOT NULL,
        to_object_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(from_object_id, relation_type, to_object_id),
        FOREIGN KEY (from_object_id) REFERENCES knowledge_objects(id),
        FOREIGN KEY (to_object_id) REFERENCES knowledge_objects(id)
      );
      CREATE TABLE knowledge_object_sources (
        id TEXT PRIMARY KEY, knowledge_object_id TEXT NOT NULL, document_id TEXT NOT NULL,
        block_id TEXT, revision INTEGER NOT NULL, quote TEXT, start_offset INTEGER,
        end_offset INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE knowledge_validations (
        id TEXT PRIMARY KEY, knowledge_object_id TEXT NOT NULL, rule_id TEXT NOT NULL,
        verdict TEXT NOT NULL, severity TEXT NOT NULL, message TEXT NOT NULL,
        source_json TEXT NOT NULL, validated_at INTEGER NOT NULL
      );
      CREATE TABLE task_definitions (
        id TEXT PRIMARY KEY, definition_type TEXT NOT NULL, name TEXT NOT NULL,
        instruction TEXT NOT NULL, acceptance_criteria_json TEXT NOT NULL,
        execution_policy_json TEXT NOT NULL, source_knowledge_object_id TEXT,
        automation_id TEXT, enabled INTEGER NOT NULL, version INTEGER NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE task_runs (
        id TEXT PRIMARY KEY, task_definition_id TEXT, status TEXT NOT NULL,
        frozen_input_json TEXT NOT NULL, acceptance_criteria_json TEXT NOT NULL,
        output_json TEXT, error TEXT, context_bundle_id TEXT, correlation_id TEXT NOT NULL,
        causation_id TEXT, queued_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER
      );
      CREATE TABLE work_artifacts (
        id TEXT PRIMARY KEY, task_run_id TEXT NOT NULL, artifact_type TEXT NOT NULL,
        name TEXT NOT NULL, uri TEXT, content_json TEXT, content_hash TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE work_evidence (
        id TEXT PRIMARY KEY, task_run_id TEXT NOT NULL, evidence_type TEXT NOT NULL,
        status TEXT NOT NULL, document_id TEXT, block_id TEXT, source_revision INTEGER,
        artifact_id TEXT, claim TEXT NOT NULL, details_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE result_verifications (
        id TEXT PRIMARY KEY, task_run_id TEXT NOT NULL, verdict TEXT NOT NULL,
        checks_json TEXT NOT NULL, summary TEXT NOT NULL, proposed_change_set_id TEXT,
        correlation_id TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE change_sets (
        id TEXT PRIMARY KEY, task_run_id TEXT, agent_task_id TEXT, status TEXT NOT NULL,
        title TEXT NOT NULL, description TEXT NOT NULL, patch_set_task_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
        decision TEXT NOT NULL, actor_id TEXT NOT NULL, details_json TEXT NOT NULL,
        correlation_id TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `)
  })

  it('persists versioned Knowledge Objects and semantic relations', async () => {
    const repository = new TauriKnowledgeRepository(client)
    const rule = await repository.createObject({
      id: 'rule-1',
      objectType: 'rule',
      status: 'active',
      title: '必须审批',
      documentId: 'doc-1',
      blockId: 'block-1',
      sourceRevision: 3,
      authorityLevel: 'policy',
      createdAt: 1,
    })
    await repository.createObject({
      id: 'decision-1',
      objectType: 'decision',
      status: 'approved',
      title: '采用方案 A',
      createdAt: 1,
    })
    const relation = await repository.addRelation({
      id: 'relation-1',
      fromObjectId: 'decision-1',
      relationType: 'supports',
      toObjectId: 'rule-1',
      createdAt: 2,
    })
    const effective = await repository.listObjects({
      types: ['rule', 'decision'],
      documentId: 'doc-1',
      effectiveAt: 3,
    })

    expect(rule.ok && rule.value.version).toBe(1)
    expect(relation.ok).toBe(true)
    expect(effective.ok && effective.value.map((item) => item.id).sort()).toEqual([
      'decision-1',
      'rule-1',
    ])
    const deleted = await repository.deleteObject('decision-1', 1)
    expect(deleted).toMatchObject({ ok: true })
    expect(await repository.getObject('decision-1')).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    })
  })

  it('persists unified TaskRun, Artifact and Evidence with guarded status updates', async () => {
    const repository = new TauriWorkRepository(client)
    const definition = await repository.createDefinition({
      id: 'definition-1',
      definitionType: 'knowledge',
      name: '验证规则',
      instruction: '检查规则落地',
      acceptanceCriteria: { requiredArtifacts: [{ artifactType: 'report' }] },
      createdAt: 1,
    })
    const run = await repository.createRun({
      id: 'run-1',
      taskDefinitionId: 'definition-1',
      acceptanceCriteria: { minimumEvidence: 1 },
      queuedAt: 2,
    })
    await repository.addArtifact({
      id: 'artifact-1',
      taskRunId: 'run-1',
      artifactType: 'report',
      name: '报告',
      uri: null,
      content: { result: 'ok' },
      contentHash: 'hash',
      createdAt: 3,
    })
    await repository.addEvidence({
      id: 'evidence-1',
      taskRunId: 'run-1',
      evidenceType: 'document_source',
      status: 'valid',
      documentId: 'doc-1',
      blockId: 'block-1',
      sourceRevision: 3,
      artifactId: 'artifact-1',
      claim: '规则存在',
      details: {},
      createdAt: 4,
    })
    const started = await repository.updateRunStatus({
      id: 'run-1',
      expectedStatus: 'queued',
      status: 'running',
      startedAt: 5,
    })
    const staleUpdate = await repository.updateRunStatus({
      id: 'run-1',
      expectedStatus: 'queued',
      status: 'cancelled',
    })
    const invalidTransition = await repository.updateRunStatus({
      id: 'run-1',
      expectedStatus: 'running',
      status: 'queued',
    })

    expect(definition.ok).toBe(true)
    expect(run.ok).toBe(true)
    expect(started.ok && started.value.status).toBe('running')
    expect(staleUpdate).toMatchObject({ ok: false, error: { code: 'revision-conflict' } })
    expect(invalidTransition).toMatchObject({
      ok: false,
      error: { code: 'validation-error' },
    })
    expect((await repository.listArtifacts('run-1')).ok).toBe(true)
    expect((await repository.listEvidence('run-1')).ok).toBe(true)
  })

  it('persists cognitive candidates, multiple sources and validations with guarded decisions', async () => {
    const repository = new TauriKnowledgeRepository(client)
    const candidate = await repository.createObject({
      id: 'claim-1',
      objectType: 'claim',
      status: 'candidate',
      title: '候选结论',
      content: '结构化研究产生的候选结论',
      structuredData: { confidence: 'medium' },
      generatedRunId: 'run-cognitive-1',
      cognitiveMode: 'research',
      templateId: 'default-cognitive-control',
      templateVersion: 1,
      createdAt: 10,
    })
    await repository.addSource({
      id: 'source-1',
      knowledgeObjectId: 'claim-1',
      documentId: 'doc-1',
      blockId: 'block-1',
      revision: 3,
      quote: '原文',
      startOffset: 0,
      endOffset: 2,
      createdAt: 11,
    })
    await repository.addValidation({
      id: 'validation-1',
      knowledgeObjectId: 'claim-1',
      ruleId: 'source-present',
      verdict: 'passed',
      severity: 'info',
      message: '存在可定位来源',
      source: { sourceId: 'source-1' },
      validatedAt: 12,
    })
    const stale = await repository.decideCandidate({
      id: 'claim-1',
      expectedVersion: 0,
      decision: 'approved',
    })
    const approved = await repository.decideCandidate({
      id: 'claim-1',
      expectedVersion: 1,
      decision: 'approved',
    })

    expect(candidate).toMatchObject({
      ok: true,
      value: { objectType: 'claim', content: '结构化研究产生的候选结论' },
    })
    expect(stale).toMatchObject({ ok: false, error: { code: 'revision-conflict' } })
    expect(approved).toMatchObject({ ok: true, value: { status: 'approved', version: 2 } })
    expect(await repository.listSources('claim-1')).toMatchObject({
      ok: true,
      value: [{ id: 'source-1' }],
    })
    expect(await repository.listValidations('claim-1')).toMatchObject({
      ok: true,
      value: [{ id: 'validation-1', verdict: 'passed' }],
    })
  })
})
