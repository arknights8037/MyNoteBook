export interface InternalDocumentTarget {
  documentId: string
  blockId?: string
}

export interface InternalDocumentLinkCandidate {
  id: string
  title: string
  sourceUrl?: string
}

export function createInternalDocumentHref(documentId: string, blockId?: string): string {
  const params = new URLSearchParams({ document: documentId })
  if (blockId?.trim()) params.set('block', blockId.trim())
  return `#${params.toString()}`
}

export function parseInternalDocumentHref(href: string): InternalDocumentTarget | null {
  if (!href.startsWith('#document=')) return null
  const params = new URLSearchParams(href.slice(1))
  const documentId = params.get('document')?.trim() ?? ''
  if (!documentId) return null
  const blockId = params.get('block')?.trim() || undefined
  return { documentId, blockId }
}

export function isLocalDocumentHref(href: string): boolean {
  const value = href.trim()
  if (!value || value.startsWith('#')) return false
  if (/^[a-z]:[\\/]/i.test(value)) return true
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.toLocaleLowerCase().startsWith('file:')) return false
  return /(?:^file:|[\\/]|\.(?:md|markdown)(?:[?#].*)?$)/i.test(value)
}

export function resolveLocalDocumentHref(
  href: string,
  documents: InternalDocumentLinkCandidate[],
): InternalDocumentTarget | null {
  if (!isLocalDocumentHref(href)) return null
  const path = normalizeLocalPath(href)
  const fileName = path.split('/').filter(Boolean).at(-1) ?? path
  const stem = normalizeLookupValue(fileName.replace(/\.(?:md|markdown)$/i, ''))

  const sourceMatch = documents.find((document) => {
    const sourcePath = normalizeLocalPath(document.sourceUrl ?? '')
    if (!sourcePath) return false
    const sourceFileName = sourcePath.split('/').filter(Boolean).at(-1) ?? sourcePath
    return path === sourcePath || fileName.toLocaleLowerCase() === sourceFileName.toLocaleLowerCase()
  })
  if (sourceMatch) return { documentId: sourceMatch.id }

  const titleMatch = documents.find(
    (document) => normalizeLookupValue(document.title) === stem,
  )
  return titleMatch ? { documentId: titleMatch.id } : null
}

function normalizeLocalPath(value: string): string {
  const withoutFragment = value.trim().replace(/^<|>$/g, '').split(/[?#]/, 1)[0]
  let decoded = withoutFragment
  try {
    decoded = decodeURIComponent(withoutFragment)
  } catch {
    // Keep malformed legacy paths usable for best-effort filename matching.
  }
  return decoded
    .replace(/^file:\/\/(?:localhost)?\/?/i, '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .toLocaleLowerCase()
}

function normalizeLookupValue(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase()
}
