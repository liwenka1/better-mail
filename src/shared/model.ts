import type { WindowChromeState, WindowCloseRequest } from './window'

export type ProviderKind = 'imap' | 'gmail' | 'graph' | 'demo'
export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'archive' | 'junk' | 'other'
export type AccountStatus = 'idle' | 'syncing' | 'error' | 'reauth'

export interface Account {
  id: string
  email: string
  name: string
  color: string
  /** Hidden from everyday mail views; credentials, sync and queued work are retained. */
  hidden?: boolean
  provider: ProviderKind
  status: AccountStatus
  error: string | null
  lastSyncAt: number | null
  createdAt: number
}
export interface MailFolder {
  id: string
  accountId: string
  remoteId: string
  name: string
  role: FolderRole
  unreadCount: number
}
export interface MailAddress {
  name?: string
  address: string
}
export interface MessageSummary {
  id: string
  accountId: string
  subject: string
  from: MailAddress[]
  to: MailAddress[]
  date: number
  snippet: string
  isRead: boolean
  isStarred: boolean
  hasAttachments: boolean
  folderIds: string[]
  localOnly?: boolean
  sentCopy?: SentCopyStatus
}
export interface MailAttachment {
  id: string
  filename: string
  contentType: string
  size: number
}
export interface MessageBody {
  text: string
  html: string | null
  attachments: MailAttachment[]
  cc?: MailAddress[]
  replyTo?: MailAddress[]
}
export interface MessageDetail extends MessageSummary {
  body: MessageBody
}
export interface MessagePage {
  items: MessageSummary[]
  nextCursor: string | null
}
export interface ListMessagesInput {
  accountId?: string
  folderId?: string
  view: 'inbox' | 'starred' | 'all' | 'sent' | 'trash'
  search?: string
  unreadOnly?: boolean
  cursor?: string
  limit: number
}
export interface ImapConfig {
  kind: 'imap'
  username: string
  imap: { host: string; port: number; secure: boolean }
  smtp: { host: string; port: number; secure: boolean }
  sentCopy: 'auto' | 'server' | 'append'
}
export interface GmailConfig {
  kind: 'gmail'
  clientId: string
}
export interface GraphConfig {
  kind: 'graph'
  clientId: string
  tenant: string
}
export interface DemoConfig {
  kind: 'demo'
}
export type ProviderConfig = ImapConfig | GmailConfig | GraphConfig | DemoConfig
export interface Credentials {
  password?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  clientSecret?: string
  tokenCache?: string
}
export interface AccountConnection {
  account: Account
  config: ProviderConfig
}
export interface AddImapInput {
  email: string
  name: string
  color: string
  password: string
  config: ImapConfig
}
export interface OAuthInput {
  provider: 'gmail' | 'graph'
  clientId: string
  clientSecret?: string
  tenant?: string
  name: string
  color: string
}
export interface DraftAttachment {
  id: string
  filename: string
  size: number
}
export interface Draft {
  id: string
  accountId: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  text: string
  html: string | null
  attachmentIds: string[]
  updatedAt: number
  attachments?: DraftAttachment[]
}
export type DraftInput = Omit<Draft, 'id' | 'updatedAt'> & { id?: string }
export interface SendInput extends DraftInput {
  requestId: string
}
export type OperationState = 'queued' | 'running' | 'succeeded' | 'failed' | 'uncertain'
export type SentCopyState = 'pending' | 'saving' | 'saved' | 'failed' | 'uncertain' | 'missing'
export interface SentCopyStatus {
  state: SentCopyState
  error: string | null
}
export interface Operation {
  id: string
  accountId: string
  kind: 'markRead' | 'star' | 'trash' | 'send'
  state: OperationState
  messageIds: string[]
  payload: unknown
  attempts: number
  error: string | null
  createdAt: number
  updatedAt: number
  nextAttemptAt: number
  sentCopy?: SentCopyStatus
}
export interface ListOperationsInput {
  accountId?: string
  cursor?: string
  limit: number
}
export interface OperationPage {
  items: Operation[]
  nextCursor: string | null
  total: number
  pending: number
  attention: number
}
export interface MailActionInput {
  requestId: string
  accountId: string
  messageIds: string[]
  action: 'markRead' | 'star' | 'trash'
  value?: boolean
}
export interface AppSnapshot {
  accounts: Account[]
  folders: MailFolder[]
  pendingOperations: number
}
export type AppEvent =
  | { type: 'data.changed'; accountId?: string }
  | { type: 'account.changed'; accountId: string }
  | { type: 'operation.changed'; operationId: string }
  | { type: 'window.chrome.changed'; state: WindowChromeState }
  | ({ type: 'window.close.requested' } & WindowCloseRequest)

export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'AUTH'
  | 'NETWORK'
  | 'UNSUPPORTED'
  | 'INTERNAL'
  | 'SEND_UNCERTAIN'
  | 'CANCELLED'
  | 'VAULT_UNAVAILABLE'
export class MailError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public retryable = false
  ) {
    super(message)
    this.name = 'MailError'
  }
}
export interface PublicError {
  code: ErrorCode
  message: string
  retryable: boolean
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: PublicError }
