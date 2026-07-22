import { computed, ref, type Ref } from 'vue'

import type { DocumentId, DocumentRecord, DocumentSummary } from '@/models/documents/document'
import {
  buildSidebarDocumentForest,
  countSidebarDocumentNodes,
  type SidebarDocumentNode,
} from '@/models/documents/documentTree'
import { mergeDocumentRecord, removeDocumentSummaries } from '@/models/documents/documentListState'

export function useDocumentCollection() {
  const documents = ref<DocumentSummary[]>([])
  const deletedDocuments = ref<DocumentSummary[]>([])
  const selectedGroupId = ref<DocumentId | null>(null)
  const collapsedGroupIds = ref<Set<DocumentId>>(new Set())
  const collapsedDocumentIds = ref<Set<DocumentId>>(new Set())

  const articleGroups = computed(() =>
    documents.value.filter(
      (document) => document.documentKind === 'group' && document.parentId === null,
    ),
  )
  const documentForest = computed(() => buildSidebarDocumentForest(documents.value))
  const ungroupedArticleNodes = computed(() => documentForest.value.rootNodes)

  function replaceLists(active: DocumentSummary[], deleted: DocumentSummary[]): void {
    documents.value = active
    deletedDocuments.value = deleted
  }

  function mergeDocument(document: DocumentRecord): void {
    const next = mergeDocumentRecord(
      { active: documents.value, deleted: deletedDocuments.value },
      document,
    )
    documents.value = next.active
    deletedDocuments.value = next.deleted
  }

  function removeDocuments(documentIds: Iterable<DocumentId>): void {
    documents.value = removeDocumentSummaries(documents.value, documentIds)
    deletedDocuments.value = removeDocumentSummaries(deletedDocuments.value, documentIds)
  }

  function toggleGroup(groupId: DocumentId): void {
    selectedGroupId.value = groupId
    toggleSetValue(collapsedGroupIds, groupId)
  }

  function toggleDocument(documentId: DocumentId): void {
    toggleSetValue(collapsedDocumentIds, documentId)
  }

  function expandDocument(documentId: DocumentId): void {
    removeSetValue(collapsedDocumentIds, documentId)
  }

  function expandGroup(groupId: DocumentId): void {
    removeSetValue(collapsedGroupIds, groupId)
  }

  function isGroupCollapsed(groupId: DocumentId): boolean {
    return collapsedGroupIds.value.has(groupId)
  }

  function getGroupArticleNodes(groupId: DocumentId): SidebarDocumentNode[] {
    return documentForest.value.nodesByGroup.get(groupId) ?? []
  }

  function getGroupArticleCount(groupId: DocumentId): number {
    return countSidebarDocumentNodes(getGroupArticleNodes(groupId))
  }

  function isArticleDocument(documentId: DocumentId): boolean {
    return documents.value.some(
      (document) => document.id === documentId && document.documentKind === 'article',
    )
  }

  function revealDocument(documentId: DocumentId): void {
    const nextCollapsedDocumentIds = new Set(collapsedDocumentIds.value)
    const visited = new Set<DocumentId>()
    let document = documents.value.find((candidate) => candidate.id === documentId) ?? null
    let groupId: DocumentId | null = null

    while (document?.parentId && !visited.has(document.parentId)) {
      visited.add(document.parentId)
      const parentId: DocumentId = document.parentId
      const parent = documents.value.find((candidate) => candidate.id === parentId)
      if (!parent) break

      if (parent.documentKind === 'group') {
        groupId = parent.id
        break
      }

      nextCollapsedDocumentIds.delete(parent.id)
      document = parent
    }

    collapsedDocumentIds.value = nextCollapsedDocumentIds
    selectedGroupId.value = groupId
    if (groupId) expandGroup(groupId)
  }

  function getActiveGroupId(): DocumentId | null {
    const groupId = selectedGroupId.value
    if (!groupId) return null
    return documents.value.some(
      (document) => document.id === groupId && document.documentKind === 'group',
    )
      ? groupId
      : null
  }

  return {
    documents,
    deletedDocuments,
    selectedGroupId,
    collapsedGroupIds,
    collapsedDocumentIds,
    articleGroups,
    ungroupedArticleNodes,
    replaceLists,
    mergeDocument,
    removeDocuments,
    toggleGroup,
    toggleDocument,
    expandDocument,
    expandGroup,
    isGroupCollapsed,
    getGroupArticleNodes,
    getGroupArticleCount,
    isArticleDocument,
    revealDocument,
    getActiveGroupId,
  }
}

function toggleSetValue<T>(target: Ref<Set<T>>, value: T): void {
  const next = new Set(target.value)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  target.value = next
}

function removeSetValue<T>(target: Ref<Set<T>>, value: T): void {
  const next = new Set(target.value)
  next.delete(value)
  target.value = next
}
