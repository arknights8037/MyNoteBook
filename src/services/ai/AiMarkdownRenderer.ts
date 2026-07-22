import { parseMarkdownDocument } from '@/editor/io/markdownImport'

export function renderAiMarkdown(markdown: string): string {
  if (!markdown.trim()) return emptyPreview()
  const parsed = parseMarkdownDocument(markdown, 'AI 回复')
  return parsed.content.content?.map(renderTiptapNode).join('') || emptyPreview()
}

function renderTiptapNode(node: Record<string, unknown>): string {
  const type = String(node.type ?? '')
  const content = Array.isArray(node.content) ? (node.content as Record<string, unknown>[]) : []
  const attrs = isRecord(node.attrs) ? node.attrs : {}
  if (type === 'text') return renderTextNode(node)
  if (type === 'paragraph') return `<p>${content.map(renderTiptapNode).join('') || '&nbsp;'}</p>`
  if (type === 'heading') {
    const level = Math.max(1, Math.min(Number(attrs.level) || 2, 4))
    return `<h${level}>${content.map(renderTiptapNode).join('')}</h${level}>`
  }
  if (type === 'blockquote') return `<blockquote>${content.map(renderTiptapNode).join('')}</blockquote>`
  if (type === 'bulletList' || type === 'orderedList') {
    const tag = type === 'orderedList' ? 'ol' : 'ul'
    return `<${tag}>${content.map(renderTiptapNode).join('')}</${tag}>`
  }
  if (type === 'listItem') return `<li>${content.map(renderTiptapNode).join('')}</li>`
  if (type === 'codeBlock') return `<pre><code>${escapeHtml(getPlainNodeText(node))}</code></pre>`
  if (type === 'mathBlock') {
    return `<pre class="markdown-preview__math"><code>${escapeHtml(String(attrs.latex ?? ''))}</code></pre>`
  }
  if (type === 'horizontalRule') return '<hr>'
  if (type === 'tableBlock') {
    return renderTableRows(Array.isArray(attrs.rows) ? (attrs.rows as unknown[][]) : [])
  }
  return content.map(renderTiptapNode).join('')
}

function renderTextNode(node: Record<string, unknown>): string {
  let html = escapeHtml(String(node.text ?? ''))
  const marks = Array.isArray(node.marks) ? (node.marks as Record<string, unknown>[]) : []
  for (const mark of marks) {
    const type = String(mark.type ?? '')
    const attrs = isRecord(mark.attrs) ? mark.attrs : {}
    if (type === 'bold') html = `<strong>${html}</strong>`
    if (type === 'italic') html = `<em>${html}</em>`
    if (type === 'code') html = `<code>${html}</code>`
    if (type === 'link') {
      const href = sanitizeHref(String(attrs.href ?? ''))
      html = href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${html}</a>`
        : html
    }
  }
  return html
}

function renderTableRows(rows: unknown[][]): string {
  if (rows.length === 0) return ''
  const [head, ...body] = rows
  const header = `<thead><tr>${head.map((cell) => `<th>${escapeHtml(String(cell ?? ''))}</th>`).join('')}</tr></thead>`
  const bodyRows = body
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(String(cell ?? ''))}</td>`).join('')}</tr>`)
    .join('')
  return `<table>${header}<tbody>${bodyRows}</tbody></table>`
}

function getPlainNodeText(node: Record<string, unknown>): string {
  if (typeof node.text === 'string') return node.text
  const content = Array.isArray(node.content) ? (node.content as Record<string, unknown>[]) : []
  return content.map(getPlainNodeText).join('')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function sanitizeHref(href: string): string {
  const trimmed = href.trim()
  return /^(https?:|mailto:|#)/i.test(trimmed) ? trimmed : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function emptyPreview(): string {
  return '<p class="markdown-preview__empty">等待输出...</p>'
}
