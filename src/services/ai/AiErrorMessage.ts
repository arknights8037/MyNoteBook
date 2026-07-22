export function formatAiErrorMessage(error: unknown): string {
  const messages = collectErrorMessages(error).join(' ')
  if (/insufficient\s+balance|balance\s+insufficient|余额不足/i.test(messages)) {
    return '当前 AI Provider 账户余额不足。请充值，或在 AI 设置中切换 Provider / API Key 后重试。'
  }
  if (/insufficient[_\s-]+quota|quota\s+exceeded|额度不足/i.test(messages)) {
    return '当前 AI Provider 的调用额度已用尽。请检查账户额度，或切换 Provider / API Key 后重试。'
  }
  return error instanceof Error ? error.message : String(error)
}

function collectErrorMessages(error: unknown): string[] {
  const messages: string[] = []
  let current: unknown = error
  const seen = new Set<unknown>()
  for (let depth = 0; depth < 5 && current && !seen.has(current); depth += 1) {
    seen.add(current)
    if (current instanceof Error && current.message) messages.push(current.message)
    if (typeof current !== 'object') break
    current = Reflect.get(current, 'cause')
  }
  return messages
}
