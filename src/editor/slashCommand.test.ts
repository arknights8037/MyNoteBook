import { describe, expect, it } from 'vitest'

import { filterSlashCommandItems, SLASH_COMMAND_ITEMS } from './slashCommand'

describe('slashCommand', () => {
  it('returns all commands for an empty query', () => {
    expect(filterSlashCommandItems('').map((item) => item.id)).toEqual(
      SLASH_COMMAND_ITEMS.map((item) => item.id),
    )
  })

  it('filters commands by Chinese keywords', () => {
    expect(filterSlashCommandItems('标题').map((item) => item.id)).toEqual([
      'heading-1',
      'heading-2',
      'heading-3',
      'heading-4',
      'collapsible-heading-1',
      'collapsible-heading-2',
      'collapsible-heading-3',
      'collapsible-heading-4',
    ])
    expect(filterSlashCommandItems('代码').map((item) => item.id)).toEqual(['code-block'])
    expect(filterSlashCommandItems('图片').map((item) => item.id)).toEqual(['image'])
    expect(filterSlashCommandItems('表格').map((item) => item.id)).toEqual(['table'])
    expect(filterSlashCommandItems('公式').map((item) => item.id)).toEqual(['math-block'])
    expect(filterSlashCommandItems('代办').map((item) => item.id)).toEqual(['task-list'])
    expect(filterSlashCommandItems('折叠标题').map((item) => item.id)).toEqual([
      'collapsible-heading-1',
      'collapsible-heading-2',
      'collapsible-heading-3',
      'collapsible-heading-4',
    ])
    expect(filterSlashCommandItems('折叠列表').map((item) => item.id)).toEqual(['collapsible-list'])
  })

  it('filters commands by latin aliases', () => {
    expect(filterSlashCommandItems('hr').map((item) => item.id)).toEqual(['horizontal-rule'])
    expect(filterSlashCommandItems('quote').map((item) => item.id)).toEqual(['blockquote'])
    expect(filterSlashCommandItems('latex').map((item) => item.id)).toEqual(['math-block'])
    expect(filterSlashCommandItems('todo').map((item) => item.id)).toEqual(['task-list'])
  })
})
