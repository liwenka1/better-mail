import type {
  AccountConnection,
  Credentials,
  FolderRole,
  MailAddress,
  MessageBody,
  ProviderKind
} from '../shared/model'

export interface ProviderCapabilities {
  labels: boolean
  archive: boolean
  trash: boolean
  incrementalSync: boolean
}
export interface ProviderSession extends AccountConnection {
  credentials: Credentials
  updateCredentials: (credentials: Credentials) => Promise<void>
}
export interface RemoteFolder {
  id: string
  name: string
  role: FolderRole
}
export interface RemoteRef {
  id: string
  folderId: string
  uidValidity?: string
}
export interface RemoteMessage {
  remoteId: string
  ref: RemoteRef
  subject: string
  from: MailAddress[]
  to: MailAddress[]
  date: number
  snippet: string
  isRead: boolean
  isStarred: boolean
  hasAttachments: boolean
  internetMessageId?: string
}
export interface SyncPage {
  messages: RemoteMessage[]
  flags?: Array<{ remoteId: string; isRead?: boolean; isStarred?: boolean }>
  removedIds: string[]
  cursor: string | null
  hasMore: boolean
  /** A complete folder snapshot; only supplied once all pages are consumed. */
  presentIds?: string[]
  reset?: boolean
}
export interface SyncOptions {
  full?: boolean
  reconcile?: boolean
}
export interface ProviderChange {
  accountId: string
  folderId?: string
}
export interface ProviderAction {
  kind: 'markRead' | 'star' | 'trash'
  ref: RemoteRef
  value?: boolean
}
export interface OutgoingAttachment {
  path: string
  filename: string
  contentType?: string
}
export interface OutgoingMessage {
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  text: string
  html: string | null
  messageId: string
  attachments: OutgoingAttachment[]
  date?: number
}
export interface SendReceipt {
  remoteId?: string
  ref?: RemoteRef
}
export interface SentCopyResult {
  state: 'saved' | 'missing' | 'uncertain'
  ref?: RemoteRef
}
export interface DownloadedAttachment {
  filename: string
  contentType: string
  content: Uint8Array
}
export interface MailProvider {
  readonly kind: ProviderKind
  readonly capabilities: ProviderCapabilities
  testConnection(session: ProviderSession): Promise<void>
  listFolders(session: ProviderSession): Promise<RemoteFolder[]>
  syncFolder(
    session: ProviderSession,
    folder: RemoteFolder,
    cursor: string | null,
    options?: SyncOptions
  ): Promise<SyncPage>
  watch?(session: ProviderSession, onChange: (change: ProviderChange) => void): Promise<void>
  fetchBody(session: ProviderSession, ref: RemoteRef): Promise<MessageBody>
  fetchAttachment(
    session: ProviderSession,
    ref: RemoteRef,
    attachmentId: string
  ): Promise<DownloadedAttachment>
  applyAction(session: ProviderSession, action: ProviderAction): Promise<void>
  prepareSend?(message: OutgoingMessage): Promise<Uint8Array>
  send(
    session: ProviderSession,
    message: OutgoingMessage,
    raw?: Uint8Array
  ): Promise<SendReceipt | void>
  saveSentCopy?(
    session: ProviderSession,
    message: OutgoingMessage,
    raw: Uint8Array,
    options: { verifyOnly: boolean; receipt?: SendReceipt; assertActive?: () => void }
  ): Promise<SentCopyResult>
  disconnectAccount?(accountId: string): Promise<void>
  dispose?(): Promise<void>
}
export interface CredentialVault {
  get(accountId: string): Promise<Credentials | null>
  set(accountId: string, credentials: Credentials): Promise<void>
  delete(accountId: string): Promise<void>
}
