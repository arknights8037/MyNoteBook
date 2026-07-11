export type DocumentImportFormat = 'json' | 'markdown'
export type DocumentExportFormat = 'markdown' | 'html'

export function inferDocumentImportFormat(fileName: string): DocumentImportFormat | null {
  if (/\.json$/i.test(fileName)) return 'json'
  if (/\.(md|markdown)$/i.test(fileName)) return 'markdown'
  return null
}

export function createExportFileName(
  title: string,
  extension: string,
  fallbackTitle = '未命名文档',
): string {
  const baseName =
    title
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, ' ')
      .slice(0, 80) || fallbackTitle

  return `${baseName}.${extension}`
}
