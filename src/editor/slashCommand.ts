import { Extension, type Editor, type Range } from '@tiptap/vue-3'
import { PluginKey } from '@tiptap/pm/state'
import {
  Suggestion,
  exitSuggestion,
  type SuggestionKeyDownProps,
  type SuggestionProps,
} from '@tiptap/suggestion'

import { SLASH_COMMAND_BLOCK_TYPES } from './blockTypeRegistry'

export interface SlashCommandContext {
  editor: Editor
  range: Range
}

export interface SlashCommandItem {
  id: string
  icon: string
  title: string
  aliases: string[]
  description: string
  command: (context: SlashCommandContext) => void
}

export const SlashCommandPluginKey = new PluginKey('slash-command')

export const SLASH_COMMAND_ITEMS: SlashCommandItem[] = SLASH_COMMAND_BLOCK_TYPES.map(
  (blockType) => ({
    id: blockType.id,
    icon: blockType.slashIcon,
    title: blockType.title,
    aliases: blockType.aliases,
    description: blockType.description,
    command: (context) => blockType.slashCommand(context),
  }),
)

export function filterSlashCommandItems(query: string): SlashCommandItem[] {
  const normalizedQuery = query.trim().toLowerCase()

  if (!normalizedQuery) {
    return SLASH_COMMAND_ITEMS
  }

  return SLASH_COMMAND_ITEMS.filter((item) => {
    const searchable = [item.title, item.description, ...item.aliases].join(' ').toLowerCase()
    return searchable.includes(normalizedQuery)
  })
}

export const SlashCommand = Extension.create({
  name: 'slashCommand',

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashCommandItem, SlashCommandItem>({
        editor: this.editor,
        pluginKey: SlashCommandPluginKey,
        char: '/',
        startOfLine: false,
        allowSpaces: false,
        allowedPrefixes: null,
        decorationClass: 'slash-command__query',
        items: ({ query }) => filterSlashCommandItems(query),
        command: ({ editor, range, props }) => {
          props.command({ editor, range })
          editor.commands.focus()
        },
        render: () => createSlashCommandRenderer(),
      }),
    ]
  },
})

function createSlashCommandRenderer() {
  let element: HTMLElement | null = null
  let unmount: (() => void) | null = null
  let selectedIndex = 0
  let latestProps: SuggestionProps<SlashCommandItem, SlashCommandItem> | null = null

  function selectItem(index: number): boolean {
    if (!latestProps) {
      return false
    }

    const item = latestProps.items[index]
    if (!item) {
      return false
    }

    latestProps.command(item)
    return true
  }

  function renderItems(props: SuggestionProps<SlashCommandItem, SlashCommandItem>): void {
    latestProps = props
    selectedIndex = Math.min(selectedIndex, Math.max(props.items.length - 1, 0))

    if (!element) {
      return
    }

    element.replaceChildren()

    const list = document.createElement('div')
    list.className = 'slash-command'
    list.setAttribute('role', 'listbox')

    if (props.items.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'slash-command__empty'
      empty.textContent = '无匹配命令'
      list.append(empty)
      element.append(list)
      return
    }

    props.items.forEach((item, index) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className =
        index === selectedIndex
          ? 'slash-command__item slash-command__item--selected'
          : 'slash-command__item'
      button.setAttribute('role', 'option')
      button.setAttribute('aria-selected', index === selectedIndex ? 'true' : 'false')

      const icon = document.createElement('span')
      icon.className = 'slash-command__icon'
      icon.textContent = item.icon

      const title = document.createElement('span')
      title.className = 'slash-command__title'
      title.textContent = item.title

      const description = document.createElement('span')
      description.className = 'slash-command__description'
      description.textContent = item.description

      const content = document.createElement('span')
      content.className = 'slash-command__content'
      content.append(title, description)

      button.append(icon, content)
      button.addEventListener('mousedown', (event) => {
        event.preventDefault()
        selectedIndex = index
        selectItem(index)
      })

      list.append(button)
    })

    element.append(list)
  }

  return {
    onStart: (props: SuggestionProps<SlashCommandItem, SlashCommandItem>) => {
      element = document.createElement('div')
      element.className = 'slash-command-host'
      selectedIndex = 0
      renderItems(props)
      unmount = props.mount(element)
    },
    onUpdate: (props: SuggestionProps<SlashCommandItem, SlashCommandItem>) => {
      renderItems(props)
    },
    onKeyDown: ({ event, view }: SuggestionKeyDownProps) => {
      if (!latestProps) {
        return false
      }

      if (event.key === 'ArrowDown') {
        selectedIndex = (selectedIndex + 1) % Math.max(latestProps.items.length, 1)
        renderItems(latestProps)
        return true
      }

      if (event.key === 'ArrowUp') {
        selectedIndex =
          (selectedIndex + Math.max(latestProps.items.length, 1) - 1) %
          Math.max(latestProps.items.length, 1)
        renderItems(latestProps)
        return true
      }

      if (event.key === 'Enter') {
        return selectItem(selectedIndex)
      }

      if (event.key === 'Escape') {
        exitSuggestion(view, SlashCommandPluginKey)
        return true
      }

      return false
    },
    onExit: () => {
      unmount?.()
      element = null
      unmount = null
      latestProps = null
      selectedIndex = 0
    },
  }
}
