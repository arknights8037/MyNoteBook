export type ImProcessingStatus = 'pending' | 'done' | 'archived'
export type ImRuntimeStatus =
  | 'stopped'
  | 'connecting'
  | 'online'
  | 'reconnecting'
  | 'auth_error'
  | 'error'

export interface ImConnector {
  id: string
  provider: 'dingtalk'
  displayName: string
  sourceCategory: string
  clientId: string
  enabled: boolean
  runtimeStatus: ImRuntimeStatus
  lastConnectedAt: number | null
  lastEventAt: number | null
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export interface ImMessage {
  id: string
  connectorId: string
  conversationId: string
  remoteMessageId: string
  conversationType: 'direct' | 'group'
  conversationTitle: string
  senderId: string
  senderName: string
  sentAt: number
  receivedAt: number
  messageType: string
  bodyText: string
  attachmentCount: number
  processingStatus: ImProcessingStatus
}

export interface CreateDingTalkConnectorInput {
  displayName: string
  sourceCategory: string
  clientId: string
  clientSecret: string
}

export function validateDingTalkConnectorInput(input: CreateDingTalkConnectorInput): string | null {
  if (!input.displayName.trim() || input.displayName.trim().length > 120)
    return '连接名称不能为空且不能超过 120 个字符。'
  if (!input.sourceCategory.trim() || input.sourceCategory.trim().length > 80)
    return '来源分类不能为空且不能超过 80 个字符。'
  if (!input.clientId.trim() || input.clientId.trim().length > 200)
    return '请输入有效的 Client ID。'
  if (!input.clientSecret.trim() || input.clientSecret.trim().length > 500)
    return '请输入有效的 Client Secret。'
  return null
}
