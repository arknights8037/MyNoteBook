export interface HighlightSegment {
  text: string
  match: boolean
}

/**
 * Split text into segments highlighting all occurrences of the query (case-insensitive).
 * Returns an array of { text, match } segments for rendering in Vue templates.
 */
export function splitHighlight(text: string, query: string): HighlightSegment[] {
  const trimmed = query.trim()
  if (!trimmed) return [{ text, match: false }]

  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(${escaped})`, 'gi')
  const parts = text.split(pattern)

  const lowerQuery = trimmed.toLocaleLowerCase()
  return parts
    .filter((part) => part.length > 0)
    .map((part) => ({
      text: part,
      match: part.toLocaleLowerCase() === lowerQuery,
    }))
}

/**
 * Check if text contains the query (case-insensitive).
 */
export function matchesFilter(text: string, query: string): boolean {
  return query.trim() !== '' && matchesSearchFields(query, [{ text }])
}
import { matchesSearchFields } from './searchRanking'
