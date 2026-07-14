import { describe, expect, it } from 'vitest'

import {
  createCompatibleAgentTextOutput,
  normalizeAgentOutputCandidate,
  normalizeAgentOutputForTaskIntent,
  parseAiSdkAgentOutput,
  requiresKnowledgeRetrieval,
} from './AiSdkAgentRuntime'

describe('AI SDK Agent runtime output', () => {
  it('validates a final structured patch', () => {
    const output = parseAiSdkAgentOutput(
      JSON.stringify({
        patches: [
          {
            operation: 'replace',
            blockId: 'block-1',
            targetBlockIds: ['block-1'],
            after: '- [x] P1 Agent Loop',
            reason: '完成事项',
          },
        ],
        finalAnswer: '已生成修改。',
      }),
    )

    expect(output.patches).toHaveLength(1)
    expect(output.commands).toEqual([])
  })

  it('accepts a JSON markdown fence from compatible providers', () => {
    const output = parseAiSdkAgentOutput(
      '```json\n{"commands":[{"tool":"replace_text_by_regex","pattern":"P1","replacement":"P0"}]}\n```',
    )
    expect(output.commands).toHaveLength(1)
  })

  it('rejects natural-language completion without a Patch', () => {
    expect(() => parseAiSdkAgentOutput('已经修改完成。')).toThrow('不符合 Patch schema')
  })

  it('keeps a valid patch while removing a redundant malformed command', () => {
    const output = normalizeAgentOutputCandidate(
      JSON.stringify({
        outcome: 'proposal',
        commands: [{ type: 'replace_text_by_regex', pattern: '旧', replacement: '新' }],
        patches: [
          {
            operation: 'replace',
            blockId: 'block-1',
            targetBlockIds: ['block-1'],
            after: '新内容',
            reason: '根据资料补全',
          },
        ],
      }),
    )

    expect(output?.commands).toEqual([])
    expect(output?.patches).toHaveLength(1)
  })

  it('normalizes unambiguous patch aliases before strict validation', () => {
    const output = normalizeAgentOutputCandidate(
      JSON.stringify({
        outcome: 'proposal',
        patches: [
          {
            operation: 'update',
            blockId: 'block-1',
            targetBlockIds: [],
            after: '',
            value: '新内容',
            reason: '补全说明',
          },
        ],
      }),
    )

    expect(output?.patches[0]).toMatchObject({
      operation: 'replace',
      targetBlockIds: ['block-1'],
      after: '新内容',
    })
  })

  it('normalizes nested output and common snake_case aliases', () => {
    const output = normalizeAgentOutputCandidate(
      JSON.stringify({
        result: {
          changes: [
            {
              operation: 'update',
              block_id: 'block-2',
              target_block_ids: ['block-2'],
              new_content: '兼容后的内容',
              reason: '兼容供应商字段',
            },
          ],
          final_answer: '已生成兼容提案。',
        },
      }),
    )

    expect(output).toMatchObject({
      outcome: 'proposal',
      commands: [],
      finalAnswer: '已生成兼容提案。',
    })
    expect(output?.patches[0]).toMatchObject({
      operation: 'replace',
      blockId: 'block-2',
      targetBlockIds: ['block-2'],
      after: '兼容后的内容',
    })
  })

  it('shows ordinary model text safely without treating it as a write', () => {
    expect(createCompatibleAgentTextOutput('这是当前模型的普通文本回答。')).toEqual({
      outcome: 'blocked',
      commands: [],
      patches: [],
      finalAnswer: '这是当前模型的普通文本回答。',
    })
  })

  it('keeps ordinary plan output as a read-only response', () => {
    expect(createCompatibleAgentTextOutput('1. 分析现状\n2. 实施修改', 'plan')).toEqual({
      outcome: 'no_change',
      commands: [],
      patches: [],
      finalAnswer: '1. 分析现状\n2. 实施修改',
    })
  })

  it('requires retrieval only when the user actually asks for external knowledge', () => {
    expect(requiresKnowledgeRetrieval('把这条待办标成完成')).toBe(false)
    expect(requiresKnowledgeRetrieval('你翻翻知识库里的差旅规定，帮我补清楚')).toBe(true)
  })

  it('promotes a patch to a document proposal for explicit creation tasks', () => {
    const output = parseAiSdkAgentOutput(
      JSON.stringify({
        patches: [
          {
            operation: 'replace',
            blockId: 'b1',
            targetBlockIds: ['b1'],
            after: '# 发布检查清单\n\n- 构建\n- 测试\n- 回滚',
            reason: '创建清单',
          },
        ],
      }),
    )
    const normalized = normalizeAgentOutputForTaskIntent(
      output,
      '在当前页面下新建一篇《发布检查清单》',
    )
    expect(normalized.patches).toEqual([])
    expect(normalized.commands[0]).toMatchObject({
      tool: 'create_document',
      title: '发布检查清单',
    })
  })

  it('enforces read-only plan output even if the model proposes a patch', () => {
    const output = parseAiSdkAgentOutput(
      JSON.stringify({
        patches: [
          {
            operation: 'replace',
            blockId: 'b1',
            targetBlockIds: ['b1'],
            after: '新内容',
            reason: '修改',
          },
        ],
        finalAnswer: '1. 先确认范围\n2. 再实施',
      }),
    )
    expect(normalizeAgentOutputForTaskIntent(output, '制定计划', 'plan')).toEqual({
      outcome: 'no_change',
      commands: [],
      patches: [],
      finalAnswer: '1. 先确认范围\n2. 再实施',
    })
  })

  it('forces create mode patches into a single create_document command', () => {
    const output = parseAiSdkAgentOutput(
      JSON.stringify({
        patches: [
          {
            operation: 'replace',
            blockId: 'b1',
            targetBlockIds: ['b1'],
            after: '# 新页面\n\n正文',
            reason: '创建',
          },
        ],
      }),
    )
    const normalized = normalizeAgentOutputForTaskIntent(output, '整理内容', 'create')
    expect(normalized.commands).toHaveLength(1)
    expect(normalized.commands[0]).toMatchObject({ tool: 'create_document', title: '新页面' })
    expect(normalized.patches).toEqual([])
  })
})
