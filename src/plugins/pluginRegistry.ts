import { gitVersioningPlugin } from './versioning/gitVersioningPlugin'

export type PluginCapability =
  | 'document:read'
  | 'document:write'
  | 'document:export'
  | 'repository:read'
  | 'repository:write'

export interface NotebookPluginCommand {
  id: string
  title: string
  description: string
}

export interface NotebookPlugin {
  id: string
  name: string
  version: string
  description: string
  capabilities: PluginCapability[]
  commands: NotebookPluginCommand[]
}

const BUILTIN_PLUGINS: NotebookPlugin[] = [gitVersioningPlugin]

export function listBuiltinPlugins(): NotebookPlugin[] {
  return BUILTIN_PLUGINS.map((plugin) => ({ ...plugin, commands: [...plugin.commands] }))
}

export function findBuiltinPlugin(pluginId: string): NotebookPlugin | null {
  return listBuiltinPlugins().find((plugin) => plugin.id === pluginId) ?? null
}
