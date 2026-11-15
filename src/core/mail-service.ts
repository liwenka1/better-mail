import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, stat, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { requestSchemas, type Method } from '../shared/contracts'
import { MailError } from '../shared/model'
import type {
  Account,
  AddImapInput,
  AppEvent,
  Credentials,
  DraftAttachment,
  MessageDetail,
  Operation,
  ProviderConfig
} from '../shared/model'
import type {
  CredentialVault,
  DownloadedAttachment,
  MailProvider,
  OutgoingMessage,
  ProviderSession
} from './ports'
import type { ActionPayload, MailStore, SendPayload } from './store'

interface ServiceOptions {
  store: MailStore
  providers: MailProvider[]
  vault: CredentialVault
  emit: (event: AppEvent) => void
  attachmentDir: string
  random?: () => number
}
interface SyncRequest {
  source?: 'manual' | 'initial' | 'background' | 'change'
  folders?: string[]
  full?: boolean
  reconcile?: boolean
}
function mergeSyncRequest(first: SyncRequest, second: SyncRequest): SyncRequest {
  const source =
    first.source === 'manual' || second.source === 'manual'
      ? 'manual'
      : first.source === 'initial' || second.source === 'initial'
        ? 'initial'
        : first.source === 'change' || second.source === 'change'
          ? 'change'
          : 'background'
  return {
    source,
    full: Boolean(first.full || second.full),
    reconcile: Boolean(first.reconcile || second.reconcile),
    folders:
      !first.folders || !second.folders
        ? undefined
        : [...new Set([...first.folders, ...second.folders])]
  }
}
const fingerprint = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
function publicMessage(error: unknown): string {
  // Only provider-normalized MailError messages may cross the transport boundary.
  return error instanceof MailError ? error.message : '邮件服务出现错误，请检查连接设置后重试。'
}
function syncFolderPriority(role: string): number {
  if (role === 'inbox') return 0
  if (role === 'sent') return 1
  if (role === 'junk' || role === 'trash') return 3
  return 2
}

export class MailService {
  private readonly store: MailStore
  private readonly providers: Map<MailProvider['kind'], MailProvider>
  private readonly vault: CredentialVault
  private readonly emit: (event: AppEvent) => void
  private readonly attachmentDir: string
  private readonly random: () => number
  private timer: ReturnType<typeof setInterval> | null = null
  private syncTimer: ReturnType<typeof setInterval> | null = null
  private stopping = false
  private started = false
  private processing: Promise<void> | null = null
  private readonly syncs = new Map<string, Promise<void>>()
  private readonly accountLocks = new Map<string, Promise<unknown>>()
  private readonly removedAccounts = new Set<string>()
  private readonly pendingSync = new Map<string, SyncRequest>()
  private readonly activeSync = new Map<string, SyncRequest>()
  private readonly deferredSync = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; request: SyncRequest }
  >()
  private readonly lastSyncStart = new Map<string, number>()
  private readonly lastFolderRefresh = new Map<string, number>()
  private readonly watchTasks = new Map<string, Promise<void>>()
  private readonly lastWatchCheck = new Map<string, number>()
  private lastEnvironmentCheck = -Infinity
  private readonly activeTasks = new Set<Promise<unknown>>()
  private assetTail: Promise<unknown> = Promise.resolve()

  constructor(options: ServiceOptions) {
    this.store = options.store
    this.providers = new Map(options.providers.map((provider) => [provider.kind, provider]))
    this.vault = options.vault
    this.emit = (event) => {
      try {
        options.emit(event)
      } catch {
        /* Observers cannot roll back a committed change. */
      }
    }
    this.attachmentDir = options.attachmentDir
    this.random = options.random ?? Math.random
  }
  start(): void {
    if (this.started) return
    this.started = true
    this.stopping = false
    this.store.recoverInterrupted()
    this.timer = setInterval(() => {
      void this.processQueue().catch(() => undefined)
    }, 1000)
    this.syncTimer = setInterval(() => {
      if (!this.stopping) {
        void this.syncAll(false, { source: 'background' })
        void this.withAssets(() => this.collectAssetGarbage()).catch(() => undefined)
      }
    }, 10_000)
    this.timer.unref?.()
    this.syncTimer.unref?.()
    void this.processQueue().catch(() => undefined)
    void this.syncAll(false, { source: 'initial' })
    void this.withAssets(() => this.collectAssetGarbage()).catch(() => undefined)
  }
  async stop(): Promise<void> {
    this.stopping = true
    for (const pending of this.deferredSync.values()) clearTimeout(pending.timer)
    this.deferredSync.clear()
    this.pendingSync.clear()
    if (this.timer) clearInterval(this.timer)
    if (this.syncTimer) clearInterval(this.syncTimer)
    this.timer = this.syncTimer = null
    await Promise.allSettled([
      ...(this.processing ? [this.processing] : []),
      ...this.syncs.values(),
      ...this.accountLocks.values(),
      ...this.activeTasks,
      this.assetTail
    ])
    await Promise.allSettled([...this.providers.values()].map((provider) => provider.dispose?.()))
    this.lastFolderRefresh.clear()
    this.lastSyncStart.clear()
    this.lastWatchCheck.clear()
    this.watchTasks.clear()
    this.lastEnvironmentCheck = -Infinity
    this.started = false
  }
  notifyEnvironmentChange(_reason: 'resume' | 'online' | 'foreground'): void {
    if (!this.started || this.stopping || Date.now() - this.lastEnvironmentCheck < 15_000) return
    this.lastEnvironmentCheck = Date.now()
    // Wake/focus cannot bypass server backoff or retry an uncertain submission.
    void this.syncAll(false, { source: 'background' })
  }
  async handle(method: Method, input: unknown): Promise<unknown> {
    if (this.stopping) throw new MailError('CANCELLED', '应用正在退出，请稍后重试。')
    if (!Object.hasOwn(requestSchemas, method)) throw new MailError('VALIDATION', '不支持的请求。')
    const validation = requestSchemas[method].safeParse(input)
    if (!validation.success)
      throw new MailError('VALIDATION', validation.error.issues[0]?.message ?? '请求参数无效。')
    // The worker validates independently of Electron main's validation.
    switch (method) {
      case 'app.snapshot':
        requestSchemas[method].parse(input)
        return this.store.snapshot()
      case 'accounts.addImap':
        return this.addImap(requestSchemas[method].parse(input))
      case 'accounts.demo':
        requestSchemas[method].parse(input)
        return this.addDemoAccounts()
      case 'accounts.remove':
        return this.removeAccount(requestSchemas[method].parse(input).accountId)
      case 'accounts.update': {
        const { accountId, ...patch } = requestSchemas[method].parse(input)
        // Profile writes are local and synchronous. They need not wait behind
        // a slow network sync and never replace provider-owned state.
        const previous = this.store.getConnection(accountId)?.account
        if (!previous) throw new MailError('NOT_FOUND', '账号不存在。')
        const account = this.store.updateAccountProfile(accountId, patch)
        if (
          account.name !== previous.name ||
          account.color !== previous.color ||
          account.hidden !== previous.hidden
        ) {
          this.emit({ type: 'account.changed', accountId })
          if (account.hidden !== previous.hidden) this.emit({ type: 'data.changed', accountId })
        }
        return account
      }
      case 'accounts.sync': {
        const { accountId, full } = requestSchemas[method].parse(input)
        if (accountId) await this.syncAccount(accountId, { source: 'manual', full })
        else await this.syncAll(true, { source: 'manual', full })
        return
      }
      case 'messages.list':
        return this.store.listMessages(requestSchemas[method].parse(input))
      case 'messages.get': {
        const { accountId, messageId } = requestSchemas[method].parse(input)
        return this.getMessage(accountId, messageId)
      }
      case 'messages.action': {
        const parsed = requestSchemas[method].parse(input)
        if (parsed.action === 'trash' && !this.providerFor(parsed.accountId).capabilities.trash)
          throw new MailError('UNSUPPORTED', '此邮箱暂不支持移动到垃圾箱。')
        const operation = this.store.enqueueAction(parsed, fingerprint(parsed))
        this.emit({ type: 'data.changed', accountId: parsed.accountId })
        this.changedOperation(operation)
        void this.processQueue().catch(() => undefined)
        return operation
      }
      case 'drafts.list':
        requestSchemas[method].parse(input)
        return this.store.listDrafts()
      case 'drafts.save': {
        const parsed = requestSchemas[method].parse(input)
        return this.withAssets(async () => {
          const draft = this.store.saveDraft(parsed)
          await this.collectAssetGarbage()
          this.emit({ type: 'data.changed', accountId: draft.accountId })
          return draft
        })
      }
      case 'drafts.delete': {
        const { draftId } = requestSchemas[method].parse(input)
        return this.withAssets(async () => {
          this.store.deleteDraft(draftId)
          await this.collectAssetGarbage()
          this.emit({ type: 'data.changed' })
        })
      }
      case 'mail.send': {
        const parsed = requestSchemas[method].parse(input)
        const operation = await this.withAssets(async () =>
          this.store.enqueueSend(parsed, fingerprint(parsed))
        )
        this.changedOperation(operation)
        void this.processQueue().catch(() => undefined)
        return operation
      }
      case 'operations.list':
        requestSchemas[method].parse(input)
        return this.store.listOperations()
      case 'operations.page':
        return this.store.listOperationsPage(requestSchemas[method].parse(input))
      case 'sentCopies.retry': {
        const { operationId } = requestSchemas[method].parse(input)
        this.store.retrySentCopy(operationId)
        this.changedOperation(this.store.getOperation(operationId))
        void this.processQueue().catch(() => undefined)
        return
      }
      case 'operations.retry': {
        const operation = this.store.getOperation(requestSchemas[method].parse(input).operationId)
        if (operation.state === 'uncertain')
          throw new MailError(
            'SEND_UNCERTAIN',
            '发送结果待确认，不能直接重发。请先核对邮箱的已发送邮件；确认未发送后，重新编辑并发送。'
          )
        if (operation.state !== 'failed')
          throw new MailError('VALIDATION', '只有明确失败的操作可以重试。')
        if (this.store.isSuperseded(operation))
          throw new MailError('VALIDATION', '这项操作已被后续操作取代，请以邮件当前状态为准。')
        this.store.updateOperation(operation.id, {
          state: 'queued',
          error: null,
          nextAttemptAt: Date.now()
        })
        this.changedOperation(operation)
        void this.processQueue().catch(() => undefined)
        return
      }
      case 'accounts.oauth':
      case 'messages.loadImages':
      case 'attachments.pick':
      case 'attachments.save':
        throw new MailError('UNSUPPORTED', '此操作需要由桌面应用处理。')
    }
  }
  private changedOperation(operation: Operation): void {
    this.emit({ type: 'operation.changed', operationId: operation.id })
  }
  private providerFor(accountId: string): MailProvider {
    const connection = this.store.getConnection(accountId)
    if (!connection) throw new MailError('NOT_FOUND', '账号不存在。')
    const provider = this.providers.get(connection.account.provider)
    if (!provider) throw new MailError('UNSUPPORTED', '此账号的邮箱服务暂不可用。')
    return provider
  }
  private async session(accountId: string): Promise<ProviderSession> {
    const connection = this.store.getConnection(accountId)
    if (!connection) throw new MailError('NOT_FOUND', '账号不存在。')
    const credentials =
      connection.account.provider === 'demo' ? {} : await this.vault.get(accountId)
    if (!credentials) throw new MailError('AUTH', '账号凭据不可用，请重新授权或重新添加账号。')
    return {
      ...connection,
      credentials,
      updateCredentials: async (next) => {
        await this.vault.set(accountId, next)
      }
    }
  }
  private async withAccount<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.accountLocks.get(accountId)
    const current = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(work)
    this.accountLocks.set(accountId, current)
    try {
      return await current
    } finally {
      if (this.accountLocks.get(accountId) === current) this.accountLocks.delete(accountId)
    }
  }
  private withAssets<T>(work: () => Promise<T>): Promise<T> {
    const next = this.assetTail.catch(() => undefined).then(work)
    this.assetTail = next
    return next
  }
  private async collectAssetGarbage(): Promise<number> {
    let failures = 0
    // Callers hold the asset lane across unlink + metadata deletion. New drafts
    // or sends cannot acquire a reference while a file is being collected.
    for (const asset of this.store.pendingAssetGarbage()) {
      try {
        await unlink(this.assetPath(asset.id))
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') {
          failures++
          continue
        }
      }
      this.store.deleteAssetIfUnreferenced(asset.id)
    }
    return failures
  }
  private async addImap(input: AddImapInput): Promise<Account> {
    if (this.store.findAccount('imap', input.email))
      throw new MailError('VALIDATION', '此邮箱已经添加。需要更换授权码时，请移除后重新添加。')
    return this.addAccount({
      email: input.email,
      name: input.name,
      color: input.color,
      config: input.config,
      credentials: { password: input.password }
    })
  }
  async addOAuthAccount(input: {
    email: string
    name: string
    color: string
    config: ProviderConfig
    credentials: Credentials
  }): Promise<Account> {
    if (this.stopping) throw new MailError('CANCELLED', '应用正在退出。')
    if (input.config.kind !== 'gmail' && input.config.kind !== 'graph')
      throw new MailError('VALIDATION', 'OAuth 账号类型无效。')
    const existing = this.store.findAccount(input.config.kind, input.email)
    if (!existing) return this.addAccount(input)
    return this.withAccount(existing.id, async () => {
      await this.vault.set(existing.id, input.credentials)
      this.store.updateConfig(existing.id, input.config)
      try {
        await this.providerFor(existing.id).testConnection(await this.session(existing.id))
        this.store.updateAccount(existing.id, { status: 'idle', error: null })
      } catch (error) {
        this.store.updateAccount(existing.id, { status: 'reauth', error: publicMessage(error) })
        throw error
      }
      this.emit({ type: 'account.changed', accountId: existing.id })
      setTimeout(() => {
        void this.syncAccount(existing.id).catch(() => undefined)
      }, 0)
      return this.store.getConnection(existing.id)!.account
    })
  }
  private async addAccount(input: {
    email: string
    name: string
    color: string
    config: ProviderConfig
    credentials: Credentials
  }): Promise<Account> {
    const provider = this.providers.get(input.config.kind)
    if (!provider) throw new MailError('UNSUPPORTED', '此邮箱类型暂不支持。')
    const account: Account = {
      id: randomUUID(),
      email: input.email,
      name: input.name,
      color: input.color,
      provider: input.config.kind,
      hidden: false,
      status: 'idle',
      error: null,
      lastSyncAt: null,
      createdAt: Date.now()
    }
    return this.withAccount(account.id, async () => {
      if (this.stopping) throw new MailError('CANCELLED', '应用正在退出。')
      let credentials = input.credentials
      await provider.testConnection({
        account,
        config: input.config,
        credentials,
        updateCredentials: async (next) => {
          credentials = next
        }
      })
      if (this.stopping) throw new MailError('CANCELLED', '应用正在退出，已取消添加账号。')
      if (account.provider !== 'demo') await this.vault.set(account.id, credentials)
      try {
        this.store.insertAccount(account, input.config)
      } catch (error) {
        if (account.provider !== 'demo') await this.vault.delete(account.id).catch(() => undefined)
        throw error
      }
      this.emit({ type: 'account.changed', accountId: account.id })
      setTimeout(() => {
        this.requestResync(account.id)
      }, 0)
      return account
    })
  }
  private async addDemoAccounts(): Promise<void> {
    if (!this.providers.has('demo')) throw new MailError('UNSUPPORTED', '演示数据不可用。')
    for (const item of [
      { email: 'demo@example.com', name: '个人邮箱 · 演示', color: '#7c6cf6' },
      { email: 'work@example.com', name: '工作邮箱 · 演示', color: '#43a896' }
    ]) {
      const existing = this.store.findAccount('demo', item.email)
      if (existing) await this.syncAccount(existing.id)
      else {
        const account = await this.addAccount({
          ...item,
          config: { kind: 'demo' },
          credentials: {}
        })
        await this.syncAccount(account.id)
      }
    }
  }
  private async removeAccount(accountId: string): Promise<void> {
    // Mark cancellation before awaiting the current page's network request.
    this.removedAccounts.add(accountId)
    this.pendingSync.delete(accountId)
    const pending = this.deferredSync.get(accountId)
    if (pending) clearTimeout(pending.timer)
    this.deferredSync.delete(accountId)
    this.lastFolderRefresh.delete(accountId)
    this.lastSyncStart.delete(accountId)
    this.lastWatchCheck.delete(accountId)
    try {
      await this.withAccount(accountId, async () => {
        const connection = this.store.getConnection(accountId)
        if (!connection) throw new MailError('NOT_FOUND', '账号不存在。')
        await this.providerFor(accountId).disconnectAccount?.(accountId)
        if (connection.account.provider !== 'demo') await this.vault.delete(accountId)
        const failures = await this.withAssets(async () => {
          this.store.removeAccount(accountId)
          return this.collectAssetGarbage()
        })
        this.emit({ type: 'data.changed', accountId })
        this.emit({ type: 'account.changed', accountId })
        if (failures)
          throw new MailError(
            'INTERNAL',
            '账号已移除，但部分本地附件未能清理。请检查数据目录权限；应用重启后会再次尝试清理。'
          )
      })
    } catch (error) {
      if (this.store.getConnection(accountId)) this.removedAccounts.delete(accountId)
      throw error
    }
  }
  private assertSyncActive(accountId: string): void {
    if (
      this.stopping ||
      this.removedAccounts.has(accountId) ||
      !this.store.getConnection(accountId)
    )
      throw new MailError('CANCELLED', '账号同步已取消。')
  }
  private assertDispatchActive(accountId: string): void {
    if (
      this.stopping ||
      this.removedAccounts.has(accountId) ||
      !this.store.getConnection(accountId)
    ) {
      throw new MailError('CANCELLED', '账号正在移除或应用正在退出，此操作尚未派发。')
    }
  }
  private async syncAll(
    throwOnFailure = false,
    request: SyncRequest = { source: 'manual' }
  ): Promise<void> {
    if (this.stopping) return
    const results = await Promise.allSettled(
      this.store.listAccounts().map((account) => this.syncAccount(account.id, request))
    )
    const failure = results.find((result) => result.status === 'rejected')
    if (throwOnFailure && failure?.status === 'rejected') throw failure.reason
  }
  private requestResync(accountId: string, folders?: string[]): void {
    if (this.stopping || this.removedAccounts.has(accountId)) return
    const request: SyncRequest = { source: 'change', folders }
    if (this.syncs.has(accountId)) {
      this.pendingSync.set(
        accountId,
        mergeSyncRequest(this.pendingSync.get(accountId) ?? request, request)
      )
      return
    }
    this.deferSync(accountId, request)
  }
  private deferSync(accountId: string, request: SyncRequest): void {
    if (this.stopping || this.removedAccounts.has(accountId)) return
    const existing = this.deferredSync.get(accountId)
    if (existing) {
      existing.request = mergeSyncRequest(existing.request, request)
      return
    }
    const delay = Math.max(250, 5000 - (Date.now() - (this.lastSyncStart.get(accountId) ?? 0)))
    const item = {
      request,
      timer: setTimeout(() => {
        this.deferredSync.delete(accountId)
        void this.syncAccount(accountId, item.request).catch(() => undefined)
      }, delay)
    }
    item.timer.unref?.()
    this.deferredSync.set(accountId, item)
  }
  private syncAccount(
    accountId: string,
    request: SyncRequest = { source: 'manual' }
  ): Promise<void> {
    if (this.stopping || this.removedAccounts.has(accountId)) return Promise.resolve()
    const connection = this.store.getConnection(accountId)
    if (!connection) return Promise.reject(new MailError('NOT_FOUND', '账号不存在。'))
    const schedule = this.store.syncSchedule(accountId)
    if (
      request.source !== 'manual' &&
      (connection.account.status === 'reauth' ||
        (schedule.nextAttemptAt > Date.now() &&
          (request.source !== 'change' || schedule.failures > 0)))
    ) {
      if (
        !this.syncs.has(accountId) &&
        connection.account.status === 'idle' &&
        schedule.failures === 0
      )
        this.ensureWatch(accountId)
      return this.syncs.get(accountId) ?? Promise.resolve()
    }
    const active = this.syncs.get(accountId)
    if (active) {
      const scope = this.activeSync.get(accountId)!
      const needsFollowup =
        (request.full && !scope.full) ||
        (!request.folders && Boolean(scope.folders)) ||
        (scope.folders && request.folders?.some((id) => !scope.folders!.includes(id)))
      if (needsFollowup) {
        this.pendingSync.set(
          accountId,
          mergeSyncRequest(this.pendingSync.get(accountId) ?? request, request)
        )
        if (request.source === 'manual')
          return active.catch(() => undefined).then(() => this.syncs.get(accountId))
      }
      return active
    }
    const deferred = this.deferredSync.get(accountId)
    if (deferred) {
      clearTimeout(deferred.timer)
      this.deferredSync.delete(accountId)
      request = mergeSyncRequest(request, deferred.request)
    }
    this.activeSync.set(accountId, request)
    this.lastSyncStart.set(accountId, Date.now())
    const reconcile = Boolean(
      request.full ||
      request.reconcile ||
      (!request.folders &&
        (!schedule.lastReconcileAt || Date.now() - schedule.lastReconcileAt > 6 * 60 * 60_000))
    )
    const sync = (async () => {
      try {
        const folders = await this.withAccount(accountId, async () => {
          this.assertSyncActive(accountId)
          const provider = this.providerFor(accountId)
          if (request.source === 'manual' || connection.account.lastSyncAt === null) {
            this.store.updateAccount(accountId, { status: 'syncing', error: null })
            this.emit({ type: 'account.changed', accountId })
          }
          let known = this.store.listFolders(accountId)
          if (
            !known.length ||
            reconcile ||
            Date.now() - (this.lastFolderRefresh.get(accountId) ?? 0) > 10 * 60_000 ||
            request.folders?.some((id) => !known.some((folder) => folder.remoteId === id))
          ) {
            const remoteFolders = await provider.listFolders(await this.session(accountId))
            this.assertSyncActive(accountId)
            const signature = (items: typeof known) =>
              JSON.stringify(
                items
                  .map((folder) => [folder.remoteId, folder.role, folder.name])
                  .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
              )
            const previousFolders = signature(known)
            known = this.store.replaceFolders(accountId, remoteFolders)
            if (signature(known) !== previousFolders) this.emit({ type: 'data.changed', accountId })
            this.lastFolderRefresh.set(accountId, Date.now())
          }
          return request.folders
            ? known.filter((folder) => request.folders!.includes(folder.remoteId))
            : known
        })
        // Prioritize first-use content without changing navigation ordering.
        // Array.sort is stable, retaining the store's order within each tier.
        folders.sort(
          (first, second) => syncFolderPriority(first.role) - syncFolderPriority(second.role)
        )
        for (const folder of folders) {
          let cursor = this.store.checkpoint(accountId, folder.id)
          let pages = 0
          do {
            // Only one bounded network page holds the account lane. Body fetches,
            // writes, credential replacement and account removal can interleave.
            const page = await this.withAccount(accountId, async () => {
              this.assertSyncActive(accountId)
              const provider = this.providerFor(accountId)
              const result = await provider.syncFolder(
                await this.session(accountId),
                { id: folder.remoteId, name: folder.name, role: folder.role },
                cursor,
                { full: Boolean(request.full && pages === 0), reconcile }
              )
              this.assertSyncActive(accountId)
              const changed = this.store.applySyncPage(accountId, folder.id, result)
              if (changed) this.emit({ type: 'data.changed', accountId })
              return result
            })
            if (!page.hasMore) break
            // A stable opaque token may advance provider-owned snapshot state.
            if (!page.cursor && !page.reset)
              throw new MailError('INTERNAL', '邮箱同步位置无效，请稍后重试。')
            cursor = page.cursor
            if (++pages > 2000)
              throw new MailError('INTERNAL', '本次同步分页数量过大，已暂停；请重新同步。')
          } while (!this.stopping)
          if (this.stopping) throw new MailError('CANCELLED', '账号同步已取消。')
        }
        await this.withAccount(accountId, async () => {
          this.assertSyncActive(accountId)
          if (!request.folders) this.store.finishSync(accountId)
          this.store.updateSyncSchedule(accountId, {
            failures: 0,
            nextAttemptAt: request.folders
              ? schedule.nextAttemptAt
              : Date.now() + 60_000 + Math.floor(this.random() * 5000),
            lastReconcileAt: !request.folders && reconcile ? Date.now() : schedule.lastReconcileAt
          })
          this.store.updateAccount(accountId, {
            status: 'idle',
            error: null,
            lastSyncAt: Date.now()
          })
        })
        this.ensureWatch(accountId)
      } catch (error) {
        if (!this.removedAccounts.has(accountId) && this.store.getConnection(accountId)) {
          if (!(error instanceof MailError && error.code === 'CANCELLED')) {
            const failures = schedule.failures + 1
            const delay = Math.min(30 * 60_000, 30_000 * 2 ** Math.min(failures - 1, 6))
            this.store.updateSyncSchedule(accountId, {
              failures,
              nextAttemptAt:
                error instanceof MailError && error.code === 'AUTH'
                  ? Number.MAX_SAFE_INTEGER
                  : Date.now() + delay + Math.floor(this.random() * delay * 0.2),
              lastReconcileAt: schedule.lastReconcileAt
            })
          }
          this.store.updateAccount(accountId, {
            status:
              error instanceof MailError && error.code === 'AUTH'
                ? 'reauth'
                : error instanceof MailError && error.code === 'CANCELLED'
                  ? 'idle'
                  : 'error',
            error:
              error instanceof MailError && error.code === 'CANCELLED' ? null : publicMessage(error)
          })
        }
        throw error
      } finally {
        this.emit({ type: 'account.changed', accountId })
      }
    })()
    this.syncs.set(accountId, sync)
    const finished = (): void => {
      if (this.syncs.get(accountId) === sync) this.syncs.delete(accountId)
      this.activeSync.delete(accountId)
      const pending = this.pendingSync.get(accountId)
      this.pendingSync.delete(accountId)
      if (pending && !this.stopping && !this.removedAccounts.has(accountId)) {
        if (pending.source === 'manual')
          void this.syncAccount(accountId, pending).catch(() => undefined)
        else this.deferSync(accountId, pending)
      }
    }
    void sync.then(finished, finished)
    return sync
  }
  private ensureWatch(accountId: string): void {
    if (this.stopping || this.removedAccounts.has(accountId) || this.watchTasks.has(accountId))
      return
    const provider = this.providerFor(accountId)
    if (!provider.watch) return
    if (Date.now() - (this.lastWatchCheck.get(accountId) ?? -Infinity) < 30_000) return
    this.lastWatchCheck.set(accountId, Date.now())
    const task = this.trackTask(async () => {
      const session = await this.session(accountId)
      this.assertSyncActive(accountId)
      await provider.watch!(session, (change) => {
        if (change.accountId === accountId)
          this.requestResync(accountId, change.folderId ? [change.folderId] : undefined)
      })
      if (this.stopping || this.removedAccounts.has(accountId))
        await provider.disconnectAccount?.(accountId)
    })
    this.watchTasks.set(accountId, task)
    void task
      .catch(() => undefined)
      .finally(() => {
        if (this.watchTasks.get(accountId) === task) this.watchTasks.delete(accountId)
      })
  }
  private async getMessage(accountId: string, messageId: string): Promise<MessageDetail> {
    const cached = this.store.getMessage(accountId, messageId)
    if (cached.body) return { ...cached.summary, body: cached.body }
    return this.withAccount(accountId, async () => {
      const message = this.store.getMessage(accountId, messageId)
      if (message.body) return { ...message.summary, body: message.body }
      if (!message.ref) throw new MailError('NOT_FOUND', '本地发送记录的正文不可用。')
      const body = await this.providerFor(accountId).fetchBody(
        await this.session(accountId),
        message.ref
      )
      this.store.cacheBody(accountId, messageId, body)
      return { ...message.summary, body }
    })
  }
  private processQueue(): Promise<void> {
    if (this.processing) return this.processing
    if (this.stopping) return Promise.resolve()
    const process = this.drainQueue().then(() => this.drainSentCopies())
    this.processing = process
    void process.then(
      () => {
        if (this.processing === process) this.processing = null
      },
      () => {
        if (this.processing === process) this.processing = null
      }
    )
    return process
  }
  private async drainQueue(): Promise<void> {
    let operation: Operation | null
    while (!this.stopping && (operation = this.store.nextOperation(Date.now()))) {
      const queued = operation
      let succeeded = false
      await this.withAccount(queued.accountId, async () => {
        if (this.stopping || !this.store.getConnection(queued.accountId)) return
        const current = this.store.getOperation(queued.id)
        if (current.state !== 'queued') return
        if (this.removedAccounts.has(queued.accountId)) {
          this.store.updateOperation(current.id, {
            state: 'failed',
            error: '账号正在移除，此操作尚未执行。'
          })
          this.changedOperation(current)
          return
        }
        const running = this.store.updateOperation(current.id, {
          state: 'running',
          error: null,
          incrementAttempts: true
        })
        this.changedOperation(running)
        let attemptedSend = false
        try {
          const session = await this.session(running.accountId)
          const provider = this.providerFor(running.accountId)
          if (running.kind === 'send') {
            if (this.store.isSuperseded(running))
              throw new MailError('VALIDATION', '此草稿已有后续发送任务，旧发送任务不能再次投递。')
            let prepared = this.store.preparedSend(running.id)
            const outgoing = await this.outgoingMessage(
              running,
              prepared?.date ?? Date.now(),
              !prepared
            )
            if (!prepared && provider.prepareSend) {
              const raw = await provider.prepareSend(outgoing)
              this.store.prepareSend(running.id, raw, outgoing.date!)
              prepared = this.store.preparedSend(running.id)
            }
            // Preparation is local and durable before dispatch. Only a lost
            // submission acknowledgement may make delivery uncertain.
            this.assertDispatchActive(running.accountId)
            attemptedSend = true
            const receipt = await provider.send(session, outgoing, prepared?.raw)
            this.store.acceptSend(
              running.id,
              { address: session.account.email, name: session.account.name },
              receipt || undefined
            )
          } else {
            const payload = running.payload as ActionPayload
            for (const target of payload.targets) {
              if (payload.completedMessageIds?.includes(target.messageId)) continue
              this.assertDispatchActive(running.accountId)
              // A delayed retry must not overwrite a newer intention. Other
              // targets in the same bulk operation may still need execution.
              if (!this.store.isSuperseded({ ...running, messageIds: [target.messageId] })) {
                try {
                  await provider.applyAction(session, {
                    kind: running.kind,
                    ref: target.ref,
                    value: payload.value
                  })
                } catch (error) {
                  // Removing an already absent original is an achieved trash
                  // intention, including a MOVE accepted just before a crash.
                  if (!(
                    running.kind === 'trash' &&
                    error instanceof MailError &&
                    error.code === 'NOT_FOUND'
                  ))
                    throw error
                }
              }
              this.store.checkpointActionTarget(running.id, target.messageId)
            }
          }
          if (running.kind !== 'send')
            this.store.updateOperation(running.id, { state: 'succeeded', error: null })
          succeeded = true
          if (!this.syncs.has(running.accountId))
            this.store.updateAccount(running.accountId, { status: 'idle', error: null })
        } catch (error) {
          const knownNotSent =
            error instanceof MailError &&
            ['AUTH', 'VALIDATION', 'UNSUPPORTED', 'NOT_FOUND', 'VAULT_UNAVAILABLE'].includes(
              error.code
            )
          const uncertain = running.kind === 'send' && attemptedSend && !knownNotSent
          const retry =
            running.kind !== 'send' &&
            error instanceof MailError &&
            error.retryable &&
            running.attempts < 5
          this.store.updateOperation(running.id, {
            state: uncertain ? 'uncertain' : retry ? 'queued' : 'failed',
            error: uncertain
              ? '发送结果待确认，请核对已发送邮件后再决定是否重新发送。'
              : publicMessage(error),
            nextAttemptAt:
              Date.now() + Math.min(300_000, 5000 * 2 ** Math.max(0, running.attempts - 1))
          })
          if (error instanceof MailError && error.code === 'AUTH')
            this.store.updateAccount(running.accountId, {
              status: 'reauth',
              error: publicMessage(error)
            })
        } finally {
          this.changedOperation(running)
          this.emit({ type: 'data.changed', accountId: running.accountId })
          this.emit({ type: 'account.changed', accountId: running.accountId })
        }
      })
      if (succeeded && queued.kind === 'trash') {
        const sourceFolders = (queued.payload as ActionPayload).targets.map(
          (target) => target.ref.folderId
        )
        const trashFolders = this.store
          .listFolders(queued.accountId)
          .filter((folder) => folder.role === 'trash')
          .map((folder) => folder.remoteId)
        this.requestResync(queued.accountId, [...new Set([...sourceFolders, ...trashFolders])])
      }
    }
  }
  private async outgoingMessage(
    operation: Operation,
    date: number,
    checkAttachments: boolean
  ): Promise<OutgoingMessage> {
    const connection = this.store.getConnection(operation.accountId)
    if (!connection) throw new MailError('NOT_FOUND', '账号不存在。')
    const payload = operation.payload as SendPayload
    const attachments = await Promise.all(
      payload.draft.attachmentIds.map(async (id) => {
        const asset = this.store.getAsset(id)
        const path = this.assetPath(id)
        if (checkAttachments) {
          try {
            const info = await stat(path)
            if (!info.isFile()) throw new Error('not a file')
          } catch {
            throw new MailError('NOT_FOUND', `附件“${asset.filename}”不可用，请重新选择。`)
          }
        }
        return { path, filename: asset.filename }
      })
    )
    return {
      from: connection.account.email,
      to: payload.draft.to,
      cc: payload.draft.cc,
      bcc: payload.draft.bcc,
      subject: payload.draft.subject,
      text: payload.draft.text,
      html: payload.draft.html,
      messageId: payload.messageId,
      date,
      attachments
    }
  }
  private async drainSentCopies(): Promise<void> {
    // Archiving has its own persisted state. This lane never submits SMTP mail.
    for (let count = 0; count < 20 && !this.stopping; count++) {
      const job = this.store.nextSentCopy(Date.now())
      if (!job) break
      await this.withAccount(job.operation.accountId, async () => {
        const operation = job.operation
        if (this.removedAccounts.has(operation.accountId)) return
        try {
          this.assertDispatchActive(operation.accountId)
          const session = await this.session(operation.accountId)
          // A sync page may have claimed this copy while the archive job was
          // waiting for the account lane. Never act on that stale queue entry.
          const currentCopy = this.store.getOperation(operation.id).sentCopy
          if (!currentCopy || currentCopy.state === 'saved' || currentCopy.state !== job.state)
            return
          const provider = this.providerFor(operation.accountId)
          if (!provider.saveSentCopy) {
            this.store.updateSentCopy(operation.id, {
              state: 'missing',
              error: '邮件已提交发送，此接入方式暂不能核验服务器副本。'
            })
            return
          }
          const appendPolicy =
            session.config.kind === 'imap' && session.config.sentCopy !== 'server'
          const maySave =
            session.config.kind === 'imap' &&
            job.state !== 'uncertain' &&
            (appendPolicy || job.forceSave) &&
            (job.attempts >= 2 || job.forceSave)
          let raw = job.raw
          if (maySave && !raw) {
            // Old confirmed sends have no frozen MIME. Reconstruct only after
            // an explicit request to save their retained content as a copy.
            if (!job.forceSave || !provider.prepareSend)
              throw new MailError('UNSUPPORTED', '缺少原始邮件副本，请核对保存策略。')
            const outgoing = await this.outgoingMessage(operation, job.date, true)
            raw = await provider.prepareSend(outgoing)
            this.store.prepareSend(operation.id, raw, job.date)
          }
          const outgoing = await this.outgoingMessage(operation, job.date, false)
          this.store.updateSentCopy(operation.id, {
            state: maySave ? 'saving' : job.state,
            incrementAttempts: true,
            error: null
          })
          this.assertDispatchActive(operation.accountId)
          const result = await provider.saveSentCopy(session, outgoing, raw ?? new Uint8Array(), {
            verifyOnly: !maySave,
            receipt: job.receipt,
            assertActive: () => this.assertDispatchActive(operation.accountId)
          })
          if (result.state === 'saved') {
            this.store.updateSentCopy(operation.id, {
              state: 'saved',
              error: null,
              ref: result.ref
            })
            const sentFolders = result.ref
              ? [result.ref.folderId]
              : this.store
                  .listFolders(operation.accountId)
                  .filter((folder) => folder.role === 'sent')
                  .map((folder) => folder.remoteId)
            if (sentFolders.length) this.requestResync(operation.accountId, sentFolders)
          } else if (result.state === 'uncertain' || job.state === 'uncertain') {
            this.store.updateSentCopy(operation.id, {
              state: 'uncertain',
              error: '邮件已提交发送，副本保存结果待核验；不会再次发送或自动重复保存。',
              nextAttemptAt: Date.now() + Math.min(600_000, 5000 * 2 ** Math.min(job.attempts, 7))
            })
          } else if (job.attempts < 2) {
            this.store.updateSentCopy(operation.id, {
              state: 'pending',
              nextAttemptAt: Date.now() + (job.attempts === 0 ? 2000 : 5000)
            })
          } else {
            this.store.updateSentCopy(operation.id, {
              state: 'missing',
              error: '邮件已提交发送，尚未找到服务器已发送副本。可以单独补存副本。'
            })
          }
        } catch (error) {
          const uncertain = job.state === 'uncertain'
          const retry = error instanceof MailError && error.retryable && job.attempts < 5
          this.store.updateSentCopy(operation.id, {
            state: uncertain ? 'uncertain' : retry ? 'pending' : 'failed',
            error: publicMessage(error),
            nextAttemptAt: Date.now() + Math.min(600_000, 5000 * 2 ** Math.min(job.attempts, 7))
          })
        } finally {
          this.changedOperation(operation)
          this.emit({ type: 'data.changed', accountId: operation.accountId })
        }
      })
    }
  }
  private assetPath(assetId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(assetId)) throw new MailError('NOT_FOUND', '附件标识无效。')
    return join(this.attachmentDir, assetId)
  }
  importAttachments(paths: string[]): Promise<DraftAttachment[]> {
    return this.trackTask(() => this.copyAttachments(paths))
  }
  private trackTask<T>(work: () => Promise<T>): Promise<T> {
    const task = Promise.resolve().then(() => {
      if (this.stopping) throw new MailError('CANCELLED', '应用正在退出。')
      return work()
    })
    this.activeTasks.add(task)
    void task.then(
      () => {
        this.activeTasks.delete(task)
      },
      () => {
        this.activeTasks.delete(task)
      }
    )
    return task
  }
  private async copyAttachments(paths: string[]): Promise<DraftAttachment[]> {
    if (paths.length > 20) throw new MailError('VALIDATION', '一次最多选择 20 个附件。')
    await mkdir(this.attachmentDir, { recursive: true, mode: 0o700 })
    const assets: DraftAttachment[] = []
    try {
      for (const source of paths) {
        const info = await stat(source)
        if (!info.isFile()) throw new MailError('VALIDATION', '只能添加普通文件作为附件。')
        if (info.size > 50 * 1024 * 1024)
          throw new MailError('VALIDATION', '单个附件不能超过 50 MB，邮箱服务商可能另有更小限制。')
        const asset = { id: randomUUID(), filename: basename(source), size: info.size }
        await copyFile(source, this.assetPath(asset.id))
        try {
          this.store.addAsset(asset)
        } catch (error) {
          await unlink(this.assetPath(asset.id)).catch(() => undefined)
          throw error
        }
        assets.push(asset)
      }
      return assets
    } catch (error) {
      throw error instanceof MailError
        ? error
        : new MailError('INTERNAL', '无法读取附件，请检查文件是否仍然存在。')
    }
  }
  async downloadAttachment(input: {
    accountId: string
    messageId: string
    attachmentId: string
  }): Promise<DownloadedAttachment> {
    if (this.stopping) throw new MailError('CANCELLED', '应用正在退出。')
    requestSchemas['attachments.save'].parse(input)
    return this.withAccount(input.accountId, async () => {
      const stored = this.store.getMessage(input.accountId, input.messageId)
      const local = this.store.localAttachment(input.accountId, input.messageId, input.attachmentId)
      if (local) {
        try {
          const path = this.assetPath(local.id)
          const info = await stat(path)
          if (info.size > 50 * 1024 * 1024) throw new MailError('UNSUPPORTED', '附件超过 50 MiB。')
          return {
            filename: local.filename,
            contentType: 'application/octet-stream',
            content: await readFile(path)
          }
        } catch (error) {
          if (error instanceof MailError) throw error
          throw new MailError('NOT_FOUND', '本地发送附件不可用。')
        }
      }
      if (!stored.ref) throw new MailError('NOT_FOUND', '附件不属于这封本地邮件。')
      const provider = this.providerFor(input.accountId)
      const session = await this.session(input.accountId)
      const body = stored.body ?? (await provider.fetchBody(session, stored.ref))
      if (!stored.body) this.store.cacheBody(input.accountId, input.messageId, body)
      if (!body.attachments.some((attachment) => attachment.id === input.attachmentId))
        throw new MailError('NOT_FOUND', '附件不属于这封邮件。')
      return provider.fetchAttachment(session, stored.ref, input.attachmentId)
    })
  }
}
