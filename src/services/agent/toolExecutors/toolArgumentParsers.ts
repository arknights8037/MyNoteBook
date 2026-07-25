/** Pure argument parsing utilities shared across all tool executors. */

export function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`工具参数 ${field} 不能为空。`)
  return value.trim()
}

export function readOptionalString(value: unknown, field: string): string {
  if (value === undefined) return ''
  if (typeof value !== 'string') throw new Error(`工具参数 ${field} 必须是字符串。`)
  return value.trim()
}

export function readLimit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(Math.round(value), 10))
    : fallback
}

export function normalizeRegexFlags(value: unknown): string {
  const flags = typeof value === 'string' ? value.replace(/[^gim]/g, '') : ''
  return Array.from(new Set(flags.split(''))).join('')
}

export function readStringArray(value: unknown, field: string, maxItems = 12): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`工具参数 ${field} 必须是字符串数组。`)
  }
  if (value.length > maxItems) throw new Error(`工具参数 ${field} 最多包含 ${maxItems} 项。`)
  return value as string[]
}

export function readOptionalInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`工具参数 ${field} 必须是 ${minimum} 到 ${maximum} 之间的整数。`)
  }
  return value
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
