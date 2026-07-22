import type { MindElixirData, NodeObj } from 'mind-elixir'

import {
  MIND_MAP_SCHEMA_VERSION,
  groupChildren,
  type MindMapContent,
  type MindMapDirection,
  type MindMapLink,
  type MindMapNode,
  type MindMapSourceRef,
} from '@/models/workspace/mindMap'

interface MindElixirMetadata {
  sourceRefs?: MindMapSourceRef[]
  domain?: Record<string, unknown>
  relationType?: string
}

export function toMindElixirData(content: MindMapContent): MindElixirData {
  const children = groupChildren(content)
  const project = (node: MindMapNode): NodeObj<MindElixirMetadata> => ({
    id: node.id,
    topic: node.text,
    note: node.note || undefined,
    expanded: !node.collapsed,
    direction:
      node.branchDirection === 'left' ? 0 : node.branchDirection === 'right' ? 1 : undefined,
    style: node.style,
    metadata: { sourceRefs: node.sourceRefs, domain: node.metadata },
    children: (children.get(node.id) ?? []).map(project),
  })
  return {
    nodeData: project(content.nodes[content.rootNodeId]!),
    direction: directionToNumber(content.direction),
    arrows: content.links.map((link) => ({
      id: link.id,
      from: link.fromNodeId,
      to: link.toNodeId,
      label: link.label,
      metadata: { relationType: link.relationType },
    })),
  }
}

export function fromMindElixirData(data: MindElixirData): MindMapContent {
  const nodes: Record<string, MindMapNode> = {}
  const visit = (
    source: NodeObj<MindElixirMetadata>,
    parentId: string | null,
    order: number,
    inheritedDirection?: 'left' | 'right',
  ): void => {
    const metadata = isRecord(source.metadata) ? source.metadata : {}
    const branchDirection =
      source.direction === 0
        ? 'left'
        : source.direction === 1
          ? 'right'
          : inheritedDirection
    nodes[source.id] = {
      id: source.id,
      parentId,
      order,
      text: source.topic.trim() || '未命名节点',
      note: typeof source.note === 'string' ? source.note : '',
      collapsed: source.expanded === false,
      ...(parentId !== null && branchDirection ? { branchDirection } : {}),
      sourceRefs: Array.isArray(metadata.sourceRefs)
        ? metadata.sourceRefs.filter(isSourceRef)
        : [],
      metadata: isRecord(metadata.domain) ? metadata.domain : {},
      style: normalizeStyle(source.style),
    }
    for (const [childIndex, child] of (source.children ?? []).entries()) {
      visit(child as NodeObj<MindElixirMetadata>, source.id, childIndex, branchDirection)
    }
  }
  visit(data.nodeData as NodeObj<MindElixirMetadata>, null, 0)
  const links: MindMapLink[] = (data.arrows ?? []).map((arrow) => {
    const metadata = isRecord(arrow.metadata) ? arrow.metadata : {}
    return {
      id: arrow.id,
      fromNodeId: arrow.from,
      toNodeId: arrow.to,
      relationType:
        typeof metadata.relationType === 'string' ? metadata.relationType : 'relates_to',
      label: arrow.label ?? '',
    }
  })
  return {
    schemaVersion: MIND_MAP_SCHEMA_VERSION,
    rootNodeId: data.nodeData.id,
    direction: numberToDirection(data.direction),
    nodes,
    links,
  }
}

function directionToNumber(direction: MindMapDirection): 0 | 1 | 2 {
  return direction === 'left' ? 0 : direction === 'right' ? 1 : 2
}

function numberToDirection(direction: number | undefined): MindMapDirection {
  return direction === 0 ? 'left' : direction === 1 ? 'right' : 'both'
}

function normalizeStyle(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

function isSourceRef(value: unknown): value is MindMapSourceRef {
  if (!isRecord(value) || (value.type !== 'document_block' && value.type !== 'knowledge_object')) {
    return false
  }
  return Number.isInteger(value.revision) && Number(value.revision) >= 1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
