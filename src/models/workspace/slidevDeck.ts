import { parseSync, stringify } from '@slidev/parser'
import { stringify as stringifyYaml } from 'yaml'

export const SLIDEV_CANVAS_WIDTH = 980
export const SLIDEV_CANVAS_HEIGHT = 551.25
export const SLIDEV_MAX_SOURCE_LENGTH = 1_000_000

export interface SlidevTextBoxPosition {
  left: number
  top: number
  width: number
  height: number
  rotate: number
}

export interface SlidevTextBox {
  id: string
  markdown: string
  position: SlidevTextBoxPosition
}

export interface SlidevDeckPage {
  id: string
  index: number
  title: string
  body: string
  notes: string
  layout: string
  textBoxes: SlidevTextBox[]
  hasAdvancedContent: boolean
}

export interface LegacySlidePage {
  id?: string
  templateId?: string
  slots?: Record<string, string | string[]>
  background?: string
}

const TEXT_BOX_PATTERN = /<v-drag\b[^>]*\bpos=(['"])([^'"]+)\1[^>]*>([\s\S]*?)<\/v-drag>/gi
const DECK_FRONTMATTER_KEYS = [
  'theme',
  'title',
  'transition',
  'canvasWidth',
  'aspectRatio',
  'colorSchema',
  'fonts',
  'drawings',
  'presenter',
  'record',
  'exportFilename',
  'download',
] as const

export function createDefaultSlidevSource(
  createId: (prefix: string) => string,
  title = '新幻灯片',
): string {
  const id = createId('slide')
  return buildSlideRaw(
    {
      theme: 'default',
      title,
      transition: 'slide-left',
      canvasWidth: SLIDEV_CANVAS_WIDTH,
      aspectRatio: '16/9',
      layout: 'default',
      nbId: id,
    },
    `# ${title}\n\n双击标题或正文开始编辑。`,
    '',
    true,
  )
}

export function convertLegacySlidesToSlidev(
  pages: LegacySlidePage[],
  createId: (prefix: string) => string,
): string {
  const normalized = pages.length ? pages : [{ id: createId('slide'), slots: { title: '新幻灯片' } }]
  return normalized
    .map((page, index) => {
      const title = slotText(page.slots?.title) || slotText(page.slots?.quote) || `幻灯片 ${index + 1}`
      const body = legacyBody(page)
      return buildSlideRaw(
        {
          ...(index === 0
            ? {
                theme: 'default',
                title,
                transition: 'slide-left',
                canvasWidth: SLIDEV_CANVAS_WIDTH,
                aspectRatio: '16/9',
              }
            : {}),
          layout: 'default',
          nbId: page.id || createId('slide'),
        },
        [`# ${title}`, body].filter(Boolean).join('\n\n'),
        '',
        index === 0,
      )
    })
    .join('\n\n')
}

export function parseSlidevDeck(source: string): SlidevDeckPage[] {
  const parsed = parseSync(source, 'slides.md')
  return parsed.slides.map((slide, index) => {
    const frontmatter = asRecord(slide.frontmatter)
    const decomposed = decomposeSlideContent(slide.content)
    const dragPositions = asRecord(frontmatter.dragPos)
    const textBoxes = decomposed.boxes.map(({ id, markdown }) => ({
      id,
      markdown,
      position: parseDragPosition(dragPositions[id]),
    }))
    return {
      id: typeof frontmatter.nbId === 'string' && frontmatter.nbId.trim()
        ? frontmatter.nbId.trim()
        : `slide-${index + 1}`,
      index,
      title: decomposed.title || String(slide.title ?? `幻灯片 ${index + 1}`),
      body: decomposed.body,
      notes: slide.note ?? '',
      layout: typeof frontmatter.layout === 'string' ? frontmatter.layout : 'default',
      textBoxes,
      hasAdvancedContent: detectAdvancedContent(decomposed.body),
    }
  })
}

export function validateSlidevSource(source: string): string | null {
  if (!source.trim()) return 'Slidev 源码不能为空。'
  if (source.length > SLIDEV_MAX_SOURCE_LENGTH) return 'Slidev 源码不能超过 1000000 个字符。'
  try {
    const pages = parseSlidevDeck(source)
    if (!pages.length) return '幻灯片至少需要一页。'
    if (pages.length > 200) return '幻灯片不能超过 200 页。'
    const explicitIds = parseSync(source, 'slides.md').slides
      .map((slide) => asRecord(slide.frontmatter).nbId)
      .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
    if (new Set(explicitIds).size !== explicitIds.length) return '幻灯片页面 nbId 重复。'
    return null
  } catch (error) {
    return error instanceof Error ? `Slidev 源码无效：${error.message}` : 'Slidev 源码无效。'
  }
}

export function updateSlidevPage(
  source: string,
  pageId: string,
  patch: Partial<Pick<SlidevDeckPage, 'title' | 'body' | 'notes' | 'layout' | 'textBoxes'>>,
): string {
  const parsed = parseSync(source, 'slides.md')
  const index = findSlideIndex(parsed.slides, pageId)
  if (index < 0) throw new Error('幻灯片页面不存在。')
  const slide = parsed.slides[index]
  const current = parseSlidevDeck(source)[index]
  const next = { ...current, ...patch }
  const frontmatter = { ...asRecord(slide.frontmatter) }
  frontmatter.layout = next.layout || 'default'
  frontmatter.nbId = current.id
  const dragPos: Record<string, string> = {}
  for (const box of next.textBoxes) dragPos[box.id] = stringifyDragPosition(box.position)
  if (Object.keys(dragPos).length) frontmatter.dragPos = dragPos
  else delete frontmatter.dragPos
  slide.raw = buildSlideRaw(
    frontmatter,
    buildManagedContent(next.title, next.body, next.textBoxes),
    next.notes,
    index === 0,
  )
  return stringify(parsed)
}

export function insertSlidevPage(
  source: string,
  afterPageId: string | null,
  createId: (prefix: string) => string,
): { source: string; pageId: string } {
  const parsed = parseSync(source, 'slides.md')
  const pageId = createId('slide')
  const raw = buildSlideRaw(
    { layout: 'default', nbId: pageId },
    '# 新页面\n\n双击这里填写正文。',
    '',
    false,
  )
  const afterIndex = afterPageId ? findSlideIndex(parsed.slides, afterPageId) : parsed.slides.length - 1
  const slide = parseSync(raw, 'slide.md').slides[0]
  parsed.slides.splice(Math.max(0, afterIndex + 1), 0, slide)
  return { source: stringify(parsed), pageId }
}

export function duplicateSlidevPage(
  source: string,
  pageId: string,
  createId: (prefix: string) => string,
): { source: string; pageId: string } {
  const pages = parseSlidevDeck(source)
  const page = pages.find((candidate) => candidate.id === pageId)
  if (!page) throw new Error('幻灯片页面不存在。')
  const inserted = insertSlidevPage(source, pageId, createId)
  const boxes = page.textBoxes.map((box) => ({ ...box, id: createId('textbox') }))
  return {
    pageId: inserted.pageId,
    source: updateSlidevPage(inserted.source, inserted.pageId, {
      title: `${page.title} 副本`,
      body: page.body,
      notes: page.notes,
      layout: page.layout,
      textBoxes: boxes,
    }),
  }
}

export function removeSlidevPage(source: string, pageId: string): string {
  const parsed = parseSync(source, 'slides.md')
  if (parsed.slides.length <= 1) throw new Error('幻灯片至少需要一页。')
  const index = findSlideIndex(parsed.slides, pageId)
  if (index < 0) throw new Error('幻灯片页面不存在。')
  const deckFrontmatter = takeDeckFrontmatter(parsed.slides[0].frontmatter)
  parsed.slides.splice(index, 1)
  return rebuildAfterOrderChange(parsed, deckFrontmatter)
}

export function moveSlidevPage(source: string, pageId: string, offset: -1 | 1): string {
  const parsed = parseSync(source, 'slides.md')
  const index = findSlideIndex(parsed.slides, pageId)
  const target = index + offset
  if (index < 0 || target < 0 || target >= parsed.slides.length) return source
  const deckFrontmatter = takeDeckFrontmatter(parsed.slides[0].frontmatter)
  const [slide] = parsed.slides.splice(index, 1)
  parsed.slides.splice(target, 0, slide)
  return rebuildAfterOrderChange(parsed, deckFrontmatter)
}

export function addSlidevTextBox(
  source: string,
  pageId: string,
  createId: (prefix: string) => string,
): { source: string; textBoxId: string } {
  const page = parseSlidevDeck(source).find((candidate) => candidate.id === pageId)
  if (!page) throw new Error('幻灯片页面不存在。')
  const textBoxId = createId('textbox')
  const textBoxes = [
    ...page.textBoxes,
    {
      id: textBoxId,
      markdown: '双击编辑文本框',
      position: { left: 560, top: 110, width: 300, height: 96, rotate: 0 },
    },
  ]
  return { source: updateSlidevPage(source, pageId, { textBoxes }), textBoxId }
}

function rebuildAfterOrderChange(
  parsed: ReturnType<typeof parseSync>,
  deckFrontmatter: Record<string, unknown>,
): string {
  parsed.slides.forEach((slide, index) => {
    const frontmatter = { ...asRecord(slide.frontmatter) }
    for (const key of DECK_FRONTMATTER_KEYS) delete frontmatter[key]
    if (index === 0) Object.assign(frontmatter, deckFrontmatter)
    slide.raw = buildSlideRaw(frontmatter, slide.content, slide.note ?? '', index === 0)
  })
  return stringify(parsed)
}

function buildManagedContent(title: string, body: string, textBoxes: SlidevTextBox[]): string {
  const boxes = textBoxes.map(
    (box) => `<v-drag pos="${escapeAttribute(box.id)}">\n${box.markdown.trim()}\n</v-drag>`,
  )
  return [`# ${title.trim() || '未命名页面'}`, body.trim(), ...boxes]
    .filter(Boolean)
    .join('\n\n')
}

function buildSlideRaw(
  frontmatter: Record<string, unknown>,
  content: string,
  notes: string,
  first: boolean,
): string {
  const yaml = stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd()
  const matter = yaml ? `---\n${yaml}\n---\n\n` : first ? '' : '---\n\n'
  const note = notes.trim() ? `\n\n<!--\n${notes.trim()}\n-->` : ''
  return `${matter}${content.trim()}${note}`
}

function decomposeSlideContent(content: string): {
  title: string
  body: string
  boxes: Array<{ id: string; markdown: string }>
} {
  const boxes: Array<{ id: string; markdown: string }> = []
  const withoutBoxes = content.replace(TEXT_BOX_PATTERN, (_, _quote, id: string, markdown: string) => {
    boxes.push({ id: id.trim(), markdown: markdown.trim() })
    return ''
  })
  const titleMatch = withoutBoxes.match(/^#\s+(.+)$/m)
  const title = titleMatch?.[1]?.trim() ?? ''
  const body = titleMatch
    ? `${withoutBoxes.slice(0, titleMatch.index)}${withoutBoxes.slice((titleMatch.index ?? 0) + titleMatch[0].length)}`.trim()
    : withoutBoxes.trim()
  return { title, body, boxes }
}

function parseDragPosition(value: unknown): SlidevTextBoxPosition {
  const parts = (Array.isArray(value) ? value : String(value ?? '').split(','))
    .map((part) => Number(String(part).trim()))
  return {
    left: finite(parts[0], 120),
    top: finite(parts[1], 120),
    width: Math.max(80, finite(parts[2], 300)),
    height: Math.max(48, finite(parts[3], 96)),
    rotate: finite(parts[4], 0),
  }
}

function stringifyDragPosition(position: SlidevTextBoxPosition): string {
  return [position.left, position.top, position.width, position.height, position.rotate]
    .map((value) => Math.round(value * 10) / 10)
    .join(',')
}

function findSlideIndex(slides: ReturnType<typeof parseSync>['slides'], pageId: string): number {
  return slides.findIndex((slide, index) => {
    const id = asRecord(slide.frontmatter).nbId
    return (typeof id === 'string' ? id : `slide-${index + 1}`) === pageId
  })
}

function takeDeckFrontmatter(value: unknown): Record<string, unknown> {
  const frontmatter = asRecord(value)
  return Object.fromEntries(
    DECK_FRONTMATTER_KEYS.filter((key) => key in frontmatter).map((key) => [key, frontmatter[key]]),
  )
}

function legacyBody(page: LegacySlidePage): string {
  const slots = page.slots ?? {}
  if (page.templateId === 'quote') return slotText(slots.source) ? `> ${slotText(slots.quote)}\n\n— ${slotText(slots.source)}` : `> ${slotText(slots.quote)}`
  if (page.templateId === 'big-number') return [`## ${slotText(slots.number)}`, slotText(slots.caption)].filter(Boolean).join('\n\n')
  if (page.templateId === 'two-column') return [`## ${slotText(slots.left)}`, `## ${slotText(slots.right)}`].filter((value) => value !== '## ').join('\n\n')
  const body = slots.body
  if (Array.isArray(body)) return body.map((item) => `- ${item}`).join('\n')
  return [slotText(slots.subtitle), slotText(body)].filter(Boolean).join('\n\n')
}

function slotText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join('\n') : value?.trim() ?? ''
}

function detectAdvancedContent(body: string): boolean {
  const withoutCommon = body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<\/?(?:strong|em|code|br)\b[^>]*>/gi, '')
  return /<\/?[A-Za-z][^>]*>|<style\b|\bv-click\b|\{monaco/i.test(withoutCommon)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function finite(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Number(value) : fallback
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
}
