import { describe, expect, it } from 'vitest'

import {
  createCapturedProposalOutput,
  createNaturalAgentTextOutput,
  normalizeAgentOutputCandidate,
  normalizeAgentOutputForTaskIntent,
  parseAiSdkAgentOutput,
  resolveAgentOutputChannels,
} from './AiSdkAgentRuntime'

describe('AI SDK Agent runtime output', () => {
  it('wraps an ordinary natural-language completion without a JSON repair round', () => {
    expect(createNaturalAgentTextOutput('没有需要写入的修改，以下是分析结论。')).toEqual({
      outcome: 'no_change',
      commands: [],
      patches: [],
      finalAnswer: '没有需要写入的修改，以下是分析结论。',
    })
  })

  it('does not expose a truncated protocol payload as the final reply', () => {
    const output = createNaturalAgentTextOutput(
      '{"outcome":"proposal","commands":[{"tool":"create_document","content":"截断',
    )
    expect(output).toEqual({
      outcome: 'blocked',
      commands: [],
      patches: [],
      finalAnswer: '模型没有完成本次结构化提案；未执行任何写入，请重试。',
    })
  })

  it('builds the final proposal from a captured native tool call even when text is truncated', () => {
    const output = createCapturedProposalOutput({
      commands: [
        {
          tool: 'create_document',
          title: '知识库概念简介',
          parentDocumentId: 'group-agent-mvp',
          content: '# 知识库概念简介\n\n完整正文不会依赖最终文本再次序列化。',
        },
      ],
      patches: [],
      text: '{"outcome":"proposal","commands":[{"tool":"create_document","content":"截断',
    })

    expect(output.commands[0]).toMatchObject({
      tool: 'create_document',
      title: '知识库概念简介',
      parentDocumentId: 'group-agent-mvp',
    })
    expect(output.finalAnswer).toBe('已生成创建提案，等待确认后写入。')
  })

  it('uses a create_document proposal emitted through the reasoning channel', () => {
    const channels = resolveAgentOutputChannels(
      '',
      JSON.stringify({
        outcome: 'proposal',
        commands: [
          {
            tool: 'create_document',
            title: '知识库软件简介',
            content: '# 知识库软件简介\n\n正文',
          },
        ],
        patches: [],
        finalAnswer: '已生成新文档提案。',
      }),
    )

    expect(channels.output?.commands[0]).toMatchObject({
      tool: 'create_document',
      title: '知识库软件简介',
    })
    expect(channels.reasoningForDisplay).toBe('')
  })

  it('extracts the first valid proposal when reasoning continues with prose and JSON examples', () => {
    const proposal = JSON.stringify({
      outcome: 'proposal',
      commands: [
        {
          tool: 'create_document',
          title: '知识库软件简介',
          content: '# 知识库软件简介\n\n正文包含 {花括号} 和 \\"引号\\"。',
        },
      ],
      patches: [],
      finalAnswer: '已生成新文档提案。',
    })
    const channels = resolveAgentOutputChannels(
      '',
      `${proposal}\n\n后续解释不属于最终输出。\n示例：{"tool":"create_document","title":"示例"}`,
    )

    expect(channels.output?.commands[0]).toMatchObject({
      tool: 'create_document',
      title: '知识库软件简介',
    })
    expect(channels.reasoningForDisplay).toBe('')
  })

  it('skips unrelated JSON objects before the structured Agent result', () => {
    const output = normalizeAgentOutputCandidate(
      [
        '调试信息 {"tool":"create_document","title":"不完整示例","content":"示例正文"}',
        JSON.stringify({
          outcome: 'proposal',
          commands: [
            {
              tool: 'create_group',
              title: '资料',
              initialDocument: { title: '索引', content: '# 索引' },
            },
          ],
          patches: [],
          finalAnswer: '已生成提案。',
        }),
      ].join('\n'),
    )

    expect(output?.commands[0]).toMatchObject({ tool: 'create_group', title: '资料' })
  })

  it('uses the latest complete Agent result instead of an earlier reasoning draft', () => {
    const draft = JSON.stringify({
      outcome: 'proposal',
      commands: [{ tool: 'create_document', title: '应用概览', content: '（文档内容）' }],
      patches: [],
      finalAnswer: '草稿。',
    })
    const final = JSON.stringify({
      outcome: 'proposal',
      commands: [
        {
          tool: 'create_document',
          title: '应用概览',
          content: '# 应用概览\n\n这是 Agent 完成推理后生成的实际正文。',
        },
      ],
      patches: [],
      finalAnswer: '已生成完整提案。',
    })

    const output = normalizeAgentOutputCandidate(`${draft}\n继续推理并完善内容……\n${final}`)

    expect(output?.commands[0]).toMatchObject({
      tool: 'create_document',
      content: '# 应用概览\n\n这是 Agent 完成推理后生成的实际正文。',
    })
    expect(output?.finalAnswer).toBe('已生成完整提案。')
  })

  it('keeps ordinary reasoning visible when it is not a structured proposal', () => {
    const channels = resolveAgentOutputChannels(
      JSON.stringify({ outcome: 'no_change', commands: [], patches: [], finalAnswer: '完成' }),
      '先确认任务目标，再组织答案。',
    )

    expect(channels.output?.outcome).toBe('no_change')
    expect(channels.reasoningForDisplay).toBe('先确认任务目标，再组织答案。')
  })

  it('accepts an atomic create_group proposal with an initial document', () => {
    const output = normalizeAgentOutputCandidate(
      JSON.stringify({
        outcome: 'proposal',
        commands: [
          {
            tool: 'create_group',
            title: '知识库软件',
            initialDocument: { title: '功能与用途', content: '# 功能与用途\n\n正文' },
          },
        ],
        patches: [],
        finalAnswer: '已生成分组和初始文档提案。',
      }),
    )

    expect(output?.commands[0]).toMatchObject({
      tool: 'create_group',
      title: '知识库软件',
    })
  })

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

  it('does not rewrite the Agent proposal based on prompt wording', () => {
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
    expect(normalized.commands).toEqual([])
    expect(normalized.patches).toHaveLength(1)
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

  it('keeps the Agent-selected operation in create mode', () => {
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
    expect(normalized.commands).toEqual([])
    expect(normalized.patches).toHaveLength(1)
  })
})
