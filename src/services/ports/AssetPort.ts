import type { AssetRecord } from '@/models/documents/asset'
import type { DocumentId } from '@/models/documents/document'

/**
 * Host capabilities needed by the editor and application services to manage assets.
 * Implementations may use Tauri, a browser-backed store, or an in-memory test double.
 */
export interface AssetPort {
  storeFile(file: File, documentId?: DocumentId | null): Promise<AssetRecord>
  findAsset(assetId: string): Promise<AssetRecord | null>
  resolveAssetUrl(assetIdOrUrl: string): Promise<string>
  openAsset(assetIdOrUrl: string): Promise<void>
  deleteAsset(assetIdOrUrl: string): Promise<void>
}

export function requireAssetPort(assetPort: AssetPort | null | undefined): AssetPort {
  if (!assetPort) {
    throw new Error('当前编辑器未配置 AssetPort。请在组合根注入资源存储实现。')
  }
  return assetPort
}
