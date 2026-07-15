const REDACTED = '[REDACTED]'

const SENSITIVE_KEYS = new Set([
  'apikey',
  'authorization',
  'capabilitytoken',
  'clientsecret',
  'cookie',
  'password',
  'passwd',
  'proxyauthorization',
  'refreshtoken',
  'secret',
  'setcookie',
  'token',
  'xapikey',
])

export function redactSensitiveText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, `Bearer ${REDACTED}`)
    .replace(
      /((?:authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|capability[_-]?token|client[_-]?secret|password|passwd|cookie|set-cookie|secret)\s*["']?\s*[:=]\s*["']?)([^"'\s,;}]+)/gi,
      `$1${REDACTED}`,
    )
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, REDACTED)
    .replace(/(https?:\/\/[^/\s:@]+:)[^@\s/]+@/gi, `$1${REDACTED}@`)
}

export function redactSensitiveValue(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>(), 0)
}

export function safeAuditJson(value: unknown, maxChars = 24_000): string {
  const json = JSON.stringify(redactSensitiveValue(value)) ?? 'null'
  return json.length > maxChars ? `${json.slice(0, maxChars)}…` : json
}

export function safeErrorMessage(error: unknown, maxChars = 4_000): string {
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error))
  return message.length > maxChars ? `${message.slice(0, maxChars)}…` : message
}

function redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === 'string') return redactSensitiveText(value)
  if (!value || typeof value !== 'object') return value
  if (depth >= 12) return '[TRUNCATED]'
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen, depth + 1))
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      isSensitiveKey(key) ? REDACTED : redactValue(item, seen, depth + 1),
    ]),
  )
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase())
}
