import type { ImConnector, ImMessage, ImProcessingStatus, ImRuntimeStatus } from '@/models/inbox/im'
import { err, normalizeError, ok, type AppResult } from '@/models/shared/result'
import type { ImRepository } from '@/repositories/inbox/ImRepository'
import type { SqlClient } from '@/repositories/shared/SqlClient'

interface ImConnectorRow extends Record<string, unknown> {
  id: string
  provider: 'dingtalk'
  display_name: string
  source_category: string
  client_id: string
  enabled: number
  runtime_status: ImRuntimeStatus
  last_connected_at: number | null
  last_event_at: number | null
  last_error: string | null
  created_at: number
  updated_at: number
}

interface ImMessageRow extends Record<string, unknown> {
  id: string
  connector_id: string
  conversation_id: string
  remote_message_id: string
  conversation_type: 'direct' | 'group'
  conversation_title: string
  sender_id: string
  sender_name: string
  sent_at: number
  received_at: number
  message_type: string
  body_text: string
  attachment_count: number
  processing_status: ImProcessingStatus
}

export class TauriImRepository implements ImRepository {
  constructor(private readonly sql: SqlClient) {}

  async listConnectors(): Promise<AppResult<ImConnector[]>> {
    try {
      const rows = await this.sql.select<ImConnectorRow>(
        'SELECT * FROM im_connectors ORDER BY enabled DESC, updated_at DESC, id ASC',
      )
      return ok(rows.map(mapConnector))
    } catch (error) {
      return err(normalizeError(error, '无法读取消息连接器。'))
    }
  }

  async getConnector(id: string): Promise<AppResult<ImConnector>> {
    try {
      const rows = await this.sql.select<ImConnectorRow>(
        'SELECT * FROM im_connectors WHERE id = ? LIMIT 1',
        [id],
      )
      return rows[0]
        ? ok(mapConnector(rows[0]))
        : err({ code: 'not-found', message: '消息连接器不存在。' })
    } catch (error) {
      return err(normalizeError(error, '无法读取消息连接器。'))
    }
  }

  async createConnector(connector: ImConnector): Promise<AppResult<ImConnector>> {
    try {
      await this.sql.mutate('createImConnector', [
        connector.id,
        connector.displayName,
        connector.sourceCategory,
        connector.clientId,
        connector.createdAt,
        connector.updatedAt,
      ])
      return this.getConnector(connector.id)
    } catch (error) {
      return err(normalizeError(error, '无法保存钉钉连接器，请检查 Client ID 是否重复。'))
    }
  }

  async deleteConnector(id: string): Promise<AppResult<void>> {
    try {
      const result = await this.sql.mutate('deleteImConnector', [id])
      return result.rowsAffected === 1
        ? ok(undefined)
        : err({ code: 'not-found', message: '消息连接器不存在。' })
    } catch (error) {
      return err(normalizeError(error, '无法删除消息连接器。'))
    }
  }

  async updateCategory(
    id: string,
    sourceCategory: string,
    updatedAt: number,
  ): Promise<AppResult<ImConnector>> {
    try {
      const result = await this.sql.mutate('updateImCategory', [sourceCategory, updatedAt, id])
      if (result.rowsAffected !== 1)
        return err({ code: 'not-found', message: '消息连接器不存在。' })
      return this.getConnector(id)
    } catch (error) {
      return err(normalizeError(error, '无法更新消息来源分类。'))
    }
  }

  async setEnabled(
    id: string,
    enabled: boolean,
    updatedAt: number,
  ): Promise<AppResult<ImConnector>> {
    try {
      const result = await this.sql.mutate('setImConnectorEnabled', [
        enabled ? 1 : 0,
        enabled ? 'connecting' : 'stopped',
        updatedAt,
        id,
      ])
      if (result.rowsAffected !== 1)
        return err({ code: 'not-found', message: '消息连接器不存在。' })
      return this.getConnector(id)
    } catch (error) {
      return err(normalizeError(error, '无法更新消息连接状态。'))
    }
  }

  async listMessages(
    input: { connectorId?: string; status?: ImProcessingStatus; limit?: number } = {},
  ): Promise<AppResult<ImMessage[]>> {
    const conditions: string[] = []
    const values: Array<string | number> = []
    if (input.connectorId) {
      conditions.push('m.connector_id = ?')
      values.push(input.connectorId)
    }
    if (input.status) {
      conditions.push('m.processing_status = ?')
      values.push(input.status)
    }
    values.push(Math.max(1, Math.min(input.limit ?? 100, 500)))
    try {
      const rows = await this.sql.select<ImMessageRow>(
        `SELECT m.*, c.conversation_type, c.title AS conversation_title
         FROM im_messages m JOIN im_conversations c ON c.id = m.conversation_id
         ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY m.sent_at DESC, m.id ASC LIMIT ?`,
        values,
      )
      return ok(rows.map(mapMessage))
    } catch (error) {
      return err(normalizeError(error, '无法读取钉钉消息。'))
    }
  }

  async setMessageStatus(id: string, status: ImProcessingStatus): Promise<AppResult<ImMessage>> {
    try {
      const result = await this.sql.mutate('setImMessageStatus', [status, id])
      if (result.rowsAffected !== 1) return err({ code: 'not-found', message: '消息不存在。' })
      const rows = await this.sql.select<ImMessageRow>(
        `SELECT m.*, c.conversation_type, c.title AS conversation_title
         FROM im_messages m JOIN im_conversations c ON c.id = m.conversation_id
         WHERE m.id = ? LIMIT 1`,
        [id],
      )
      return rows[0] ? ok(mapMessage(rows[0])) : err({ code: 'not-found', message: '消息不存在。' })
    } catch (error) {
      return err(normalizeError(error, '无法更新消息处理状态。'))
    }
  }
}

function mapConnector(row: ImConnectorRow): ImConnector {
  return {
    id: row.id,
    provider: 'dingtalk',
    displayName: row.display_name,
    sourceCategory: row.source_category,
    clientId: row.client_id,
    enabled: Boolean(row.enabled),
    runtimeStatus: row.runtime_status,
    lastConnectedAt: row.last_connected_at == null ? null : Number(row.last_connected_at),
    lastEventAt: row.last_event_at == null ? null : Number(row.last_event_at),
    lastError: row.last_error,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function mapMessage(row: ImMessageRow): ImMessage {
  return {
    id: row.id,
    connectorId: row.connector_id,
    conversationId: row.conversation_id,
    remoteMessageId: row.remote_message_id,
    conversationType: row.conversation_type,
    conversationTitle: row.conversation_title,
    senderId: row.sender_id,
    senderName: row.sender_name,
    sentAt: Number(row.sent_at),
    receivedAt: Number(row.received_at),
    messageType: row.message_type,
    bodyText: row.body_text,
    attachmentCount: Number(row.attachment_count),
    processingStatus: row.processing_status,
  }
}
