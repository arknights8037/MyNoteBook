export class JsonCodecError extends Error {
  readonly field: string
  readonly cause: unknown

  constructor(field: string, cause: unknown) {
    super(`无法解析 ${field} JSON。`)
    this.name = 'JsonCodecError'
    this.field = field
    this.cause = cause
  }
}

export function parseJsonStrict<T>(value: unknown, field: string): T {
  if (typeof value !== 'string' || !value.trim()) {
    throw new JsonCodecError(field, value)
  }
  try {
    return JSON.parse(value) as T
  } catch (error) {
    throw new JsonCodecError(field, error)
  }
}

export function parseJsonOrNull(value: unknown): unknown | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function parseJsonObject(value: unknown): Record<string, unknown> {
  const parsed = parseJsonOrNull(value)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
}

export function parseJsonArray(value: unknown): unknown[] {
  const parsed = parseJsonOrNull(value)
  return Array.isArray(parsed) ? parsed : []
}

export function parseStringArray(value: unknown): string[] {
  return parseJsonArray(value).filter((item): item is string => typeof item === 'string')
}

export function parseVersionedJson<T extends { version: number }>(
  value: unknown,
  version = 1,
): T | null {
  const parsed = parseJsonOrNull(value)
  return parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    (parsed as { version?: unknown }).version === version
    ? (parsed as T)
    : null
}
