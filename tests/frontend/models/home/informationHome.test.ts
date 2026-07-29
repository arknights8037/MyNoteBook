import { describe, expect, it } from 'vitest'

import {
  createDefaultInformationHomePayload,
  normalizeInformationHomePayload,
  validateInformationHomePayload,
} from '@/models/home/informationHome'

describe('informationHome model', () => {
  let id = 0
  const createId = (prefix: string) => `${prefix}-${++id}`

  it('creates an independent default grid with email, RSS and Agent modules', () => {
    const payload = createDefaultInformationHomePayload(createId)

    expect(payload.widgets.map((widget) => widget.widgetType)).toEqual([
      'email-actions',
      'rss-news',
      'agent-summary',
    ])
    expect(validateInformationHomePayload(payload)).toBeNull()
  })

  it('drops unknown modules while normalizing persisted payloads', () => {
    const payload = normalizeInformationHomePayload(
      {
        layoutVersion: 1,
        widgets: [
          {
            id: 'email-1',
            widgetType: 'email-actions',
            query: { limit: 6 },
            settings: {},
            layout: { desktop: { x: 0, y: 0, w: 6, h: 4 } },
          },
          { id: 'unknown', widgetType: 'weather' },
        ],
      },
      createId,
    )

    expect(payload.widgets).toHaveLength(1)
    expect(payload.widgets[0]).toMatchObject({ id: 'email-1', query: { limit: 6 } })
  })

  it('normalizes local todo and calendar card data', () => {
    const payload = normalizeInformationHomePayload(
      {
        layoutVersion: 1,
        widgets: [
          {
            id: 'todo-1',
            widgetType: 'todo-list',
            query: { limit: 8 },
            settings: {
              todos: [
                { id: 'item-1', title: ' 处理邮件 ', completed: true, createdAt: 10 },
                { id: '', title: 'invalid' },
              ],
            },
            layout: { desktop: { x: 0, y: 0, w: 5, h: 5 } },
          },
          {
            id: 'calendar-1',
            widgetType: 'calendar',
            query: { limit: 8 },
            settings: {
              events: [
                { id: 'event-1', title: ' 周会 ', date: '2026-07-30' },
                { id: 'event-2', title: 'invalid', date: 'tomorrow' },
              ],
            },
            layout: { desktop: { x: 5, y: 0, w: 7, h: 6 } },
          },
        ],
      },
      createId,
    )

    expect(payload.widgets[0]?.settings.todos).toEqual([
      { id: 'item-1', title: '处理邮件', completed: true, createdAt: 10 },
    ])
    expect(payload.widgets[1]?.settings.events).toEqual([
      { id: 'event-1', title: '周会', date: '2026-07-30' },
    ])
    expect(validateInformationHomePayload(payload)).toBeNull()
  })
})
