import { describe, expect, it } from 'vitest'

import { useWorkspaceSurface } from './useWorkspaceSurface'

describe('useWorkspaceSurface', () => {
  it('starts on Agent Work and switches between primary surfaces', () => {
    const surface = useWorkspaceSurface()

    expect(surface.activeSurface.value).toBe('agent')
    surface.openPluginSkillsSurface()
    expect(surface.activeSurface.value).toBe('plugins')
    surface.openSettingsSurface()
    expect(surface.activeSurface.value).toBe('settings')
    surface.openDocumentSurface()
    expect(surface.activeSurface.value).toBe('document')
  })

  it('keeps workspace AI mutually exclusive with settings and plugins', () => {
    const surface = useWorkspaceSurface()
    surface.openSettingsSurface()
    surface.setAiChatWorkspace(true)

    expect(surface.activeSurface.value).toBe('agent')
    expect(surface.showSettings.value).toBe(false)
    expect(surface.showPluginSkills.value).toBe(false)
  })
})
