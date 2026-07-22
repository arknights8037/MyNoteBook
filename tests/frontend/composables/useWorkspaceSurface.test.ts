import { describe, expect, it } from 'vitest'

import { useWorkspaceSurface } from '@/composables/useWorkspaceSurface'

describe('useWorkspaceSurface', () => {
  it('starts on Agent Work and switches between primary surfaces', () => {
    const surface = useWorkspaceSurface()

    expect(surface.activeSurface.value).toBe('agent')
    surface.openPluginSkillsSurface()
    expect(surface.activeSurface.value).toBe('plugins')
    surface.openAutomationsSurface()
    expect(surface.activeSurface.value).toBe('automations')
    surface.openAuditSurface()
    expect(surface.activeSurface.value).toBe('audit')
    surface.openKnowledgeControlSurface()
    expect(surface.activeSurface.value).toBe('knowledge')
    surface.openSettingsSurface()
    expect(surface.activeSurface.value).toBe('settings')
    surface.openDocumentSurface()
    expect(surface.activeSurface.value).toBe('document')
  })

  it('keeps workspace AI mutually exclusive with secondary surfaces', () => {
    const surface = useWorkspaceSurface()
    surface.openAuditSurface()
    surface.setAiChatWorkspace(true)

    expect(surface.activeSurface.value).toBe('agent')
    expect(surface.showSettings.value).toBe(false)
    expect(surface.showPluginSkills.value).toBe(false)
    expect(surface.showAutomations.value).toBe(false)
    expect(surface.showAudit.value).toBe(false)
    expect(surface.showKnowledgeControl.value).toBe(false)
  })

  it('switches from settings to audit without retaining the previous surface', () => {
    const surface = useWorkspaceSurface()
    surface.openSettingsSurface()
    surface.openAuditSurface()

    expect(surface.activeSurface.value).toBe('audit')
    expect(surface.showSettings.value).toBe(false)
    expect(surface.showAudit.value).toBe(true)
  })
})
