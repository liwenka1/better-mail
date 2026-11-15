import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser'
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
import {
  MailError,
  type MailAddress,
  type MailAttachment,
  type MessageBody
} from '../../shared/model'
import {
  AccessTokens,
  AccountSerial,
  composeRaw,
  folderRole,
  MAX_ATTACHMENT_BYTES,
  MAX_BODY_BYTES,
  messageIdMatches,
  PAGE_SIZE,
  requestJson
} from './common'
import { ApiSyncRounds, type ApiSyncRound } from './api-sync-state'

interface GmailPart {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: { name: string; value: string }[]
  body?: { attachmentId?: string; size?: number; data?: string }
  parts?: GmailPart[]
}
interface GmailMessage {
  id: string
  snippet?: string
  internalDate?: string
  labelIds?: string[]
  payload?: GmailPart
  sizeEstimate?: number
}
interface GmailHistory {
  messagesAdded?: { message: { id: string } }[]
  messagesDeleted?: { message: { id: string } }[]
  labelsAdded?: { message: { id: string }; labelIds?: string[] }[]
  labelsRemoved?: { message: { id: string }; labelIds?: string[] }[]
  messages?: { id: string }[]
}
interface GmailSyncStep {
  historyId: string
  next?: string
}
const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'
const ALL_MAIL = 'better-mail:all-mail'
const structureFields = (depth: number): string =>
  `partId,mimeType,filename${depth > 0 ? `,parts(${structureFields(depth - 1)})` : ''}`
const header = (message: GmailMessage, key: string): string =>
  message.payload?.headers?.find((h) => h.name.toLowerCase() === key.toLowerCase())?.value ?? ''
function addresses(value?: AddressObject | AddressObject[]): MailAddress[] {
  return (Array.isArray(value) ? value : value ? [value] : []).flatMap((item) =>
    item.value.filter((v) => !!v.address).map((v) => ({ name: v.name, address: v.address! }))
  )
}
function parts(root?: GmailPart): GmailPart[] {
  return root ? [root, ...(root.parts ?? []).flatMap(parts)] : []
}
function decode(data: string, limit: number): Buffer {
  if (data.length > Math.ceil((limit * 4) / 3) + 4)
    throw new MailError('UNSUPPORTED', '邮件内容超过大小限制')
  const decoded = Buffer.from(data, 'base64url')
  if (decoded.length > limit) throw new MailError('UNSUPPORTED', '邮件内容超过大小限制')
  return decoded
}

/** Gmail labels retain Gmail's stable message identity across folders. Official REST API. */
export class GmailProvider implements MailProvider {
  readonly kind = 'gmail' as const
  readonly capabilities = { labels: true, archive: true, trash: true, incrementalSync: true }
  private readonly tokens = new AccessTokens()
  private readonly pages = new ApiSyncRounds<GmailSyncStep>('gmail')
  private readonly serial = new AccountSerial()
  private async api<T>(
    session: ProviderSession,
    path: string,
    method = 'GET',
    body?: unknown,
    sending = false,
    limit?: number
  ): Promise<T> {
    const accessToken = await this.tokens.get(session)
    return requestJson<T>(
      `${BASE}${path}`,
      {
        method,
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      },
      limit,
      sending
    )
  }
  async testConnection(session: ProviderSession): Promise<void> {
    await this.api(session, '/profile')
  }
  async listFolders(session: ProviderSession): Promise<RemoteFolder[]> {
    const result = await this.api<{ labels?: { id: string; name: string; type?: string }[] }>(
      session,
      '/labels'
    )
    // State labels (UNREAD/STARRED/categories) are represented by flags, not duplicate virtual folders.
    const state = new Set(['UNREAD', 'STARRED', 'IMPORTANT', 'CHAT', 'SNOOZED'])
    return [
      { id: ALL_MAIL, name: '所有邮件', role: 'archive' },
      ...(result.labels ?? [])
        .filter((label) => !state.has(label.id) && !label.id.startsWith('CATEGORY_'))
        .map((label) => ({ id: label.id, name: label.name, role: folderRole(label.id) }))
    ]
  }
  async syncFolder(
    session: ProviderSession,
    folder: RemoteFolder,
    cursor: string | null,
    options: SyncOptions = {}
  ): Promise<SyncPage> {
    return this.serial.run(session.account.id, async () => {
      const resumed = this.pages.resume(session.account.id, folder.id, cursor, options.full)
      const validBase = resumed.base && /^\d+$/.test(resumed.base) ? resumed.base : null
      let round =
        resumed.round ??
        (validBase
          ? this.pages.create(
              session.account.id,
              folder.id,
              validBase,
              { historyId: validBase },
              false
            )
          : await this.beginFull(session, folder))
      if (!round.full) {
        try {
          return await this.syncHistory(session, folder, round)
        } catch (error) {
          if (!(error instanceof MailError && error.code === 'NOT_FOUND')) throw error
          // Gmail expires history ranges. Only the history request can signal
          // this reset; per-message 404s are handled as membership removals.
          round = await this.beginFull(session, folder)
        }
      }
      return this.syncFull(session, folder, round)
    })
  }
  private async beginFull(
    session: ProviderSession,
    folder: RemoteFolder
  ): Promise<ApiSyncRound<GmailSyncStep>> {
    // Capture the baseline before enumeration so changes during a long initial
    // snapshot are replayed on the next history round rather than skipped.
    const profile = await this.api<{ historyId?: string }>(session, '/profile?fields=historyId')
    if (!profile.historyId || !/^\d+$/.test(profile.historyId))
      throw new MailError('NETWORK', 'Gmail 未返回有效的同步位置，请稍后重试。', true)
    return this.pages.create(
      session.account.id,
      folder.id,
      null,
      { historyId: profile.historyId },
      true
    )
  }
  private belongs(message: GmailMessage, folder: RemoteFolder): boolean {
    return folder.id === ALL_MAIL
      ? !message.labelIds?.some((label) => label === 'TRASH' || label === 'SPAM')
      : !!message.labelIds?.includes(folder.id)
  }
  private async metadata(
    session: ProviderSession,
    id: string,
    minimal = false
  ): Promise<GmailMessage | null> {
    const fields = minimal
      ? 'id,labelIds'
      : `id,snippet,internalDate,labelIds,payload(headers,${structureFields(6)})`
    try {
      return await this.api(
        session,
        `/messages/${encodeURIComponent(id)}?format=${minimal ? 'minimal' : 'full'}&fields=${encodeURIComponent(fields)}`
      )
    } catch (error) {
      if (error instanceof MailError && error.code === 'NOT_FOUND') return null
      throw error
    }
  }
  private async summary(message: GmailMessage, folder: RemoteFolder): Promise<RemoteMessage> {
    const parsed = await simpleParser(
      `Subject: ${header(message, 'subject')}\r\nFrom: ${header(message, 'from')}\r\nTo: ${header(message, 'to')}\r\n\r\n`
    )
    return {
      remoteId: message.id,
      ref: { id: message.id, folderId: folder.id },
      subject: parsed.subject || '(无主题)',
      from: addresses(parsed.from),
      to: addresses(parsed.to),
      date: Number(message.internalDate) || Date.now(),
      snippet: message.snippet ?? '',
      isRead: !message.labelIds?.includes('UNREAD'),
      isStarred: message.labelIds?.includes('STARRED') ?? false,
      hasAttachments: parts(message.payload).some((part) => !!part.filename),
      internetMessageId: header(message, 'message-id') || undefined
    }
  }
  private async syncFull(
    session: ProviderSession,
    folder: RemoteFolder,
    round: ApiSyncRound<GmailSyncStep>
  ): Promise<SyncPage> {
    const query = new URLSearchParams({
      maxResults: String(PAGE_SIZE),
      includeSpamTrash: folder.id === ALL_MAIL ? 'false' : 'true'
    })
    if (folder.id !== ALL_MAIL) query.set('labelIds', folder.id)
    if (round.step.next) query.set('pageToken', round.step.next)
    const result = await this.api<{ messages?: { id: string }[]; nextPageToken?: string }>(
      session,
      `/messages?${query}`
    )
    const messages: RemoteMessage[] = []
    const ids = result.messages ?? []
    for (let offset = 0; offset < ids.length; offset += 5) {
      const batch = await Promise.all(
        ids.slice(offset, offset + 5).map(async ({ id }) => {
          const message = await this.metadata(session, id)
          return message && this.belongs(message, folder) ? this.summary(message, folder) : null
        })
      )
      messages.push(...batch.filter((message): message is RemoteMessage => message !== null))
    }
    for (const message of messages) round.present.add(message.remoteId)
    const reset = round.page === 0
    return result.nextPageToken
      ? {
          messages,
          removedIds: [],
          hasMore: true,
          reset,
          cursor: this.pages.next(round, { ...round.step, next: result.nextPageToken })
        }
      : {
          messages,
          removedIds: [],
          hasMore: false,
          reset,
          presentIds: [...round.present],
          cursor: this.pages.finish(round, round.step.historyId)
        }
  }
  private async syncHistory(
    session: ProviderSession,
    folder: RemoteFolder,
    round: ApiSyncRound<GmailSyncStep>
  ): Promise<SyncPage> {
    const query = new URLSearchParams({
      startHistoryId: round.step.historyId,
      maxResults: String(PAGE_SIZE)
    })
    if (round.step.next) query.set('pageToken', round.step.next)
    const result = await this.api<{
      history?: GmailHistory[]
      historyId?: string
      nextPageToken?: string
    }>(session, `/history?${query}`)
    if (!result.nextPageToken && (!result.historyId || !/^\d+$/.test(result.historyId)))
      throw new MailError('NETWORK', 'Gmail 增量响应缺少同步位置，请稍后重试。', true)
    const changes = new Map<string, 'full' | 'flags' | 'deleted'>()
    const mark = (id: string, kind: 'full' | 'flags' | 'deleted'): void => {
      if (!id) return
      const previous = changes.get(id)
      if (previous === 'deleted' || (previous === 'full' && kind === 'flags')) return
      changes.set(id, kind)
    }
    for (const history of result.history ?? []) {
      for (const entry of history.messagesAdded ?? []) mark(entry.message.id, 'full')
      for (const entry of history.messagesDeleted ?? []) mark(entry.message.id, 'deleted')
      for (const entry of [...(history.labelsAdded ?? []), ...(history.labelsRemoved ?? [])]) {
        mark(
          entry.message.id,
          entry.labelIds?.length &&
            entry.labelIds.every((label) => label === 'UNREAD' || label === 'STARRED')
            ? 'flags'
            : 'full'
        )
      }
      // Typed records avoid fetching unrelated payloads. Never skip an ID that
      // appears only in the generic collection of a partially populated record.
      for (const entry of history.messages ?? []) if (!changes.has(entry.id)) mark(entry.id, 'full')
    }
    const messages: RemoteMessage[] = []
    const flags: NonNullable<SyncPage['flags']> = []
    const removed = new Set<string>()
    const entries = [...changes]
    for (let offset = 0; offset < entries.length; offset += 5) {
      await Promise.all(
        entries.slice(offset, offset + 5).map(async ([id, kind]) => {
          if (kind === 'deleted') {
            removed.add(id)
            return
          }
          const message = await this.metadata(session, id, kind === 'flags')
          if (!message || !this.belongs(message, folder)) {
            removed.add(id)
            return
          }
          if (kind === 'flags')
            flags.push({
              remoteId: id,
              isRead: !message.labelIds?.includes('UNREAD'),
              isStarred: message.labelIds?.includes('STARRED') ?? false
            })
          else messages.push(await this.summary(message, folder))
        })
      )
    }
    return {
      messages,
      removedIds: [...removed],
      flags,
      hasMore: !!result.nextPageToken,
      reset: false,
      cursor: result.nextPageToken
        ? this.pages.next(round, { ...round.step, next: result.nextPageToken })
        : this.pages.finish(round, result.historyId!)
    }
  }
  private async parsed(session: ProviderSession, ref: RemoteRef): Promise<ParsedMail> {
    // On-demand raw parsing is deliberately bounded. MailParser handles charset,
    // transfer encodings, multipart/alternative, inline parts and encoded headers.
    const message = await this.api<{ raw: string; sizeEstimate?: number }>(
      session,
      `/messages/${encodeURIComponent(ref.id)}?format=raw&fields=raw,sizeEstimate`,
      'GET',
      undefined,
      false,
      72 * 1024 * 1024
    )
    if ((message.sizeEstimate ?? 0) > MAX_ATTACHMENT_BYTES || !message.raw)
      throw new MailError('UNSUPPORTED', '此邮件原始内容超过 50 MiB，请使用 Gmail 网页版打开')
    const parsed = await simpleParser(decode(message.raw, MAX_ATTACHMENT_BYTES), {
      skipTextToHtml: true,
      maxHtmlLengthToParse: MAX_BODY_BYTES
    })
    if (
      Buffer.byteLength(parsed.text ?? '') + Buffer.byteLength(parsed.html || '') >
      MAX_BODY_BYTES
    )
      throw new MailError('UNSUPPORTED', '邮件正文超过 5 MiB，请使用 Gmail 网页版打开')
    if (parsed.attachments.length > 1000)
      throw new MailError('UNSUPPORTED', '邮件附件数量超过客户端支持范围')
    return parsed
  }
  async fetchBody(session: ProviderSession, ref: RemoteRef): Promise<MessageBody> {
    const parsed = await this.parsed(session, ref)
    const attachments: MailAttachment[] = parsed.attachments.map((part, index) => ({
      id: `mime:${index}`,
      filename: part.filename || 'attachment',
      contentType: part.contentType,
      size: part.size
    }))
    return {
      text: parsed.text ?? '',
      html: parsed.html || null,
      attachments,
      cc: addresses(parsed.cc),
      replyTo: addresses(parsed.replyTo)
    }
  }
  async fetchAttachment(
    session: ProviderSession,
    ref: RemoteRef,
    attachmentId: string
  ): Promise<DownloadedAttachment> {
    if (/^mime:\d{1,4}$/.test(attachmentId)) {
      const parsed = await this.parsed(session, ref)
      const attachment = parsed.attachments[Number(attachmentId.slice(5))]
      if (!attachment) throw new MailError('NOT_FOUND', '附件不存在')
      if (attachment.size > MAX_ATTACHMENT_BYTES)
        throw new MailError('UNSUPPORTED', '附件超过 50 MiB，暂不支持下载')
      return {
        filename: attachment.filename || 'attachment',
        contentType: attachment.contentType,
        content: attachment.content
      }
    }
    const message = await this.api<GmailMessage>(
      session,
      `/messages/${encodeURIComponent(ref.id)}?format=full`,
      'GET',
      undefined,
      false,
      80 * 1024 * 1024
    )
    const part = parts(message.payload).find(
      (part) =>
        (part.body?.attachmentId ?? `part:${part.partId}`) === attachmentId && !!part.filename
    )
    if (!part) throw new MailError('NOT_FOUND', '附件不存在')
    if ((part.body?.size ?? 0) > MAX_ATTACHMENT_BYTES)
      throw new MailError('UNSUPPORTED', '附件超过 50 MiB，暂不支持下载')
    const result = part.body?.attachmentId
      ? await this.api<{ data: string }>(
          session,
          `/messages/${encodeURIComponent(ref.id)}/attachments/${encodeURIComponent(attachmentId)}`,
          'GET',
          undefined,
          false,
          72 * 1024 * 1024
        )
      : part.body
    return {
      filename: part.filename!,
      contentType: part.mimeType ?? 'application/octet-stream',
      content: decode(result?.data ?? '', MAX_ATTACHMENT_BYTES)
    }
  }
  async applyAction(session: ProviderSession, action: ProviderAction): Promise<void> {
    const path = `/messages/${encodeURIComponent(action.ref.id)}`
    if (action.kind === 'trash') {
      await this.api(session, `${path}/trash`, 'POST', {})
      return
    }
    const label = action.kind === 'markRead' ? 'UNREAD' : 'STARRED'
    const add = action.kind === 'markRead' ? !action.value : !!action.value
    await this.api(session, `${path}/modify`, 'POST', {
      addLabelIds: add ? [label] : [],
      removeLabelIds: add ? [] : [label]
    })
  }
  async prepareSend(message: OutgoingMessage): Promise<Uint8Array> {
    const raw = await composeRaw(message)
    if (raw.length > 35 * 1024 * 1024)
      throw new MailError('UNSUPPORTED', 'Gmail 原始邮件最大支持 35 MiB，请缩小附件')
    return raw
  }
  async send(
    session: ProviderSession,
    message: OutgoingMessage,
    prepared?: Uint8Array
  ): Promise<SendReceipt> {
    const raw = Buffer.from(prepared ?? (await this.prepareSend(message)))
    if (raw.length > 35 * 1024 * 1024)
      throw new MailError('UNSUPPORTED', 'Gmail 原始邮件最大支持 35 MiB，请缩小附件')
    const sent = await this.api<{ id?: string }>(
      session,
      '/messages/send',
      'POST',
      { raw: raw.toString('base64url') },
      true
    )
    return sent?.id ? { remoteId: sent.id } : {}
  }
  async saveSentCopy(
    session: ProviderSession,
    message: OutgoingMessage,
    _raw: Uint8Array,
    options: { verifyOnly: boolean; receipt?: SendReceipt }
  ): Promise<SentCopyResult> {
    const inspect = async (id: string): Promise<SentCopyResult | null> => {
      let found: GmailMessage
      try {
        found = await this.api(
          session,
          `/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Message-ID&fields=id,labelIds,payload(headers)`
        )
      } catch (error) {
        if (error instanceof MailError && error.code === 'NOT_FOUND') return null
        throw error
      }
      const ids =
        found.payload?.headers
          ?.filter((item) => item.name.toLowerCase() === 'message-id')
          .map((item) => item.value) ?? []
      return found.labelIds?.includes('SENT') && messageIdMatches(ids, message.messageId)
        ? { state: 'saved', ref: { id: found.id, folderId: 'SENT' } }
        : null
    }
    if (options.receipt?.remoteId) {
      const found = await inspect(options.receipt.remoteId)
      if (found) return found
    }
    const query = new URLSearchParams({
      labelIds: 'SENT',
      q: `rfc822msgid:${message.messageId}`,
      maxResults: String(PAGE_SIZE)
    })
    let pages = 0
    for (;;) {
      const page = await this.api<{ messages?: { id: string }[]; nextPageToken?: string }>(
        session,
        `/messages?${query}`
      )
      for (const candidate of page.messages ?? []) {
        const found = await inspect(candidate.id)
        if (found) return found
      }
      if (!page.nextPageToken) return { state: 'missing' }
      if (++pages > 10) throw new MailError('UNSUPPORTED', '已发送标识匹配过多，无法安全核验。')
      query.set('pageToken', page.nextPageToken)
    }
  }
  async dispose(): Promise<void> {
    this.pages.clear()
  }
  async disconnectAccount(accountId: string): Promise<void> {
    this.pages.forgetAccount(accountId)
  }
}
