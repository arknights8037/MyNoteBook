export interface WorkspaceTreeItem {
  id: string
  parentId: string | null
}

export function collectWorkspaceTreeIds(
  items: Iterable<WorkspaceTreeItem>,
  rootId: string,
): Set<string> {
  const childrenByParent = new Map<string, string[]>()
  for (const item of items) {
    if (!item.parentId) continue
    const children = childrenByParent.get(item.parentId) ?? []
    children.push(item.id)
    childrenByParent.set(item.parentId, children)
  }

  const collected = new Set<string>([rootId])
  const pending = [rootId]
  while (pending.length) {
    const parentId = pending.pop()
    if (!parentId) continue
    for (const childId of childrenByParent.get(parentId) ?? []) {
      if (collected.has(childId)) continue
      collected.add(childId)
      pending.push(childId)
    }
  }
  return collected
}
