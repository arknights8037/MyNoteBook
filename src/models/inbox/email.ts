export type EmailProcessingStatus = 'pending' | 'done' | 'archived'

export interface EmailAccount {
  id: string
  displayName: string
  emailAddress: string
  imapHost: string
  imapPort: number
  username: string
  mailbox: string
  authType: 'password'
  sourceCategory: string
  enabled: boolean
  lastSyncedAt: number | null
  syncCursorAt: number | null
  lastRemoteUid: number
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export interface EmailMessage {
  id: string
  accountId: string
  mailbox: string
  remoteUid: number
  messageId: string | null
  subject: string
  fromName: string
  fromAddress: string
  toAddresses: string[]
  receivedAt: number
  preview: string
  bodyText: string
  attachmentCount: number
  serverIsRead: boolean
  processingStatus: EmailProcessingStatus
  syncedAt: number
}

export interface EmailBlockedSender {
  accountId: string
  senderAddress: string
  createdAt: number
}

export interface EmailSenderBlockResult {
  sender: EmailBlockedSender
  removedCount: number
}

export interface RemoteEmailMessage {
  remoteUid: number
  messageId: string | null
  subject: string
  fromName: string
  fromAddress: string
  toAddresses: string[]
  receivedAt: number
  preview: string
  bodyText: string
  attachmentCount: number
  serverIsRead: boolean
}

export interface CreateEmailAccountInput {
  displayName: string
  emailAddress: string
  imapHost: string
  imapPort: number
  username: string
  mailbox: string
  password: string
  sourceCategory: string
}

export interface EmailConnectionInput {
  host: string
  port: number
  username: string
  password: string
  mailbox: string
}

export function validateEmailAccountInput(input: CreateEmailAccountInput): string | null {
  if (!input.displayName.trim() || input.displayName.trim().length > 120) {
    return '账户名称不能为空且不能超过 120 个字符。'
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.emailAddress.trim())) {
    return '请输入有效的邮箱地址。'
  }
  if (!isValidImapHost(input.imapHost)) return '请输入有效的 IMAP 主机名。'
  if (!Number.isInteger(input.imapPort) || input.imapPort < 1 || input.imapPort > 65_535) {
    return 'IMAP 端口必须在 1 到 65535 之间。'
  }
  if (!input.username.trim() || input.username.length > 320) return 'IMAP 用户名无效。'
  if (!input.mailbox.trim() || input.mailbox.length > 255) return '邮箱文件夹名称无效。'
  if (!input.password) return '请输入邮箱密码或应用专用密码。'
  if (!input.sourceCategory.trim() || input.sourceCategory.trim().length > 80)
    return '来源分类不能为空且不能超过 80 个字符。'
  return null
}

function isValidImapHost(value: string): boolean {
  const host = value.trim()
  if (!host || host.length > 253 || /[\s/:@]/.test(host)) return false
  return host === 'localhost' || /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)
}
