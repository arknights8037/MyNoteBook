export const MIND_MAP_SCHEMA_VERSION = 1

export type MindMapDirection = 'left' | 'right' | 'both'
export type MindMapSourceType = 'document_block' | 'knowledge_object'

export interface MindMapSourceRef {
  type: MindMapSourceType
  documentId?: string
  blockId?: string
  knowledgeObjectId?: string
  revision: number
  quote?: string
}

export interface MindMapNode {
  id: string
  parentId: string | null
  order: number
  text: string
  note: string
  collapsed: boolean
  /** Side of the root branch. Descendants inherit their top-level branch side. */
  branchDirection?: 'left' | 'right'
  sourceRefs: MindMapSourceRef[]
  metadata: Record<string, unknown>
  style: Record<string, string>
}

export interface MindMapLink {
  id: string
  fromNodeId: string
  toNodeId: string
  relationType: string
  label: string
}

export interface MindMapContent {
  schemaVersion: 1
  rootNodeId: string
  direction: MindMapDirection
  nodes: Record<string, MindMapNode>
  links: MindMapLink[]
}

export interface MindMapDocument {
  id: string
  parentId: string | null
  sortOrder: number
  title: string
  content: MindMapContent
  version: number
  createdAt: number
  updatedAt: number
}

export interface MindMapSummary {
  id: string
  parentId: string | null
  sortOrder: number
  title: string
  rootNodeId: string
  nodeCount: number
  version: number
  createdAt: number
  updatedAt: number
}

export interface MindMapSubtreeQuery {
  nodeId?: string
  depth?: number
  maxNodes?: number
  includeNotes?: boolean
  includeSources?: boolean
}

export interface MindMapSubtreeNode {
  id: string
  text: string
  note?: string
  sourceRefs?: MindMapSourceRef[]
  children: MindMapSubtreeNode[]
}

export interface MindMapSubtreeResult {
  mindMapId: string
  title: string
  version: number
  root: MindMapSubtreeNode
  returnedNodes: number
  truncated: boolean
}

export function createEmptyMindMapContent(rootNodeId: string, title: string): MindMapContent {
  return {
    schemaVersion: MIND_MAP_SCHEMA_VERSION,
    rootNodeId,
    direction: 'both',
    nodes: {
      [rootNodeId]: {
        id: rootNodeId,
        parentId: null,
        order: 0,
        text: title.trim() || '中心主题',
        note: '',
        collapsed: false,
        sourceRefs: [],
        metadata: {},
        style: {},
      },
    },
    links: [],
  }
}

export function validateMindMapContent(content: MindMapContent): string | null {
  if (content.schemaVersion !== MIND_MAP_SCHEMA_VERSION) return '不支持的思维导图数据版本。'
  const nodes = Object.values(content.nodes)
  if (nodes.length === 0) return '思维导图至少需要一个节点。'
  if (nodes.length > 10_000) return '思维导图节点数不能超过 10000。'
  const root = content.nodes[content.rootNodeId]
  if (!root || root.parentId !== null) return '思维导图根节点无效。'
  if (!['left', 'right', 'both'].includes(content.direction)) return '思维导图方向无效。'

  for (const node of nodes) {
    if (node.id !== content.nodes[node.id]?.id) return '思维导图节点 ID 与索引不一致。'
    if (!node.text.trim()) return `节点 ${node.id} 的内容不能为空。`
    if (node.text.length > 2_000 || node.note.length > 20_000) return `节点 ${node.id} 的内容过长。`
    if (!Number.isInteger(node.order) || node.order < 0) return `节点 ${node.id} 的顺序无效。`
    if (node.parentId !== null && !content.nodes[node.parentId]) return `节点 ${node.id} 的父节点不存在。`
  }

  const visited = new Set<string>()
  const visiting = new Set<string>()
  const children = groupChildren(content)
  const visit = (nodeId: string, depth: number): string | null => {
    if (depth > 256) return '思维导图层级不能超过 256。'
    if (visiting.has(nodeId)) return '思维导图不能包含循环父子关系。'
    if (visited.has(nodeId)) return null
    visiting.add(nodeId)
    for (const child of children.get(nodeId) ?? []) {
      const error = visit(child.id, depth + 1)
      if (error) return error
    }
    visiting.delete(nodeId)
    visited.add(nodeId)
    return null
  }
  const treeError = visit(content.rootNodeId, 0)
  if (treeError) return treeError
  if (visited.size !== nodes.length) return '思维导图包含无法从根节点访问的节点。'

  const linkIds = new Set<string>()
  for (const link of content.links) {
    if (!link.id || linkIds.has(link.id)) return '思维导图连接 ID 不能为空或重复。'
    linkIds.add(link.id)
    if (!content.nodes[link.fromNodeId] || !content.nodes[link.toNodeId]) {
      return `连接 ${link.id} 引用了不存在的节点。`
    }
    if (link.fromNodeId === link.toNodeId) return `连接 ${link.id} 不能指向自身。`
  }
  return null
}

export function mindMapToDirectionalText(document: MindMapDocument): string {
  const lines = [
    'mindmap v1',
    `map: ${document.id}`,
    `title: ${document.title}`,
    `version: ${document.version}`,
    '',
  ]
  const children = groupChildren(document.content)
  const append = (node: MindMapNode, depth: number): void => {
    const prefix = depth === 0 ? '# ' : `${'  '.repeat(depth - 1)}-> `
    lines.push(`${prefix}[${node.id}] ${singleLine(node.text)}`)
    if (node.note.trim()) lines.push(`${'  '.repeat(depth + 1)}@note ${singleLine(node.note)}`)
    for (const source of node.sourceRefs) {
      const target =
        source.type === 'document_block'
          ? `document:${source.documentId ?? ''} block:${source.blockId ?? ''}`
          : `knowledge:${source.knowledgeObjectId ?? ''}`
      lines.push(`${'  '.repeat(depth + 1)}@source ${target} revision:${source.revision}`)
    }
    for (const child of children.get(node.id) ?? []) append(child, depth + 1)
  }
  append(document.content.nodes[document.content.rootNodeId]!, 0)
  if (document.content.links.length > 0) {
    lines.push('')
    for (const link of document.content.links) {
      lines.push(
        `@link ${link.fromNodeId} --${link.relationType || 'relates_to'}--> ${link.toNodeId}${link.label ? ` : ${singleLine(link.label)}` : ''}`,
      )
    }
  }
  return lines.join('\n')
}

export function readMindMapSubtree(
  document: MindMapDocument,
  query: MindMapSubtreeQuery = {},
): MindMapSubtreeResult {
  const nodeId = query.nodeId || document.content.rootNodeId
  const root = document.content.nodes[nodeId]
  if (!root) throw new Error(`节点 ${nodeId} 不存在。`)
  const maxDepth = clampInteger(query.depth, 3, 0, 32)
  const maxNodes = clampInteger(query.maxNodes, 100, 1, 1_000)
  const children = groupChildren(document.content)
  let returnedNodes = 0
  let truncated = false
  const project = (node: MindMapNode, depth: number): MindMapSubtreeNode => {
    returnedNodes += 1
    const result: MindMapSubtreeNode = {
      id: node.id,
      text: node.text,
      ...(query.includeNotes && node.note ? { note: node.note } : {}),
      ...(query.includeSources && node.sourceRefs.length ? { sourceRefs: node.sourceRefs } : {}),
      children: [],
    }
    const candidates = children.get(node.id) ?? []
    if (depth >= maxDepth) {
      if (candidates.length > 0) truncated = true
      return result
    }
    for (const child of candidates) {
      if (returnedNodes >= maxNodes) {
        truncated = true
        break
      }
      result.children.push(project(child, depth + 1))
    }
    return result
  }
  return {
    mindMapId: document.id,
    title: document.title,
    version: document.version,
    root: project(root, 0),
    returnedNodes,
    truncated,
  }
}

export function groupChildren(content: MindMapContent): Map<string, MindMapNode[]> {
  const result = new Map<string, MindMapNode[]>()
  for (const node of Object.values(content.nodes)) {
    if (node.parentId === null) continue
    const siblings = result.get(node.parentId) ?? []
    siblings.push(node)
    result.set(node.parentId, siblings)
  }
  for (const siblings of result.values()) {
    siblings.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
  }
  return result
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function clampInteger(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  const candidate = Number.isInteger(value) ? Number(value) : fallback
  return Math.max(minimum, Math.min(maximum, candidate))
}
