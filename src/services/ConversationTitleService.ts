import type { AiRunInput, AiSettings } from '@/models/ai'

type CompletionRunner = (input: AiRunInput) => Promise<string>

export async function generateConversationTitle(
  prompt: string,
  settings: AiSettings,
  runCompletion?: CompletionRunner,
): Promise<string> {
  const complete = runCompletion ?? (await import('./AiMarkdownService')).runAiMarkdownCompletion
  const output = await complete({
    prompt: prompt.trim(),
    context: '',
    settings: {
      ...settings,
      reasoningEffort: 'auto',
      temperature: 0.2,
      maxTokens: Math.min(settings.maxTokens, 64),
    },
    systemPrompt:
      '为这次对话生成一个简洁、具体的中文标题。只输出标题本身，不要引号、Markdown、句号或解释，最多 18 个汉字。',
    outputMode: 'markdown',
    onDelta: () => undefined,
  })
  return normalizeConversationTitle(output) || createLocalConversationTitle(prompt)
}

export function normalizeConversationTitle(value: string): string {
  return value
    .split(/\r?\n/, 1)[0]!
    .replace(/^\s*(?:#+\s*|标题\s*[:：]\s*)/, '')
    .replace(/^["'“”‘’]+|["'“”‘’。]+$/g, '')
    .trim()
    .slice(0, 36)
}

function createLocalConversationTitle(prompt: string): string {
  return (
    prompt
      .replace(/\s+/g, ' ')
      .replace(/^#+\s*/, '')
      .trim()
      .slice(0, 36) || '未命名对话'
  )
}
