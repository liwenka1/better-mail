import type {
  Account,
  AccountConnection,
  AccountStatus,
  AppSnapshot,
  Draft,
  DraftAttachment,
  DraftInput,
  ListMessagesInput,
  ListOperationsInput,
  MailActionInput,
  MailFolder,
  MailAddress,
  MessageBody,
  MessagePage,
  MessageSummary,
  Operation,
  OperationPage,
  OperationState,
  ProviderConfig,
  ProviderKind,
  SendInput,
  SentCopyState
} from '../shared/model'
import type { RemoteFolder, RemoteRef, SendReceipt, SyncPage } from './ports'

export interface StoredMessage {
  summary: MessageSummary
  body: MessageBody | null
  ref: RemoteRef | null
}
export interface ActionPayload {
  value?: boolean
  targets: Array<{ messageId: string; ref: RemoteRef }>
  completedMessageIds?: string[]
}
export interface SendPayload {
  draft: DraftInput
  messageId: string
}
export interface PreparedSend {
  raw: Uint8Array
  date: number
}
export interface SentCopyWork {
  operation: Operation
  raw: Uint8Array | null
  date: number
  state: SentCopyState
  attempts: number
  forceSave: boolean
  receipt?: SendReceipt
}
export interface SentCopyPatch {
  state: SentCopyState
  error?: string | null
  ref?: RemoteRef
  nextAttemptAt?: number
  incrementAttempts?: boolean
}
export interface SyncSchedule {
  failures: number
  nextAttemptAt: number
  lastReconcileAt: number | null
}
export interface AccountProfilePatch {
  name?: string
  color?: string
  hidden?: boolean
}
export interface MailStore {
  listAccounts(): Account[]
  getConnection(accountId: string): AccountConnection | null
  findAccount(provider: ProviderKind, email: string): Account | null
  insertAccount(account: Account, config: ProviderConfig): void
  updateConfig(accountId: string, config: ProviderConfig): void
  updateAccountProfile(accountId: string, patch: AccountProfilePatch): Account
  updateAccount(
    accountId: string,
    patch: { status: AccountStatus; error?: string | null; lastSyncAt?: number }
  ): void
  removeAccount(accountId: string): void
  snapshot(): AppSnapshot
  listFolders(accountId: string): MailFolder[]
  replaceFolders(accountId: string, folders: RemoteFolder[]): MailFolder[]
  checkpoint(accountId: string, folderId: string): string | null
  applySyncPage(accountId: string, folderId: string, page: SyncPage): boolean
  syncSchedule(accountId: string): SyncSchedule
  updateSyncSchedule(accountId: string, schedule: SyncSchedule): void
  finishSync(accountId: string): void
  listMessages(input: ListMessagesInput): MessagePage
  getMessage(accountId: string, messageId: string): StoredMessage
  cacheBody(accountId: string, messageId: string, body: MessageBody): void
  enqueueAction(input: MailActionInput, fingerprint: string): Operation
  enqueueSend(input: SendInput, fingerprint: string): Operation
  prepareSend(operationId: string, raw: Uint8Array, date: number): void
  preparedSend(operationId: string): PreparedSend | null
  acceptSend(operationId: string, from: MailAddress, receipt?: SendReceipt): void
  nextSentCopy(now: number): SentCopyWork | null
  updateSentCopy(operationId: string, patch: SentCopyPatch): void
  retrySentCopy(operationId: string): void
  localAttachment(
    accountId: string,
    messageId: string,
    attachmentId: string
  ): DraftAttachment | null
  findRequest(accountId: string, requestId: string, fingerprint: string): Operation | null
  listOperations(): Operation[]
  listOperationsPage(input: ListOperationsInput): OperationPage
  getOperation(operationId: string): Operation
  nextOperation(now: number): Operation | null
  updateOperation(
    operationId: string,
    patch: {
      state: OperationState
      error?: string | null
      nextAttemptAt?: number
      incrementAttempts?: boolean
    }
  ): Operation
  recoverInterrupted(): void
  isSuperseded(operation: Operation): boolean
  checkpointActionTarget(operationId: string, messageId: string): void
  listDrafts(): Draft[]
  saveDraft(input: DraftInput): Draft
  deleteDraft(draftId: string): void
  addAsset(asset: DraftAttachment): void
  getAsset(assetId: string): DraftAttachment
  pendingAssetGarbage(): DraftAttachment[]
  deleteAssetIfUnreferenced(assetId: string): boolean
  close(): void
}
