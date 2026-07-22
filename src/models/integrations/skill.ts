export interface SkillFileEntry {
  path: string
  name: string
  kind: 'file' | 'directory'
  sizeBytes: number
  editable: boolean
}

export interface InstalledSkill {
  id: string
  name: string
  description: string
  version: string | null
  path: string
  enabled: boolean
  valid: boolean
  validationError: string | null
  modifiedAt: number
  files: SkillFileEntry[]
}

export interface EnabledSkillPrompt {
  catalog: string
  instructions: string
  skills?: Array<{ id: string; version: string | null }>
}
