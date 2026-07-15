import type { AiChatMode } from '@/models/aiChatMode'

export function resolveAiExecutionMode(
  mode: AiChatMode,
  prompt: string,
): Exclude<AiChatMode, 'auto'> {
  if (mode !== 'auto') return mode
  const normalizedPrompt = prompt.toLocaleLowerCase()
  if (isDocumentCreationPrompt(normalizedPrompt)) return 'agent'
  if (/(全面|多步|调研|检索|知识库|对比|规划|方案|梳理.*资料|整合.*资料)/.test(normalizedPrompt)) {
    return 'agent'
  }
  if (
    /(改写|重写|润色|修改|补全|扩写|精简|生成.*(?:文档|大纲|提纲|总结)|整理.*(?:页面|文档|内容))/.test(
      normalizedPrompt,
    )
  ) {
    return 'edit'
  }
  return 'ask'
}

export function inferAiAgentIntent(prompt: string): 'create' | 'default' {
  return isDocumentCreationPrompt(prompt) ? 'create' : 'default'
}

function isDocumentCreationPrompt(prompt: string): boolean {
  return /(?:新建|创建|建立|新增)[^。！？\n]{0,24}(?:子页面|页面|文档|笔记)/i.test(prompt)
}

export function buildAiPrompt(prompt: string, mode: Exclude<AiChatMode, 'auto'>): string {
  if (mode === 'ask') return prompt
  if (mode === 'agent') {
    return [
      '你是知识库 Agent。默认没有引用任何文档；仅在任务需要时调用只读工具获取当前页面、选中块、大纲或知识库资料。',
      structuredOutputInstruction(),
      '用户要求：',
      prompt,
    ].join('\n')
  }
  return ['请根据用户要求改写目标块。', structuredOutputInstruction(), '用户要求：', prompt].join(
    '\n',
  )
}

function structuredOutputInstruction(): string {
  return [
    '只输出 JSON，且必须符合 Runtime 的结构化输出 schema；不要 Markdown 围栏或额外文字。',
    '格式：{"patches":[{"documentId":"目标文档 id","operation":"replace|insert_before|insert_after|append","blockId":"目标块 id","targetBlockIds":["目标块 id"],"after":"Markdown 内容","reason":"修改原因"}],"finalAnswer":"可选摘要"}。',
    '对确定性文本变换优先使用 commands：{"commands":[{"tool":"replace_text_by_regex","pattern":"正则","replacement":"替换文本","flags":"g","blockIds":["目标块 id"],"reason":"原因"}]}。',
    '写操作只可生成 Patch；不得执行写入。targetBlockIds 必须来自“本次需要修改的目标块”。',
    '需要读取资料时直接使用 Runtime 提供的原生工具，不要手写 toolCalls。',
  ].join('\n')
}
