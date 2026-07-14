import { invoke } from '@tauri-apps/api/core'

import { loadAppSettings } from '@/models/settings'
import type { EnabledSkillPrompt, InstalledSkill } from '@/models/skill'

function dataDirectory(): string | null {
  return loadAppSettings().dataDirectory
}

export async function listInstalledSkills(): Promise<InstalledSkill[]> {
  return invoke<InstalledSkill[]>('list_installed_skills', {
    input: { dataDirectory: dataDirectory() },
  })
}

export async function importSkillDirectory(sourcePath: string): Promise<InstalledSkill[]> {
  return invoke<InstalledSkill[]>('import_skill_directory', {
    input: { dataDirectory: dataDirectory(), sourcePath },
  })
}

export async function createSkill(
  name: string,
  description: string,
  enabled = true,
): Promise<InstalledSkill> {
  return invoke<InstalledSkill>('create_skill', {
    input: { dataDirectory: dataDirectory(), name, description, enabled },
  })
}

export async function setSkillEnabled(skillId: string, enabled: boolean): Promise<void> {
  await invoke('set_skill_enabled', {
    input: { dataDirectory: dataDirectory(), skillId, enabled },
  })
}

export async function readSkillFile(skillId: string, relativePath: string): Promise<string> {
  return invoke<string>('read_skill_file', {
    input: { dataDirectory: dataDirectory(), skillId, relativePath },
  })
}

export async function writeSkillFile(
  skillId: string,
  relativePath: string,
  content: string,
): Promise<void> {
  await invoke('write_skill_file', {
    input: { dataDirectory: dataDirectory(), skillId, relativePath, content },
  })
}

export async function removeInstalledSkill(skillId: string): Promise<void> {
  await invoke('remove_installed_skill', {
    input: { dataDirectory: dataDirectory(), skillId },
  })
}

export async function getSkillsDirectory(): Promise<string> {
  return invoke<string>('get_skills_directory', {
    input: { dataDirectory: dataDirectory() },
  })
}

export async function loadEnabledSkillPrompt(): Promise<EnabledSkillPrompt> {
  if (!Reflect.has(globalThis, '__TAURI_INTERNALS__')) return { catalog: '', instructions: '', skills: [] }
  const enabled = (await listInstalledSkills()).filter((skill) => skill.enabled && skill.valid)
  if (enabled.length === 0) return { catalog: '', instructions: '', skills: [] }

  const catalog = enabled
    .map((skill) => `- ${skill.id}: ${skill.description}（入口：SKILL.md；可按需读取其下属文件）`)
    .join('\n')
  return {
    catalog,
    instructions: '',
    skills: enabled.map((skill) => ({ id: skill.id, version: skill.version ?? null })),
  }
}
