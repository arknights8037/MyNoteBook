import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')

interface ScopedPermission {
  identifier: string
  allow?: Array<string | { path?: string; url?: string }>
  deny?: Array<string | { path?: string; url?: string }>
}

describe('Desktop security configuration', () => {
  it('uses a non-null production CSP without WebView internet access', () => {
    const config = readJson('src-tauri/tauri.conf.json') as {
      app: { security: { csp: Record<string, string[]>; devCsp: Record<string, string[]> } }
    }
    const { csp, devCsp } = config.app.security

    expect(csp).toBeTruthy()
    expect(csp['default-src']).toEqual(["'self'"])
    expect(csp['connect-src']).toEqual(["'self'", 'ipc:', 'http://ipc.localhost'])
    expect(csp['script-src']).not.toContain("'unsafe-eval'")
    expect(csp['object-src']).toEqual(["'none'"])
    expect(csp['base-uri']).toEqual(["'none'"])
    expect(csp['frame-ancestors']).toEqual(["'none'"])

    const productionSources = Object.values(csp).flat()
    expect(productionSources).not.toContain('https:')
    expect(productionSources).not.toContain('http:')
    expect(productionSources).not.toContain('https://*')
    expect(productionSources).not.toContain('http://*')

    expect(devCsp['connect-src']).toContain('ws://127.0.0.1:1420')
    expect(devCsp['connect-src']).not.toContain('ws://*')
  })

  it('grants only scoped fs and opener commands to the main WebView', () => {
    const capability = readJson('src-tauri/capabilities/default.json') as {
      permissions: Array<string | ScopedPermission>
    }
    const identifiers = capability.permissions.map((permission) =>
      typeof permission === 'string' ? permission : permission.identifier,
    )

    expect(identifiers).not.toContain('fs:default')
    expect(identifiers).not.toContain('opener:default')
    expect(identifiers).not.toContain('opener:allow-default-urls')
    expect(identifiers).not.toContain('opener:allow-reveal-item-in-dir')
    expect(identifiers.filter((value) => value.startsWith('opener:'))).toEqual([
      'opener:allow-open-url',
    ])
    expect(identifiers.filter((value) => value.startsWith('fs:'))).toEqual([
      'fs:allow-read-text-file',
      'fs:allow-write-text-file',
    ])
    expect(
      capability.permissions.filter(
        (permission) => typeof permission !== 'string' && permission.identifier.startsWith('fs:'),
      ),
    ).toEqual([])

    const openUrl = scopedPermission(capability.permissions, 'opener:allow-open-url')
    expect(openUrl.allow).toEqual([{ url: 'https://*' }, { url: 'http://*' }])
  })

  it('opens local assets and the Skills directory only through trusted Rust commands', () => {
    const assetService = readSource('src/infrastructure/assets/AssetService.ts')
    const skillsSurface = readSource(
      'src/features/integrations/skills/components/PluginSkillsSurface.vue',
    )
    const storage = readSource('src-tauri/src/storage.rs')
    const skills = readSource('src-tauri/src/skills.rs')

    expect(assetService).not.toContain('@tauri-apps/plugin-opener')
    expect(assetService).toContain("invoke('open_asset_file'")
    expect(skillsSurface).not.toContain('@tauri-apps/plugin-opener')
    expect(skillsSurface).toContain('openSkillsDirectory()')
    expect(storage).toContain('pub fn open_asset_file')
    expect(storage).toContain('resolve_relative_asset_path(&app, data_directory, &relative_path)')
    expect(storage).toContain('app.opener()')
    expect(skills).toContain('pub fn open_skills_directory')
    expect(skills).toContain('let root = skills_root(&app, input.data_directory)?')
    expect(skills).toContain('app.opener()')
  })

  it('grants text file access only after a native file dialog selection', () => {
    const documentTransfer = readSource(
      'src/infrastructure/transfer/tauriDocumentTransferFilePort.ts',
    )
    const cliSurface = readSource(
      'src/features/knowledge-control/components/KnowledgeControlSurface.vue',
    )
    const storage = readSource('src-tauri/src/storage.rs')
    const commands = readSource('src-tauri/src/lib.rs')

    expect(documentTransfer).toContain("from '@tauri-apps/plugin-dialog'")
    expect(documentTransfer).toContain("from '@tauri-apps/plugin-fs'")
    expect(documentTransfer).not.toContain("invoke('write_text_file'")
    expect(cliSurface).toContain("from '@tauri-apps/plugin-dialog'")
    expect(cliSurface).toContain('await save({')
    expect(cliSurface).toContain('await open({')
    expect(storage).not.toContain('pub fn write_text_file')
    expect(commands).not.toContain('storage::write_text_file')
  })

  it('does not grant a WebView HTTP client capability', () => {
    const capability = readJson('src-tauri/capabilities/default.json') as {
      permissions: Array<string | ScopedPermission>
    }
    const identifiers = capability.permissions.map((permission) =>
      typeof permission === 'string' ? permission : permission.identifier,
    )

    expect(identifiers.some((identifier) => identifier.startsWith('http:'))).toBe(false)
  })

  it('does not expose the SQLite plugin to the WebView', () => {
    const capability = readJson('src-tauri/capabilities/default.json') as {
      permissions: Array<string | ScopedPermission>
    }
    const identifiers = capability.permissions.map((permission) =>
      typeof permission === 'string' ? permission : permission.identifier,
    )

    expect(identifiers.filter((identifier) => identifier.startsWith('sql:'))).toEqual([])
    expect(readSource('package.json')).not.toContain('@tauri-apps/plugin-sql')
    expect(readSource('src-tauri/Cargo.toml')).not.toContain('tauri-plugin-sql')
    expect(readSource('src-tauri/src/lib.rs')).not.toContain('tauri_plugin_sql')
  })
})

function scopedPermission(
  permissions: Array<string | ScopedPermission>,
  identifier: string,
): ScopedPermission {
  const permission = permissions.find(
    (candidate): candidate is ScopedPermission =>
      typeof candidate !== 'string' && candidate.identifier === identifier,
  )
  expect(permission, identifier).toBeTruthy()
  return permission!
}

function readJson(path: string): unknown {
  return JSON.parse(readSource(path))
}

function readSource(path: string): string {
  return readFileSync(resolve(root, path), 'utf8')
}
