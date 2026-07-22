import { describe, expect, it } from 'vitest'

import { createEditorExtensions } from '@/editor/core/createEditorExtensions'

describe('createEditorExtensions', () => {
  it('creates the editor extension set', () => {
    const extensions = createEditorExtensions()

    expect(extensions.map((extension) => extension.name)).toEqual([
      'starterKit',
      'paragraph',
      'heading',
      'blockquote',
      'bulletList',
      'orderedList',
      'listItem',
      'listKeymap',
      'taskList',
      'taskItem',
      'horizontalRule',
      'codeBlock',
      'imageFigure',
      'attachmentBlock',
      'tableBlock',
      'mathBlock',
      'collapsibleBlock',
      'textStyle',
      'color',
      'highlight',
      'subscript',
      'superscript',
      'textAlign',
      'placeholder',
      'uniqueID',
      'blockControls',
      'slashCommand',
    ])
  })
})
