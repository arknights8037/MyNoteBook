import type { DocumentId, DocumentSummary } from '@/models/documents/document'
import { createInternalDocumentHref } from '@/models/documents/documentLink'

export interface KnowledgeSource {
  id: string
  documentId: DocumentId
  documentTitle: string
  contentSnippet: string
  score: number
  isCurrentDocument: boolean
  blockId?: string
  revision?: number
}

export interface KnowledgeRetrievalResult {
  sources: KnowledgeSource[]
  context: string
}

export interface KnowledgeSourceAnchorBlock {
  id: string
  index: number
  plainText: string
}

interface ScoredKnowledgeSource extends KnowledgeSource {
  titleMatches: number
  strongMatches: number
}

const MAX_QUERY_TERMS = 18
const MAX_SNIPPET_LENGTH = 260
const MIN_STRONG_MATCH_SCORE = 3
const RELATIVE_MATCH_THRESHOLD = 0.45

export function buildKnowledgeRetrievalContext(input: {
  query: string
  documents: DocumentSummary[]
  currentDocumentId: DocumentId
  currentDocumentTitle: string
  currentDocumentText: string
  maxSources?: number
}): KnowledgeRetrievalResult {
  const queryTerms = tokenizeQuery(input.query).slice(0, MAX_QUERY_TERMS)
  const sourceMap = new Map<DocumentId, KnowledgeSource>()

  sourceMap.set(input.currentDocumentId, {
    id: 'S1',
    documentId: input.currentDocumentId,
    documentTitle: input.currentDocumentTitle,
    contentSnippet: createSnippet(input.currentDocumentText, queryTerms),
    score: Number.MAX_SAFE_INTEGER,
    isCurrentDocument: true,
    revision: input.documents.find((document) => document.id === input.currentDocumentId)?.revision ?? 0,
  })

  const scoredSources = input.documents
    .filter(
      (document) =>
        document.documentKind === 'article' &&
        !document.isDeleted &&
        document.id !== input.currentDocumentId,
    )
    .map((document) => scoreDocument(document, queryTerms))
    .filter((source) => source.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || right.contentSnippet.length - left.contentSnippet.length,
    )
  const relevanceThreshold = getRelevanceThreshold(scoredSources[0]?.score ?? 0)

  const maxSources = Math.max(1, input.maxSources ?? 5)
  for (const source of scoredSources) {
    if (sourceMap.size >= maxSources) break
    if (source.score < relevanceThreshold) continue
    if (source.titleMatches === 0 && source.strongMatches === 0) continue
    sourceMap.set(source.documentId, {
      ...source,
      id: `S${sourceMap.size + 1}`,
    })
  }

  const sources = Array.from(sourceMap.values())
  return {
    sources,
    context: formatKnowledgeContext(sources),
  }
}

export function appendKnowledgeSources(markdown: string, sources: KnowledgeSource[]): string {
  const visibleSources = sources.filter((source) => source.contentSnippet.trim())
  if (visibleSources.length === 0) return markdown.trim()

  return [
    markdown.trim(),
    '',
    '## 来源',
    ...visibleSources.map(
      (source) =>
        `- [${source.id}] [${escapeMarkdownLinkText(source.documentTitle)}](${createInternalDocumentHref(
          source.documentId,
          source.blockId,
        )})：${source.contentSnippet}`,
    ),
  ].join('\n')
}

export function anchorKnowledgeRetrievalResult(
  result: KnowledgeRetrievalResult,
  query: string,
  blocksByDocumentId: Map<DocumentId, KnowledgeSourceAnchorBlock[]>,
): KnowledgeRetrievalResult {
  const queryTerms = tokenizeQuery(query).slice(0, MAX_QUERY_TERMS)
  const sources = result.sources.map((source) => {
    const block = findBestAnchorBlock(blocksByDocumentId.get(source.documentId) ?? [], queryTerms)
    if (!block) return source
    return {
      ...source,
      blockId: block.id,
      contentSnippet: createSnippet(block.plainText, queryTerms) || source.contentSnippet,
    }
  })
  return { sources, context: formatKnowledgeContext(sources) }
}

function findBestAnchorBlock(
  blocks: KnowledgeSourceAnchorBlock[],
  queryTerms: string[],
): KnowledgeSourceAnchorBlock | null {
  const ranked = blocks
    .map((block) => ({
      block,
      score: queryTerms.reduce(
        (total, term) => total + countOccurrences(block.plainText.toLocaleLowerCase(), term),
        0,
      ),
    }))
    .sort((left, right) => right.score - left.score || left.block.index - right.block.index)
  return ranked[0]?.score ? ranked[0].block : (blocks[0] ?? null)
}

function getRelevanceThreshold(topScore: number): number {
  if (topScore < MIN_STRONG_MATCH_SCORE * 3) return 1
  return Math.max(MIN_STRONG_MATCH_SCORE, topScore * RELATIVE_MATCH_THRESHOLD)
}

function scoreDocument(document: DocumentSummary, queryTerms: string[]): ScoredKnowledgeSource {
  const title = document.title || '未命名文档'
  const titleText = title.toLocaleLowerCase()
  const bodyText = [
    document.plainText,
    document.tags.join(' '),
    document.sourceUrl,
    document.author,
    document.description,
  ]
    .join('\n')
    .toLocaleLowerCase()

  let titleMatches = 0
  let strongMatches = 0
  const score = queryTerms.reduce((total, term) => {
    const titleHits = countOccurrences(titleText, term)
    const bodyHits = countOccurrences(bodyText, term)
    const hits = titleHits + bodyHits
    if (titleHits > 0) titleMatches += titleHits
    if (isStrongQueryTerm(term) && hits > 0) strongMatches += hits
    return total + titleHits * 5 + bodyHits
  }, 0)

  return {
    id: '',
    documentId: document.id,
    documentTitle: title,
    contentSnippet: createSnippet(document.plainText, queryTerms),
    score,
    isCurrentDocument: false,
    revision: document.revision,
    titleMatches,
    strongMatches,
  }
}

function isStrongQueryTerm(term: string): boolean {
  return /[0-9]/.test(term) || term.length >= 3
}

function formatKnowledgeContext(sources: KnowledgeSource[]): string {
  return sources
    .filter((source) => source.contentSnippet.trim())
    .map((source) =>
      [
        `[${source.id}] ${source.isCurrentDocument ? '当前文档' : '知识库文档'}：${source.documentTitle}`,
        `documentId: ${source.documentId}`,
        source.blockId ? `blockId: ${source.blockId}` : '',
        `snippet: ${source.contentSnippet}`,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n')
}

function createSnippet(text: string, queryTerms: string[]): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return ''

  const lowerText = normalized.toLocaleLowerCase()
  const matchedTerm = queryTerms.find((term) => lowerText.includes(term))
  if (!matchedTerm) return normalized.slice(0, MAX_SNIPPET_LENGTH)

  const matchIndex = lowerText.indexOf(matchedTerm)
  const start = Math.max(0, matchIndex - 80)
  const end = Math.min(normalized.length, matchIndex + MAX_SNIPPET_LENGTH - 80)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < normalized.length ? '...' : ''
  return prefix + normalized.slice(start, end).trim() + suffix
}

function tokenizeQuery(query: string): string[] {
  const normalized = query.toLocaleLowerCase()
  const asciiTerms = normalized.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? []
  const cjkTerms = Array.from(normalized.matchAll(/[\p{Script=Han}]{2,}/gu), (match) => match[0])
  const shortCjkTerms = cjkTerms.flatMap((term) => [
    ...slidingTerms(term, 3),
    ...slidingTerms(term, 2),
  ])
  return Array.from(new Set([...asciiTerms, ...cjkTerms, ...shortCjkTerms])).filter(
    (term) => !STOP_TERMS.has(term),
  )
}

function slidingTerms(value: string, size: number): string[] {
  if (value.length <= size) return [value]
  const terms: string[] = []
  for (let index = 0; index <= value.length - size; index += 1) {
    terms.push(value.slice(index, index + size))
  }
  return terms
}

function countOccurrences(text: string, term: string): number {
  if (!term) return 0
  let count = 0
  let index = text.indexOf(term)
  while (index >= 0) {
    count += 1
    index = text.indexOf(term, index + term.length)
  }
  return count
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/[[\]\\]/g, '\\$&')
}

const STOP_TERMS = new Set([
  '请问',
  '怎么',
  '如何',
  '什么',
  '需要',
  '可以',
  '这个',
  '那个',
  '我们',
  '公司',
  '文档',
])
