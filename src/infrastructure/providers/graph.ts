import type {
  DownloadedAttachment,
  MailProvider,
  OutgoingMessage,
  ProviderAction,
  ProviderSession,
  RemoteFolder,
  RemoteMessage,
  RemoteRef,
  SendReceipt,
  SentCopyResult,
  SyncOptions,
  SyncPage
} from '../../core/ports'
import { MailError, type MailAddress, type MessageBody } from '../../shared/model'
import { simpleParser } from 'mailparser'
import {
  AccessTokens,
  AccountSerial,
  composeRaw,
  MAX_ATTACHMENT_BYTES,
  messageIdMatches,
  PAGE_SIZE,
  ProviderHttpError,
  requestJson
} from './common'
import { ApiSyncRounds, type ApiSyncRound } from './api-sync-state'

interface Recipient {
  emailAddress?: { name?: string; address?: string }
}
interface GraphMessage {
  id: string
  subject?: string
  from?: Recipient
  toRecipients?: Recipient[]
  ccRecipients?: Recipient[]
  replyTo?: Recipient[]
  receivedDateTime?: string
  bodyPreview?: string
  isRead?: boolean
  flag?: { flagStatus?: string }
  hasAttachments?: boolean
  internetMessageId?: string
  parentFolderId?: string
  body?: { contentType?: string; content?: string }
  '@removed'?: { reason?: string }
}
interface GraphAttachment {
  id: string
  name?: string
  contentType?: string
  size?: number
  '@odata.type'?: string
  contentBytes?: string
}
interface GraphPage<T> {
  value?: T[]
  '@odata.nextLink'?: string
  '@odata.deltaLink'?: string
}
interface GraphFolder {
  id: string
  displayName: string
  childFolderCount?: number
}
const ROOT = 'https://graph.microsoft.com/v1.0'
const addresses = (items?: Recipient[]): MailAddress[] =>
  (items ?? [])
    .filter((item) => !!item.emailAddress?.address)
    .map((item) => ({ address: item.emailAddress!.address!, name: item.emailAddress!.name }))

/** Every request opts into ImmutableId, including attachment and move requests. */
export class GraphProvider implements MailProvider {
  readonly kind = 'graph' as const
  readonly capabilities = { labels: false, archive: true, trash: true, incrementalSync: true }
  private readonly tokens = new AccessTokens()
  private readonly pages = new ApiSyncRounds<string>('graph')
  private readonly serial = new AccountSerial()
  private safeUrl(path: string): string {
    if (path.startsWith('/')) return `${ROOT}${path}`
    const url = new URL(path)
    if (url.origin !== 'https://graph.microsoft.com' || !url.pathname.startsWith('/v1.0/'))
      throw new MailError('VALIDATION', '邮件服务返回了无效的分页地址')
    return url.href
  }
  private async api<T>(
    session: ProviderSession,
    path: string,
    method = 'GET',
    body?: unknown,
    limit?: number
  ): Promise<T> {
    const token = await this.tokens.get(session)
    return requestJson<T>(
      this.safeUrl(path),
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Prefer: 'IdType="ImmutableId"',
          'Content-Type': 'application/json'
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      },
      limit
    )
  }
  async testConnection(session: ProviderSession): Promise<void> {
    await this.api(session, '/me?$select=id,mail')
  }
  async listFolders(session: ProviderSession): Promise<RemoteFolder[]> {
    const wellKnown = new Map<string, RemoteFolder['role']>()
    await Promise.all(
      (
        [
          ['inbox', 'inbox'],
          ['sentitems', 'sent'],
          ['drafts', 'drafts'],
          ['deleteditems', 'trash'],
          ['archive', 'archive'],
          ['junkemail', 'junk']
        ] as const
      ).map(async ([name, role]) => {
        try {
          const folder = await this.api<GraphFolder>(session, `/me/mailFolders/${name}?$select=id`)
          wellKnown.set(folder.id, role)
        } catch (error) {
          if (!(error instanceof MailError && error.code === 'NOT_FOUND')) throw error
        }
      })
    )
    const queue = [
      '/me/mailFolders?includeHiddenFolders=false&$top=100&$select=id,displayName,childFolderCount'
    ]
    const found = new Map<string, RemoteFolder>()
    while (queue.length) {
      const page = await this.api<GraphPage<GraphFolder>>(session, queue.shift()!)
      for (const folder of page.value ?? []) {
        if (found.has(folder.id)) continue
        found.set(folder.id, {
          id: folder.id,
          name: folder.displayName,
          role: wellKnown.get(folder.id) ?? 'other'
        })
        if (folder.childFolderCount)
          queue.push(
            `/me/mailFolders/${encodeURIComponent(folder.id)}/childFolders?includeHiddenFolders=false&$top=100&$select=id,displayName,childFolderCount`
          )
      }
      if (page['@odata.nextLink']) queue.push(page['@odata.nextLink'])
      if (found.size > 10_000)
        throw new MailError('UNSUPPORTED', '邮箱文件夹数量超过客户端支持范围')
    }
    return [...found.values()]
  }
  async syncFolder(
    session: ProviderSession,
    folder: RemoteFolder,
    cursor: string | null,
    options: SyncOptions = {}
  ): Promise<SyncPage> {
    return this.serial.run(session.account.id, async () => {
      const resumed = this.pages.resume(session.account.id, folder.id, cursor, options.full)
      if (resumed.continuation) this.safeUrl(resumed.continuation)
      let round =
        resumed.round ??
        this.pages.create(
          session.account.id,
          folder.id,
          resumed.base,
          resumed.continuation ?? resumed.base ?? this.initialDelta(folder),
          !resumed.base
        )
      let page: GraphPage<GraphMessage>
      try {
        page = await this.api(session, round.step)
      } catch (error) {
        if (!(error instanceof ProviderHttpError && error.status === 410)) throw error
        round = this.pages.create(
          session.account.id,
          folder.id,
          null,
          this.initialDelta(folder),
          true
        )
        page = await this.api(session, round.step)
      }
      return this.deltaPage(session, folder, round, page)
    })
  }
  private readonly syncFields =
    'id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,flag,hasAttachments,internetMessageId,parentFolderId'
  private initialDelta(folder: RemoteFolder): string {
    return `/me/mailFolders/${encodeURIComponent(folder.id)}/messages/delta?$top=${PAGE_SIZE}&$select=${this.syncFields}`
  }
  private summary(message: GraphMessage, folder: RemoteFolder): RemoteMessage {
    return {
      remoteId: message.id,
      ref: { id: message.id, folderId: folder.id },
      subject: message.subject || '(无主题)',
      from: addresses(message.from ? [message.from] : []),
      to: addresses(message.toRecipients),
      date: Date.parse(message.receivedDateTime ?? '') || Date.now(),
      snippet: message.bodyPreview ?? '',
      isRead: !!message.isRead,
      isStarred: message.flag?.flagStatus === 'flagged',
      hasAttachments: !!message.hasAttachments,
      internetMessageId: message.internetMessageId
    }
  }
  private async deltaPage(
    session: ProviderSession,
    folder: RemoteFolder,
    round: ApiSyncRound<string>,
    page: GraphPage<GraphMessage>
  ): Promise<SyncPage> {
    const next = page['@odata.nextLink']
    const stable = page['@odata.deltaLink']
    if ((!next && !stable) || (next && stable))
      throw new MailError('NETWORK', 'Outlook 增量响应缺少有效的同步位置，请稍后重试。', true)
    // A stable checkpoint is reused on future authenticated requests. Validate
    // it before persisting, just like every requested nextLink.
    if (stable) this.safeUrl(stable)
    const latest = new Map<string, GraphMessage>()
    for (const message of page.value ?? []) latest.set(message.id, message)
    const messages: RemoteMessage[] = []
    const removed = new Set<string>()
    const entries = [...latest.values()]
    for (let offset = 0; offset < entries.length; offset += 5) {
      await Promise.all(
        entries.slice(offset, offset + 5).map(async (entry) => {
          if (entry['@removed']) {
            removed.add(entry.id)
            return
          }
          let message = entry
          // Delta may contain only a read-state change. Fetch selected metadata
          // for that changed ID so omitted fields never erase cached metadata.
          if (
            message.subject === undefined ||
            message.receivedDateTime === undefined ||
            message.isRead === undefined ||
            message.flag === undefined ||
            message.hasAttachments === undefined
          ) {
            try {
              message = await this.api(
                session,
                `/me/messages/${encodeURIComponent(entry.id)}?$select=${this.syncFields}`
              )
            } catch (error) {
              if (error instanceof MailError && error.code === 'NOT_FOUND') {
                removed.add(entry.id)
                return
              }
              throw error
            }
          }
          if (message.parentFolderId && message.parentFolderId !== folder.id) {
            removed.add(message.id)
            return
          }
          messages.push(this.summary(message, folder))
        })
      )
    }
    for (const message of messages) round.present.add(message.remoteId)
    for (const id of removed) round.present.delete(id)
    const reset = round.full && round.page === 0
    return {
      messages,
      removedIds: [...removed],
      hasMore: !!next,
      reset,
      ...(round.full && !next ? { presentIds: [...round.present] } : {}),
      cursor: next
        ? this.pages.next(round, next, round.full ? undefined : next)
        : this.pages.finish(round, stable!)
    }
  }
  private async attachments(session: ProviderSession, ref: RemoteRef): Promise<GraphAttachment[]> {
    const result: GraphAttachment[] = []
    let next: string | undefined =
      `/me/messages/${encodeURIComponent(ref.id)}/attachments?$select=id,name,contentType,size&$top=100`
    while (next) {
      const page: GraphPage<GraphAttachment> = await this.api(session, next)
      result.push(...(page.value ?? []))
      next = page['@odata.nextLink']
      if (result.length > 1000) throw new MailError('UNSUPPORTED', '附件数量超过客户端支持范围')
    }
    return result
  }
  async fetchBody(session: ProviderSession, ref: RemoteRef): Promise<MessageBody> {
    const message = await this.api<GraphMessage>(
      session,
      `/me/messages/${encodeURIComponent(ref.id)}?$select=body,ccRecipients,replyTo`
    )
    const attachments = await this.attachments(session, ref)
    const html = message.body?.contentType?.toLowerCase() === 'html'
    const text = html
      ? ((
          await simpleParser(
            Buffer.from(
              `Content-Type: text/html; charset=utf-8\r\n\r\n${message.body?.content ?? ''}`,
              'utf8'
            ),
            { skipTextToHtml: true }
          )
        ).text ?? '')
      : (message.body?.content ?? '')
    return {
      text,
      html: html ? (message.body?.content ?? null) : null,
      attachments: attachments.map((item) => ({
        id: item.id,
        filename: item.name ?? 'attachment',
        contentType: item.contentType ?? 'application/octet-stream',
        size: item.size ?? 0
      })),
      cc: addresses(message.ccRecipients),
      replyTo: addresses(message.replyTo)
    }
  }
  async fetchAttachment(
    session: ProviderSession,
    ref: RemoteRef,
    attachmentId: string
  ): Promise<DownloadedAttachment> {
    const all = await this.attachments(session, ref)
    const metadata = all.find((item) => item.id === attachmentId)
    if (!metadata) throw new MailError('NOT_FOUND', '附件不存在')
    if ((metadata.size ?? 0) > MAX_ATTACHMENT_BYTES)
      throw new MailError('UNSUPPORTED', '附件超过 50 MiB，暂不支持下载')
    const attachment = await this.api<GraphAttachment>(
      session,
      `/me/messages/${encodeURIComponent(ref.id)}/attachments/${encodeURIComponent(attachmentId)}`,
      'GET',
      undefined,
      72 * 1024 * 1024
    )
    if (attachment['@odata.type'] !== '#microsoft.graph.fileAttachment' || !attachment.contentBytes)
      throw new MailError('UNSUPPORTED', '暂不支持嵌套邮件或云端引用附件，请在网页版邮箱中打开')
    if (attachment.contentBytes.length > Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 4)
      throw new MailError('UNSUPPORTED', '附件超过 50 MiB')
    const content = Buffer.from(attachment.contentBytes, 'base64')
    if (content.length > MAX_ATTACHMENT_BYTES) throw new MailError('UNSUPPORTED', '附件超过 50 MiB')
    return {
      filename: metadata.name ?? 'attachment',
      contentType: metadata.contentType ?? 'application/octet-stream',
      content
    }
  }
  async applyAction(session: ProviderSession, action: ProviderAction): Promise<void> {
    const path = `/me/messages/${encodeURIComponent(action.ref.id)}`
    if (action.kind === 'trash') {
      await this.api(session, `${path}/move`, 'POST', { destinationId: 'deleteditems' })
      return
    }
    const body =
      action.kind === 'markRead'
        ? { isRead: !!action.value }
        : { flag: { flagStatus: action.value ? 'flagged' : 'notFlagged' } }
    await this.api(session, path, 'PATCH', body)
  }
  async prepareSend(message: OutgoingMessage): Promise<Uint8Array> {
    const raw = await composeRaw(message)
    // Larger Graph attachments need draft/upload sessions; fail explicitly rather than sending a partial mail.
    if (raw.length > 3 * 1024 * 1024)
      throw new MailError(
        'UNSUPPORTED',
        '当前 Outlook 发送支持最大 3 MiB 原始邮件；较大附件请使用网页版邮箱'
      )
    return raw
  }
  async send(
    session: ProviderSession,
    message: OutgoingMessage,
    prepared?: Uint8Array
  ): Promise<SendReceipt> {
    const raw = Buffer.from(prepared ?? (await this.prepareSend(message)))
    if (raw.length > 3 * 1024 * 1024)
      throw new MailError(
        'UNSUPPORTED',
        '当前 Outlook 发送支持最大 3 MiB 原始邮件；较大附件请使用网页版邮箱'
      )
    const token = await this.tokens.get(session)
    await requestJson(
      `${ROOT}/me/sendMail`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Prefer: 'IdType="ImmutableId"',
          'Content-Type': 'text/plain'
        },
        body: raw.toString('base64')
      },
      undefined,
      true
    )
    return {}
  }
  async saveSentCopy(
    session: ProviderSession,
    message: OutgoingMessage,
    _raw: Uint8Array,
    _options: { verifyOnly: boolean; receipt?: SendReceipt }
  ): Promise<SentCopyResult> {
    const query = new URLSearchParams({
      $filter: `internetMessageId eq '${message.messageId.replace(/'/g, "''")}'`,
      $select: 'id,internetMessageId,parentFolderId',
      $top: String(PAGE_SIZE)
    })
    let next: string | undefined = `/me/mailFolders/sentitems/messages?${query}`
    let pages = 0
    while (next) {
      const page: GraphPage<GraphMessage> = await this.api(session, next)
      const exact = page.value?.find((item) =>
        messageIdMatches(item.internetMessageId ? [item.internetMessageId] : [], message.messageId)
      )
      if (exact)
        return {
          state: 'saved',
          ...(exact.parentFolderId ? { ref: { id: exact.id, folderId: exact.parentFolderId } } : {})
        }
      next = page['@odata.nextLink']
      if (++pages > 10 && next)
        throw new MailError('UNSUPPORTED', '已发送标识匹配过多，无法安全核验。')
    }
    return { state: 'missing' }
  }
  async dispose(): Promise<void> {
    this.pages.clear()
  }
  async disconnectAccount(accountId: string): Promise<void> {
    this.pages.forgetAccount(accountId)
  }
}
