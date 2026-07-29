import type { Editor } from '@tiptap/vue-3'

interface EditorBubbleMenuVisibility {
  editor: Editor
  from: number
  to: number
  readonly: boolean
  keepOpen?: boolean
}

export function shouldShowEditorBubbleMenu({
  editor,
  from,
  to,
  readonly,
  keepOpen = false,
}: EditorBubbleMenuVisibility): boolean {
  if (
    readonly ||
    !editor.isEditable ||
    editor.isActive('codeBlock') ||
    isPositionInsideNode(editor, from, 'codeBlock') ||
    isPositionInsideNode(editor, Math.max(from, to - 1), 'codeBlock')
  ) {
    return false
  }
  return keepOpen || from !== to
}

function isPositionInsideNode(editor: Editor, position: number, nodeName: string): boolean {
  const doc = editor.state.doc
  const resolvedPosition = doc.resolve(Math.max(0, Math.min(position, doc.content.size)))
  for (let depth = resolvedPosition.depth; depth >= 0; depth -= 1) {
    if (resolvedPosition.node(depth).type.name === nodeName) return true
  }
  return false
}
