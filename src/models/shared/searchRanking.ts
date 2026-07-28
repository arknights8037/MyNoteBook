export interface SearchRankingField {
  text: string
  weight?: number
}

export interface RankedSearchItem<T> {
  item: T
  score: number
}

/**
 * Ranks short selector options without requiring an exact contiguous query.
 * It normalizes width, accents, case and separators, then falls back to an
 * ordered-subsequence match so queries such as "agentmvp" or "amvp" can
 * match "Agent MVP" while preserving predictable title-first ordering.
 */
export function rankSearchItems<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => readonly SearchRankingField[],
): T[] {
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedQuery) return [...items]

  return items
    .map((item, index) => ({
      item,
      index,
      score: scoreSearchFields(normalizedQuery, fields(item)),
    }))
    .filter((entry): entry is typeof entry & { score: number } => entry.score !== null)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.item)
}

export function matchesSearchFields(query: string, fields: readonly SearchRankingField[]): boolean {
  const normalizedQuery = normalizeSearchText(query)
  return normalizedQuery ? scoreSearchFields(normalizedQuery, fields) !== null : true
}

export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function scoreSearchFields(
  normalizedQuery: string,
  fields: readonly SearchRankingField[],
): number | null {
  const queryTokens = normalizedQuery.split(' ').filter(Boolean)
  const compactQuery = compactSearchText(normalizedQuery)
  let score = 0

  for (const token of queryTokens) {
    let bestTokenScore: number | null = null
    for (const field of fields) {
      const fieldScore = scoreToken(token, field.text)
      if (fieldScore === null) continue
      const weighted = fieldScore * Math.max(0.1, field.weight ?? 1)
      bestTokenScore = bestTokenScore === null ? weighted : Math.max(bestTokenScore, weighted)
    }
    if (bestTokenScore === null) return null
    score += bestTokenScore
  }

  for (const field of fields) {
    const normalizedField = normalizeSearchText(field.text)
    const weight = Math.max(0.1, field.weight ?? 1)
    if (normalizedField === normalizedQuery) score += 160 * weight
    else if (normalizedField.startsWith(normalizedQuery)) score += 110 * weight
    else if (normalizedField.includes(normalizedQuery)) score += 80 * weight
    else if (compactSearchText(normalizedField).includes(compactQuery)) score += 60 * weight
  }
  return score
}

function scoreToken(token: string, value: string): number | null {
  const normalizedValue = normalizeSearchText(value)
  if (!normalizedValue) return null
  if (normalizedValue === token) return 120
  if (normalizedValue.startsWith(token)) return 95
  const includedAt = normalizedValue.indexOf(token)
  if (includedAt >= 0) return 80 - Math.min(includedAt, 30)

  const compactToken = compactSearchText(token)
  const compactValue = compactSearchText(normalizedValue)
  const compactAt = compactValue.indexOf(compactToken)
  if (compactAt >= 0) return 65 - Math.min(compactAt, 25)
  if (compactToken.length < 2) return null

  const initials = normalizedValue
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
  if (initials.startsWith(compactToken)) return 58
  if (initials.includes(compactToken)) return 52

  const span = orderedSubsequenceSpan(compactToken, compactValue)
  if (span === null || span > compactToken.length * 4) return null
  return Math.max(18, 48 - (span - compactToken.length) * 3)
}

function compactSearchText(value: string): string {
  return value.replace(/\s+/g, '')
}

function orderedSubsequenceSpan(query: string, value: string): number | null {
  let queryIndex = 0
  let firstMatch = -1
  let lastMatch = -1
  for (let index = 0; index < value.length && queryIndex < query.length; index += 1) {
    if (value[index] !== query[queryIndex]) continue
    if (firstMatch < 0) firstMatch = index
    lastMatch = index
    queryIndex += 1
  }
  return queryIndex === query.length ? lastMatch - firstMatch + 1 : null
}
