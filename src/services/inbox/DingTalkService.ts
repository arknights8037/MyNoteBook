import { invoke } from '@tauri-apps/api/core'

import {
  validateDingTalkConnectorInput,
  type CreateDingTalkConnectorInput,
  type ImConnector,
  type ImProcessingStatus,
} from '@/models/inbox/im'
import { loadAppSettings } from '@/models/settings/settings'
import { err, normalizeError, ok, type AppResult } from '@/models/shared/result'
import type { ImRepository } from '@/repositories/inbox/ImRepository'

export class DingTalkService {
  constructor(
    private readonly repository: ImRepository,
    private readonly createId: (prefix: string) => string,
    private readonly now: () => number = Date.now,
  ) {}

  listConnectors() {
    return this.repository.listConnectors()
  }

  listMessages(input: { connectorId?: string; status?: ImProcessingStatus; limit?: number } = {}) {
    return this.repository.listMessages(input)
  }

  async testConnection(input: CreateDingTalkConnectorInput): Promise<AppResult<void>> {
    const invalid = validateDingTalkConnectorInput(input)
    if (invalid) return err({ code: 'validation-error', message: invalid })
    try {
      await invoke('test_dingtalk_connection', {
        input: { clientId: input.clientId.trim(), clientSecret: input.clientSecret.trim() },
      })
      return ok(undefined)
    } catch (error) {
      return err(normalizeError(error, '无法连接钉钉 Stream。'))
    }
  }

  async createConnector(input: CreateDingTalkConnectorInput): Promise<AppResult<ImConnector>> {
    const invalid = validateDingTalkConnectorInput(input)
    if (invalid) return err({ code: 'validation-error', message: invalid })
    const tested = await this.testConnection(input)
    if (!tested.ok) return tested

    const createdAt = this.now()
    const connector: ImConnector = {
      id: this.createId('im-connector'),
      provider: 'dingtalk',
      displayName: input.displayName.trim(),
      sourceCategory: input.sourceCategory.trim(),
      clientId: input.clientId.trim(),
      enabled: true,
      runtimeStatus: 'stopped',
      lastConnectedAt: null,
      lastEventAt: null,
      lastError: null,
      createdAt,
      updatedAt: createdAt,
    }

    try {
      await invoke('set_dingtalk_connector_secret', {
        input: { connectorId: connector.id, clientSecret: input.clientSecret.trim() },
      })
    } catch (error) {
      return err(normalizeError(error, '无法安全保存钉钉凭据。'))
    }

    const created = await this.repository.createConnector(connector)
    if (!created.ok) {
      await invoke('delete_dingtalk_connector_secret', { connectorId: connector.id }).catch(
        () => undefined,
      )
      return created
    }
    try {
      await this.startRuntime(created.value)
      return created
    } catch (error) {
      await this.repository.deleteConnector(connector.id)
      await invoke('delete_dingtalk_connector_secret', { connectorId: connector.id }).catch(
        () => undefined,
      )
      return err(normalizeError(error, '已验证凭据，但无法启动钉钉 Stream。'))
    }
  }

  async startConnector(connector: ImConnector): Promise<AppResult<ImConnector>> {
    const enabled = await this.repository.setEnabled(connector.id, true, this.now())
    if (!enabled.ok) return enabled
    try {
      await this.startRuntime(enabled.value)
      return enabled
    } catch (error) {
      await this.repository.setEnabled(connector.id, false, this.now())
      return err(normalizeError(error, '无法启动钉钉 Stream。'))
    }
  }

  async stopConnector(connector: ImConnector): Promise<AppResult<ImConnector>> {
    try {
      await invoke('stop_dingtalk_connector', {
        connectorId: connector.id,
        dataDirectory: loadAppSettings().dataDirectory,
      })
    } catch (error) {
      return err(normalizeError(error, '无法停止钉钉 Stream。'))
    }
    return this.repository.setEnabled(connector.id, false, this.now())
  }

  async deleteConnector(connector: ImConnector): Promise<AppResult<void>> {
    await invoke('stop_dingtalk_connector', {
      connectorId: connector.id,
      dataDirectory: loadAppSettings().dataDirectory,
    }).catch(() => undefined)
    const removed = await this.repository.deleteConnector(connector.id)
    if (!removed.ok) return removed
    try {
      await invoke('delete_dingtalk_connector_secret', { connectorId: connector.id })
      return removed
    } catch (error) {
      return err(normalizeError(error, '连接器已删除，但安全凭据清理失败。'))
    }
  }

  setMessageStatus(id: string, status: ImProcessingStatus) {
    return this.repository.setMessageStatus(id, status)
  }

  updateCategory(id: string, sourceCategory: string) {
    const normalized = sourceCategory.trim()
    if (!normalized || normalized.length > 80)
      return Promise.resolve(
        err({ code: 'validation-error', message: '来源分类不能为空且不能超过 80 个字符。' }),
      )
    return this.repository.updateCategory(id, normalized, this.now())
  }

  private startRuntime(connector: ImConnector): Promise<void> {
    return invoke('start_dingtalk_connector', {
      input: {
        connectorId: connector.id,
        clientId: connector.clientId,
        dataDirectory: loadAppSettings().dataDirectory,
      },
    })
  }
}
