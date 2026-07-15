export interface AgentOutputContract<T> {
  id: string
  version: number
  jsonSchema: Record<string, unknown>
  systemInstruction: string
  validate(value: unknown): T
}

export function validateAgentOutputContract<T>(
  contract: AgentOutputContract<T>,
  text: string,
  reasoningText = '',
): T {
  const candidates = [text, reasoningText].filter((value) => value.trim())
  let lastError: unknown = new Error(`输出不符合 ${contract.id} v${contract.version}。`)
  for (const candidate of candidates) {
    for (const json of extractJsonValues(candidate)) {
      try {
        return contract.validate(JSON.parse(json))
      } catch (error) {
        lastError = error
      }
    }
  }
  throw lastError
}

function extractJsonValues(value: string): string[] {
  const trimmed = value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  const values: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"' && depth > 0) inString = true
    else if (character === '{' || character === '[') {
      if (depth === 0) start = index
      depth += 1
    } else if ((character === '}' || character === ']') && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        values.push(trimmed.slice(start, index + 1))
        start = -1
      }
    }
  }
  return values.length ? values : [trimmed]
}
