import { invoke } from '@tauri-apps/api/core'
import { openPath } from '@tauri-apps/plugin-opener'

import { getDatabase } from '@/infrastructure/database/connection'
import { loadAppSettings } from '@/models/settings'
import { ASSET_URL_PREFIX, createAssetUrl, parseAssetUrl, type AssetRecord } from '@/models/asset'
import type { DocumentId } from '@/models/document'

interface AssetRow extends Record<string, unknown> {
  id: string
  document_id: string | null
  relative_path: string
  original_name: string
  mime_type: string
  size_bytes: number
  content_hash?: string
  width: number | null
  height: number | null
  created_at: number
  updated_at?: number
}

interface StoreAssetDataUrlResult {
  relativePath: string
  originalName: string
  mimeType: string
  sizeBytes: number
  contentHash: string
}

export interface AssetService {
  storeFile(file: File, documentId?: DocumentId | null): Promise<AssetRecord>
  findAsset(assetId: string): Promise<AssetRecord | null>
  resolveAssetUrl(assetIdOrUrl: string): Promise<string>
  openAsset(assetIdOrUrl: string): Promise<void>
  deleteAsset(assetIdOrUrl: string): Promise<void>
}

export class TauriAssetService implements AssetService {
  async storeFile(file: File, documentId: DocumentId | null = null): Promise<AssetRecord> {
    const id = createAssetId()
    const dataUrl = await readFileAsDataUrl(file)
    const settings = loadAppSettings()
    const stored = await invoke<StoreAssetDataUrlResult>('store_asset_data_url', {
      dataDirectory: settings.dataDirectory,
      assetId: id,
      dataUrl,
      originalName: file.name || '附件',
    })
    const now = Date.now()
    const record: AssetRecord = {
      id,
      documentId,
      relativePath: stored.relativePath,
      originalName: stored.originalName,
      mimeType: stored.mimeType || file.type || 'application/octet-stream',
      sizeBytes: stored.sizeBytes,
      contentHash: stored.contentHash,
      width: null,
      height: null,
      createdAt: now,
      updatedAt: now,
    }

    const database = await getDatabase()
    try {
      await database.execute(
        `INSERT INTO assets (
        id,
        document_id,
        relative_path,
        original_name,
        mime_type,
        size_bytes,
        content_hash,
        width,
        height,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        document_id = excluded.document_id,
        relative_path = excluded.relative_path,
        original_name = excluded.original_name,
        mime_type = excluded.mime_type,
        size_bytes = excluded.size_bytes,
        content_hash = excluded.content_hash,
        width = excluded.width,
        height = excluded.height,
        updated_at = excluded.updated_at`,
        [
          record.id,
          record.documentId,
          record.relativePath,
          record.originalName,
          record.mimeType,
          record.sizeBytes,
          record.contentHash,
          record.width,
          record.height,
          record.createdAt,
          record.updatedAt,
        ],
      )
    } catch (error) {
      await invoke('remove_asset_file', {
        dataDirectory: settings.dataDirectory,
        relativePath: stored.relativePath,
      }).catch(() => undefined)
      throw error
    }

    return record
  }

  async findAsset(assetIdOrUrl: string): Promise<AssetRecord | null> {
    const id = parseAssetUrl(assetIdOrUrl) ?? assetIdOrUrl.replace(ASSET_URL_PREFIX, '')
    if (!id) return null

    const database = await getDatabase()
    const rows = await database.select<AssetRow>('SELECT * FROM assets WHERE id = ? LIMIT 1', [id])
    return rows[0] ? mapAssetRow(rows[0]) : null
  }

  async resolveAssetUrl(assetIdOrUrl: string): Promise<string> {
    if (!assetIdOrUrl.startsWith(ASSET_URL_PREFIX)) {
      return assetIdOrUrl
    }

    const asset = await this.findAsset(assetIdOrUrl)
    if (!asset) return ''

    return invoke<string>('get_asset_data_url', {
      dataDirectory: loadAppSettings().dataDirectory,
      relativePath: asset.relativePath,
      mimeType: asset.mimeType,
    })
  }

  async openAsset(assetIdOrUrl: string): Promise<void> {
    const asset = await this.findAsset(assetIdOrUrl)
    if (!asset) return
    const path = await invoke<string>('resolve_asset_path', {
      dataDirectory: loadAppSettings().dataDirectory,
      relativePath: asset.relativePath,
    })
    await openPath(path)
  }

  async deleteAsset(assetIdOrUrl: string): Promise<void> {
    const asset = await this.findAsset(assetIdOrUrl)
    if (!asset) return

    const database = await getDatabase()
    await database.execute('DELETE FROM assets WHERE id = ?', [asset.id])
    await invoke('remove_asset_file', {
      dataDirectory: loadAppSettings().dataDirectory,
      relativePath: asset.relativePath,
    }).catch(() => undefined)
  }
}

export const assetService = new TauriAssetService()

export function getAssetDisplayName(
  asset: Pick<AssetRecord, 'originalName' | 'id'> | null,
): string {
  return asset?.originalName?.trim() || asset?.id || '附件'
}

export function getAssetUrl(assetId: string): string {
  return createAssetUrl(assetId)
}

function mapAssetRow(row: AssetRow): AssetRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    relativePath: row.relative_path,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    contentHash: row.content_hash ?? '',
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error('无法读取文件内容。'))
      }
    })
    reader.addEventListener('error', () => reject(reader.error ?? new Error('无法读取文件内容。')))
    reader.readAsDataURL(file)
  })
}

function createAssetId(): string {
  const randomId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `asset-${randomId}`
}
