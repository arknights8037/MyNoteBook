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
})
