import { beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_APP_SETTINGS,
  loadAppSettings,
  normalizeAppSettings,
  saveAppSettings,
  matchesShortcut,
  shortcutFromKeyboardEvent,
} from './settings'

describe('app settings', () => {
  beforeEach(() => globalThis.localStorage.clear())

  it('persists and restores editor settings', () => {
    const settings = {
      ...DEFAULT_APP_SETTINGS,
      autosaveDelay: 1500,
      spellcheck: false,
      contentWidth: 'wide' as const,
    }

    saveAppSettings(settings)

    expect(loadAppSettings()).toEqual(settings)
  })

  it('normalizes invalid stored values', () => {
    expect(normalizeAppSettings({ autosaveDelay: 9, fontSize: 'huge' as never })).toEqual(
      DEFAULT_APP_SETTINGS,
    )
  })

  it('migrates legacy theme modes to theme preferences', () => {
    expect(normalizeAppSettings({ theme: 'light' as never }).theme).toBe('paper-light')
    expect(normalizeAppSettings({ theme: 'dark' as never }).theme).toBe('graphite-dark')
  })

  it('normalizes custom font families and sensitive authorization settings', () => {
    const validHash = 'a'.repeat(64)
    expect(
      normalizeAppSettings({
        jumpAid: 'outline',
        jumpAidPosition: 'left',
        jumpAidMaxLevel: 2,
        chineseFontFamily: ' Microsoft YaHei , SimSun ',
        westernFontFamily: ' Inter , Arial ',
        sensitiveActionPasswordEnabled: true,
        sensitiveActionPasswordHash: validHash.toUpperCase(),
        allowDeveloperMode: true,
      }),
    ).toMatchObject({
      jumpAid: 'outline',
      jumpAidPosition: 'left',
      jumpAidMaxLevel: 2,
      chineseFontFamily: 'Microsoft YaHei, SimSun',
      westernFontFamily: 'Inter, Arial',
      sensitiveActionPasswordEnabled: true,
      sensitiveActionPasswordHash: validHash,
      allowDeveloperMode: true,
    })

    expect(
      normalizeAppSettings({
        sensitiveActionPasswordEnabled: true,
        sensitiveActionPasswordHash: 'not-a-hash',
      }).sensitiveActionPasswordEnabled,
    ).toBe(false)
    expect(normalizeAppSettings({ jumpAid: 'floating' as never }).jumpAid).toBe('off')
    expect(normalizeAppSettings({ jumpAidPosition: 'center' as never }).jumpAidPosition).toBe(
      'right',
    )
    expect(normalizeAppSettings({ jumpAidMaxLevel: 8 as never }).jumpAidMaxLevel).toBe(4)
    expect(normalizeAppSettings({ allowDeveloperMode: 'yes' as never }).allowDeveloperMode).toBe(
      false,
    )
  })

  it('normalizes and matches configurable shortcuts', () => {
    const event = { key: 'k', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }
    expect(shortcutFromKeyboardEvent(event)).toBe('Ctrl+Shift+K')
    expect(matchesShortcut(event, 'Ctrl+Shift+K')).toBe(true)
  })
})
