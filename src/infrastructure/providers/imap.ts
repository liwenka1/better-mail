import { randomUUID } from 'node:crypto'
import { ImapFlow, type MessageAddressObject, type MessageStructureObject } from 'imapflow'
import nodemailer from 'nodemailer'
import type {
  DownloadedAttachment,
  MailProvider,
  OutgoingMessage,
  ProviderChange,
  ProviderAction,
  ProviderSession,
  RemoteFolder,
  RemoteMessage,
  RemoteRef,
  SendReceipt,
  SentCopyResult,
  SyncPage,
  SyncOptions
} from '../../core/ports'
import { MailError, type ImapConfig, type MailAddress, type MessageBody } from '../../shared/model'
import {
  AccountSerial,
  composeRaw,
  exactMessageIdHeader,
  folderRole,
  MAX_ATTACHMENT_BYTES,
  MAX_BODY_BYTES,
  PAGE_SIZE,
  providerError,
  readBounded,
  smtpDeliveryRaw
} from './common'

interface ImapCheckpoint {
  accountId: string
  folderId: string
  validity: string
  highUid: number
  modseq: string | null
  known: string
  lastReconcileAt: number
}
interface ImapCursor {
  version: 1
  kind: 'imap'
  accountId: string
  folderId: string
  validity: string
  base: ImapCheckpoint | null
  run?: { token: string; offset: number; full: boolean; observed: string }
}
interface ImapSnapshot {
  token: string
  accountId: string
  base: ImapCheckpoint | null
  validity: string
  uids: number[]
  observed: Set<number>
  known: Map<number, number>
  flags: NonNullable<SyncPage['flags']>
  removed: string[]
  highUid: number
  modseq: string | null
  full: boolean
  lastReconcileAt: number
}
interface ImapWatch {
  client: ImapFlow
  notify: (change: ProviderChange) => void
  folderId: string
  armed: boolean
  stopped: boolean
}
const MAX_UID = 0xffff_ffff
const MAX_CHECKPOINT_UIDS = 1_000_000
const validUid = (uid: number): boolean => Number.isInteger(uid) && uid > 0 && uid <= MAX_UID
const flagBits = (flags?: Set<string>): number =>
  Number(flags?.has('\\Seen') ?? false) | (Number(flags?.has('\\Flagged') ?? false) << 1)
function encodeKnown(known: Map<number, number>): string {
  const entries = [...known].sort(([a], [b]) => a - b)
  const ranges: string[] = []
  for (let index = 0; index < entries.length; index++) {
    const [first, flags] = entries[index]!
    let last = first
    while (entries[index + 1]?.[0] === last + 1 && entries[index + 1]?.[1] === flags)
      last = entries[++index]![0]
    ranges.push(`${first}${last === first ? '' : `-${last}`}:${flags}`)
  }
  return ranges.join(',')
}
function decodeKnown(encoded: string): Map<number, number> {
  const known = new Map<number, number>()
  if (!encoded) return known
  for (const range of encoded.split(',')) {
    const match = /^(\d+)(?:-(\d+))?:([0-3])$/.exec(range)
    if (!match) throw new Error('Invalid IMAP checkpoint range')
    const first = Number(match[1])
    const last = Number(match[2] ?? first)
    if (
      !validUid(first) ||
      !validUid(last) ||
      last < first ||
      last - first + known.size >= MAX_CHECKPOINT_UIDS
    )
      throw new Error('Invalid IMAP checkpoint size')
    for (let uid = first; uid <= last; uid++) known.set(uid, Number(match[3]))
  }
  return known
}
function readCursor(cursor: string | null, accountId: string, folderId: string): ImapCursor | null {
  if (!cursor || cursor.length > 32 * 1024 * 1024) return null
  try {
    const value = JSON.parse(cursor) as ImapCursor
    const base = value.base
    if (
      value.version !== 1 ||
      value.kind !== 'imap' ||
      value.accountId !== accountId ||
      value.folderId !== folderId ||
      typeof value.validity !== 'string' ||
      !/^\d+$/.test(value.validity)
    )
      return null
    if (
      base &&
      (base.accountId !== accountId ||
        base.validity !== value.validity ||
        base.folderId !== folderId ||
        typeof base.validity !== 'string' ||
        !/^\d+$/.test(base.validity) ||
        !Number.isInteger(base.highUid) ||
        base.highUid < 0 ||
        base.highUid > MAX_UID ||
        (base.modseq !== null && (typeof base.modseq !== 'string' || !/^\d+$/.test(base.modseq))) ||
        typeof base.known !== 'string' ||
        !Number.isFinite(base.lastReconcileAt))
    )
      return null
    if (
      value.run &&
      (typeof value.run.token !== 'string' ||
        !Number.isInteger(value.run.offset) ||
        value.run.offset < 0 ||
        value.run.offset > MAX_CHECKPOINT_UIDS ||
        typeof value.run.full !== 'boolean' ||
        typeof value.run.observed !== 'string')
    )
      return null
    if (!base && !value.run) return null
    return value
  } catch {
    return null
  }
}
const addresses = (items?: MessageAddressObject[]): MailAddress[] =>
  (items ?? [])
    .filter((item) => !!item.address)
    .map((item) => ({ address: item.address!, name: item.name }))
const nodes = (root?: MessageStructureObject): MessageStructureObject[] =>
  root ? [root, ...(root.childNodes ?? []).flatMap(nodes)] : []
const attachment = (part: MessageStructureObject): boolean =>
  part.disposition === 'attachment' ||
  !!part.dispositionParameters?.filename ||
  !!part.parameters?.name ||
  (!part.childNodes?.length &&
    !part.type.startsWith('text/') &&
    !part.type.startsWith('multipart/'))
export function imapIdentity(folder: string, validity: string, uid: number): string {
  return `imap:${Buffer.from(folder).toString('base64url')}:${validity}:${uid}`
}

/** Serialized work connection, plus one dedicated INBOX watcher when IDLE is advertised. */
export class ImapProvider implements MailProvider {
  readonly kind = 'imap' as const
  readonly capabilities = { labels: false, archive: true, trash: true, incrementalSync: true }
  private readonly clients = new Map<string, ImapFlow>()
  private readonly serial = new AccountSerial()
  private readonly snapshots = new Map<string, ImapSnapshot>()
  private readonly watches = new Map<string, ImapWatch>()
  private readonly watchSerial = new AccountSerial()
  private readonly watchVersions = new Map<string, number>()
  private connectionEpoch = 0
  private config(session: ProviderSession): ImapConfig {
    if (session.config.kind !== 'imap')
      throw new MailError('VALIDATION', '账号配置与 IMAP 接入方式不符')
    return session.config
  }
  private createClient(session: ProviderSession, watching = false): ImapFlow {
    const config = this.config(session)
    if (!session.credentials.password) throw new MailError('AUTH', '缺少邮箱密码或客户端授权码')
    return new ImapFlow({
      host: config.imap.host,
      port: config.imap.port,
      secure: config.imap.secure,
      doSTARTTLS: config.imap.secure ? undefined : true,
      auth: { user: config.username, pass: session.credentials.password },
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      logger: false,
      connectionTimeout: 30_000,
      greetingTimeout: 15_000,
      socketTimeout: watching ? 10 * 60_000 : 90_000,
      ...(watching ? { maxIdleTime: 4 * 60_000 } : {}),
      maxLiteralSize: MAX_ATTACHMENT_BYTES + 1024 * 1024
    })
  }
  private async client(session: ProviderSession): Promise<ImapFlow> {
    const existing = this.clients.get(session.account.id)
    if (existing?.usable) return existing
    const client = this.createClient(session)
    const epoch = this.connectionEpoch
    client.on('error', () => {
      /* Never log protocol errors: they can contain message and credential data. */
    })
    client.on('close', () => {
      if (this.clients.get(session.account.id) === client) this.clients.delete(session.account.id)
    })
    try {
      await client.connect()
      if (epoch !== this.connectionEpoch) throw new MailError('CANCELLED', '邮箱连接已取消。')
      this.clients.set(session.account.id, client)
      return client
    } catch (error) {
      client.close()
      throw providerError(error)
    }
  }
  private async run<T>(
    session: ProviderSession,
    action: (client: ImapFlow) => Promise<T>
  ): Promise<T> {
    return this.serial.run(session.account.id, async () => {
      try {
        return await action(await this.client(session))
      } catch (error) {
        throw providerError(error)
      }
    })
  }
  private smtp(session: ProviderSession) {
    const config = this.config(session)
    return nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      requireTLS: !config.smtp.secure,
      auth: { user: config.username, pass: session.credentials.password },
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      connectionTimeout: 30_000,
      greetingTimeout: 15_000,
      socketTimeout: 90_000,
      logger: false,
      debug: false,
      disableUrlAccess: true
    })
  }
  async testConnection(session: ProviderSession): Promise<void> {
    try {
      await this.run(session, async () => {
        const smtp = this.smtp(session)
        try {
          await smtp.verify()
        } finally {
          smtp.close()
        }
      })
    } catch (error) {
      const client = this.clients.get(session.account.id)
      this.clients.delete(session.account.id)
      if (client) {
        try {
          await client.logout()
        } catch {
          client.close()
        }
      }
      throw error
    }
  }
  async listFolders(session: ProviderSession): Promise<RemoteFolder[]> {
    return this.run(session, async (client) =>
      (await client.list())
        .filter((folder) => !folder.flags.has('\\Noselect'))
        .map((folder) => ({
          id: folder.path,
          name: folder.name,
          role: folderRole(folder.specialUse || folder.path)
        }))
    )
  }
  async syncFolder(
    session: ProviderSession,
    folder: RemoteFolder,
    cursor: string | null,
    options: SyncOptions = {}
  ): Promise<SyncPage> {
    return this.run(session, async (client) => {
      const lock = await client.getMailboxLock(folder.id, { readOnly: true })
      try {
        if (!client.mailbox) throw new MailError('NOT_FOUND', '邮箱文件夹不存在')
        const validity = String(client.mailbox.uidValidity)
        const key = JSON.stringify([session.account.id, folder.id])
        const parsed = readCursor(cursor, session.account.id, folder.id)
        let snapshot = this.snapshots.get(key)
        let offset = parsed?.run?.offset ?? 0
        if (
          !snapshot ||
          snapshot.token !== parsed?.run?.token ||
          snapshot.validity !== validity ||
          JSON.stringify(snapshot.base) !== JSON.stringify(parsed?.base ?? null)
        ) {
          // A lost in-memory plan always replays its last committed baseline.
          // Skipping to the old offset in a newly generated plan could lose mail.
          offset = 0
          snapshot = await this.beginSnapshot(
            client,
            session.account.id,
            folder.id,
            parsed?.base ?? null,
            options.full === true || parsed?.run?.full === true,
            validity,
            parsed?.validity === validity ? (parsed.run?.observed ?? '') : ''
          )
          this.snapshots.set(key, snapshot)
        }
        const selected = snapshot.uids.slice(offset, offset + PAGE_SIZE)
        const messages: RemoteMessage[] = []
        const fetched = new Set<number>()
        if (selected.length) {
          for await (const message of client.fetch(
            selected.join(','),
            { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true },
            { uid: true }
          )) {
            const remoteId = imapIdentity(folder.id, validity, message.uid)
            if (!selected.includes(message.uid)) continue
            fetched.add(message.uid)
            snapshot.observed.add(message.uid)
            snapshot.known.set(message.uid, flagBits(message.flags))
            messages.push({
              remoteId,
              ref: { id: String(message.uid), folderId: folder.id, uidValidity: validity },
              subject: message.envelope?.subject || '(无主题)',
              from: addresses(message.envelope?.from),
              to: addresses(message.envelope?.to),
              date: new Date(
                message.internalDate || message.envelope?.date || Date.now()
              ).getTime(),
              snippet: '',
              isRead: message.flags?.has('\\Seen') ?? false,
              isStarred: message.flags?.has('\\Flagged') ?? false,
              hasAttachments: nodes(message.bodyStructure).some(attachment),
              internetMessageId: message.envelope?.messageId
            })
          }
        }
        // Messages expunged between the UID snapshot and metadata fetch must
        // not become part of the next durable baseline.
        const lateRemoved: string[] = []
        for (const uid of selected)
          if (!fetched.has(uid)) {
            snapshot.known.delete(uid)
            if (!snapshot.full && snapshot.observed.has(uid))
              lateRemoved.push(imapIdentity(folder.id, validity, uid))
          }
        const nextOffset = offset + PAGE_SIZE
        const hasMore =
          nextOffset <
          Math.max(snapshot.uids.length, snapshot.flags.length, snapshot.removed.length)
        if (!hasMore) this.snapshots.delete(key)
        const next: ImapCursor = hasMore
          ? {
              version: 1,
              kind: 'imap',
              accountId: session.account.id,
              folderId: folder.id,
              validity,
              base: snapshot.base,
              run: {
                token: snapshot.token,
                offset: nextOffset,
                full: snapshot.full,
                observed: encodeKnown(new Map([...snapshot.observed].map((uid) => [uid, 0])))
              }
            }
          : {
              version: 1,
              kind: 'imap',
              accountId: session.account.id,
              folderId: folder.id,
              validity,
              base: {
                accountId: session.account.id,
                folderId: folder.id,
                validity,
                highUid: snapshot.highUid,
                modseq: snapshot.modseq,
                known: encodeKnown(snapshot.known),
                lastReconcileAt: snapshot.lastReconcileAt
              }
            }
        return {
          messages,
          flags: snapshot.flags.slice(offset, nextOffset),
          removedIds: [...new Set([...snapshot.removed.slice(offset, nextOffset), ...lateRemoved])],
          cursor: JSON.stringify(next),
          hasMore,
          presentIds:
            !hasMore && snapshot.full
              ? [...snapshot.known.keys()].map((uid) => imapIdentity(folder.id, validity, uid))
              : undefined,
          reset: snapshot.full && offset === 0
        }
      } finally {
        lock.release()
      }
    })
  }

  private async beginSnapshot(
    client: ImapFlow,
    accountId: string,
    folderId: string,
    previous: ImapCheckpoint | null,
    forceFull: boolean,
    validity: string,
    observedEncoded: string
  ): Promise<ImapSnapshot> {
    if (!client.mailbox) throw new MailError('NOT_FOUND', '邮箱文件夹不存在')
    let base = previous?.validity === validity ? previous : null
    let old = new Map<number, number>()
    if (base) {
      try {
        old = decodeKnown(base.known)
      } catch {
        base = null
      }
    }
    let observed = new Set<number>()
    try {
      observed = new Set(decodeKnown(observedEncoded).keys())
    } catch {
      // A malformed partial observation cannot safely suppress reconciliation.
      base = null
      old.clear()
    }
    const full = forceFull || !base
    // Freeze the SELECT watermark before fetching. Changes arriving during
    // paging remain above this boundary and are replayed on the next pass.
    const modseq =
      client.enabled?.has('CONDSTORE') && !client.mailbox.noModseq && client.mailbox.highestModseq
        ? String(client.mailbox.highestModseq)
        : null
    const condstore =
      !full &&
      modseq !== null &&
      base?.modseq !== null &&
      base?.modseq !== undefined &&
      BigInt(modseq) >= BigInt(base.modseq)
    const known = new Map<number, number>()
    let current: number[] = []
    const changes: NonNullable<SyncPage['flags']> = []
    if (full || condstore) {
      const found = await client.search({ all: true }, { uid: true })
      if (!Array.isArray(found))
        throw new MailError('NETWORK', '无法获取邮箱 UID 集合，请稍后重试。', true)
      current = [...new Set(found.filter(validUid))]
      if (!full) for (const uid of current) known.set(uid, old.get(uid) ?? 0)
      if (condstore) {
        for await (const message of client.fetch(
          '1:*',
          { uid: true, flags: true },
          {
            uid: true,
            changedSince: BigInt(base!.modseq!)
          }
        )) {
          if (known.has(message.uid)) known.set(message.uid, flagBits(message.flags))
        }
      }
    } else {
      // Without persistent mod-sequences this is still O(mailbox size), but
      // requests UID + FLAGS only, never old envelopes or MIME structures.
      for await (const message of client.fetch('1:*', { uid: true, flags: true }, { uid: true })) {
        if (validUid(message.uid)) known.set(message.uid, flagBits(message.flags))
      }
      current = [...known.keys()]
    }
    if (current.length > MAX_CHECKPOINT_UIDS)
      throw new MailError('UNSUPPORTED', '单个文件夹邮件数量超过当前增量检查点支持的上限。')
    if (!full)
      for (const [uid, bits] of known) {
        if (old.has(uid) && old.get(uid) !== bits)
          changes.push({
            remoteId: imapIdentity(folderId, validity, uid),
            isRead: Boolean(bits & 1),
            isStarred: Boolean(bits & 2)
          })
      }
    const present = new Set(current)
    const removed = full
      ? []
      : [...new Set([...old.keys(), ...observed])]
          .filter((uid) => !present.has(uid))
          .map((uid) => imapIdentity(folderId, validity, uid))
    const uids = (
      full ? current : current.filter((uid) => uid > base!.highUid || !old.has(uid))
    ).sort((first, second) => second - first)
    const nextUid = client.mailbox.uidNext - 1
    const highUid = current.reduce(
      (highest, uid) => Math.max(highest, uid),
      Math.max(base?.highUid ?? 0, validUid(nextUid) ? nextUid : 0)
    )
    return {
      token: randomUUID(),
      accountId,
      base,
      validity,
      uids,
      observed,
      known,
      flags: changes,
      removed,
      highUid,
      modseq,
      full,
      lastReconcileAt: Date.now()
    }
  }
  private checkRef(client: ImapFlow, ref: RemoteRef): void {
    if (
      !client.mailbox ||
      !ref.uidValidity ||
      String(client.mailbox.uidValidity) !== ref.uidValidity
    )
      throw new MailError('NOT_FOUND', '邮箱标识已变更，请同步后重新打开邮件')
    if (!/^\d+$/.test(ref.id) || Number(ref.id) < 1)
      throw new MailError('VALIDATION', '无效的 IMAP 邮件标识')
  }
  async fetchBody(session: ProviderSession, ref: RemoteRef): Promise<MessageBody> {
    return this.run(session, async (client) => {
      const lock = await client.getMailboxLock(ref.folderId, { readOnly: true })
      try {
        this.checkRef(client, ref)
        const message = await client.fetchOne(
          ref.id,
          { bodyStructure: true, envelope: true },
          { uid: true }
        )
        if (!message) throw new MailError('NOT_FOUND', '邮件已不存在')
        const all = nodes(message.bodyStructure)
        let text = ''
        let html = ''
        let size = 0
        for (const part of all.filter(
          (part) => !attachment(part) && (part.type === 'text/plain' || part.type === 'text/html')
        )) {
          if ((part.size ?? 0) > MAX_BODY_BYTES)
            throw new MailError('UNSUPPORTED', '邮件正文超过 5 MiB，请使用网页版邮箱查看')
          const result = await client.download(ref.id, part.part || '1', {
            uid: true,
            maxBytes: MAX_BODY_BYTES + 1
          })
          if (!result.content) continue
          const content = await readBounded(result.content, MAX_BODY_BYTES, () =>
            result.content?.destroy()
          )
          size += content.length
          if (size > MAX_BODY_BYTES) throw new MailError('UNSUPPORTED', '邮件正文合计超过 5 MiB')
          if (part.type === 'text/html') html += content.toString('utf8')
          else text += content.toString('utf8')
        }
        return {
          text,
          html: html || null,
          attachments: all.filter(attachment).map((part) => ({
            id: part.part || '1',
            filename: part.dispositionParameters?.filename || part.parameters?.name || 'attachment',
            contentType: part.type,
            size: part.size ?? 0
          })),
          cc: addresses(message.envelope?.cc),
          replyTo: addresses(message.envelope?.replyTo)
        }
      } finally {
        lock.release()
      }
    })
  }
  async fetchAttachment(
    session: ProviderSession,
    ref: RemoteRef,
    attachmentId: string
  ): Promise<DownloadedAttachment> {
    return this.run(session, async (client) => {
      const lock = await client.getMailboxLock(ref.folderId, { readOnly: true })
      try {
        this.checkRef(client, ref)
        const message = await client.fetchOne(ref.id, { bodyStructure: true }, { uid: true })
        const part =
          message &&
          nodes(message.bodyStructure).find(
            (part) => (part.part || '1') === attachmentId && attachment(part)
          )
        if (!part) throw new MailError('NOT_FOUND', '附件不存在')
        if ((part.size ?? 0) > MAX_ATTACHMENT_BYTES * 1.38)
          throw new MailError('UNSUPPORTED', '附件超过 50 MiB，暂不支持下载')
        const result = await client.download(ref.id, attachmentId, {
          uid: true,
          maxBytes: MAX_ATTACHMENT_BYTES + 1,
          decodeText: false
        })
        if (!result.content) throw new MailError('NOT_FOUND', '附件不存在')
        return {
          filename: part.dispositionParameters?.filename || part.parameters?.name || 'attachment',
          contentType: part.type,
          content: await readBounded(result.content, MAX_ATTACHMENT_BYTES, () =>
            result.content?.destroy()
          )
        }
      } finally {
        lock.release()
      }
    })
  }
  async applyAction(session: ProviderSession, action: ProviderAction): Promise<void> {
    await this.run(session, async (client) => {
      const lock = await client.getMailboxLock(action.ref.folderId)
      try {
        this.checkRef(client, action.ref)
        if (action.kind === 'trash') {
          const trash = (await client.list()).find(
            (folder) => folderRole(folder.specialUse || folder.path) === 'trash'
          )
          if (!trash)
            throw new MailError('UNSUPPORTED', '服务器未提供垃圾箱，请在邮箱网页中配置垃圾箱后重试')
          if (trash.path !== action.ref.folderId)
            await client.messageMove(action.ref.id, trash.path, { uid: true })
        } else {
          const flag = action.kind === 'markRead' ? '\\Seen' : '\\Flagged'
          if (action.value) await client.messageFlagsAdd(action.ref.id, [flag], { uid: true })
          else await client.messageFlagsRemove(action.ref.id, [flag], { uid: true })
        }
      } finally {
        lock.release()
      }
    })
  }
  async prepareSend(message: OutgoingMessage): Promise<Uint8Array> {
    return composeRaw(message)
  }
  async send(
    session: ProviderSession,
    message: OutgoingMessage,
    prepared?: Uint8Array
  ): Promise<SendReceipt> {
    const raw = prepared ?? (await this.prepareSend(message))
    if (raw.byteLength > MAX_ATTACHMENT_BYTES)
      throw new MailError('UNSUPPORTED', '原始邮件超过 50 MiB')
    const delivery = smtpDeliveryRaw(raw)
    const smtp = this.smtp(session)
    try {
      const result = await smtp.sendMail({
        envelope: {
          from: message.from,
          to: [...new Set([...message.to, ...message.cc, ...message.bcc])]
        },
        raw: delivery,
        disableUrlAccess: true
      })
      if (result.rejected?.length)
        throw new MailError(
          'SEND_UNCERTAIN',
          '部分收件人被拒绝，其他收件人可能已收到，请核对后单独处理'
        )
    } catch (error) {
      if (error instanceof MailError) throw error
      const smtpError = error as { code?: string; responseCode?: number; command?: string }
      if (smtpError.code === 'EAUTH')
        throw new MailError('AUTH', 'SMTP 授权失败，请检查客户端授权码')
      if (smtpError.responseCode && smtpError.responseCode >= 400)
        throw new MailError(
          'VALIDATION',
          `SMTP 拒绝发送（${smtpError.responseCode}），请检查收件人与服务器限制`
        )
      if (
        ['CONN', 'EHLO', 'HELO', 'STARTTLS', 'AUTH', 'MAIL FROM', 'RCPT TO'].includes(
          smtpError.command ?? ''
        ) ||
        ['EDNS', 'EMESSAGE'].includes(smtpError.code ?? '')
      )
        throw new MailError(
          'VALIDATION',
          'SMTP 连接或投递准备失败，邮件尚未提交。请检查网络、服务器配置与收件人后重试'
        )
      throw new MailError(
        'SEND_UNCERTAIN',
        '发送连接中断，邮件可能已被接受，请核对已发送邮件后再决定是否重发'
      )
    } finally {
      smtp.close()
    }
    return {}
  }
  async saveSentCopy(
    session: ProviderSession,
    message: OutgoingMessage,
    raw: Uint8Array,
    options: { verifyOnly: boolean; receipt?: SendReceipt; assertActive?: () => void }
  ): Promise<SentCopyResult> {
    return this.run(session, async (client) => {
      const folder = (await client.list()).find(
        (folder) =>
          !folder.flags.has('\\Noselect') &&
          !folder.flags.has('\\NonExistent') &&
          folderRole(folder.specialUse || folder.path) === 'sent'
      )
      if (!folder)
        throw new MailError('UNSUPPORTED', '未找到可写入的已发送文件夹，邮件不会重新投递。')
      const lock = await client.getMailboxLock(folder.path, { readOnly: true })
      try {
        if (!client.mailbox)
          throw new MailError('NETWORK', '无法打开已发送文件夹，尚未尝试保存副本。', true)
        const validity = String(client.mailbox.uidValidity)
        const candidates = await client.search(
          { header: { 'message-id': message.messageId } },
          { uid: true }
        )
        if (!Array.isArray(candidates))
          throw new MailError('NETWORK', '无法核验已发送副本，尚未尝试保存。', true)
        if (candidates.length > 1000)
          throw new MailError('UNSUPPORTED', '副本标识匹配过多，尚未尝试保存副本。')
        for (let offset = 0; offset < candidates.length; offset += PAGE_SIZE) {
          for await (const candidate of client.fetch(
            candidates.slice(offset, offset + PAGE_SIZE).join(','),
            { uid: true, headers: ['message-id'] },
            { uid: true }
          )) {
            if (await exactMessageIdHeader(candidate.headers, message.messageId)) {
              return {
                state: 'saved',
                ref: { id: String(candidate.uid), folderId: folder.path, uidValidity: validity }
              }
            }
          }
        }
        if (options.verifyOnly) return { state: 'missing' }
        options.assertActive?.()
        let appended
        try {
          appended = await client.append(
            folder.path,
            Buffer.from(raw),
            ['\\Seen'],
            message.date === undefined ? undefined : new Date(message.date)
          )
        } catch (error) {
          const failure = error as { responseStatus?: string; serverResponseCode?: string }
          if (
            ['NO', 'BAD'].includes(failure.responseStatus?.toUpperCase() ?? '') ||
            failure.serverResponseCode === 'APPENDLIMIT'
          ) {
            throw new MailError(
              'VALIDATION',
              '服务器明确拒绝保存已发送副本，邮件已投递，不会重新发送。'
            )
          }
          return { state: 'uncertain' }
        }
        if (appended === false)
          throw new MailError('NETWORK', '服务器未执行副本保存，邮件已投递，可单独重试保存。', true)
        return {
          state: 'saved',
          ...(appended.uid && appended.uidValidity
            ? {
                ref: {
                  id: String(appended.uid),
                  folderId: folder.path,
                  uidValidity: String(appended.uidValidity)
                }
              }
            : {})
        }
      } finally {
        lock.release()
      }
    })
  }
  private async closeClient(client: ImapFlow): Promise<void> {
    if (!client.usable) {
      client.close()
      return
    }
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        client.logout(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            client.close()
            resolve()
          }, 5000)
          timer.unref()
        })
      ])
    } catch {
      client.close()
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  async watch(session: ProviderSession, onChange: (change: ProviderChange) => void): Promise<void> {
    const version = this.watchVersions.get(session.account.id) ?? 0
    const epoch = this.connectionEpoch
    await this.watchSerial.run(session.account.id, async () => {
      const existing = this.watches.get(session.account.id)
      if (existing && !existing.stopped && existing.client.usable) {
        existing.notify = onChange
        return
      }
      // Discover capabilities on the normal work connection first. A server
      // without IDLE must not consume a second connection for polling.
      const idleSupported = await this.run(
        session,
        async (client) => client.capabilities?.has('IDLE') === true
      )
      if (
        version !== (this.watchVersions.get(session.account.id) ?? 0) ||
        epoch !== this.connectionEpoch
      )
        throw new MailError('CANCELLED', '邮箱监听已取消。')
      if (!idleSupported) return
      const client = this.createClient(session, true)
      const state: ImapWatch = {
        client,
        notify: onChange,
        folderId: 'INBOX',
        armed: false,
        stopped: false
      }
      this.watches.set(session.account.id, state)
      const notify = (path?: string) => {
        if (!state.armed || state.stopped || this.watches.get(session.account.id) !== state) return
        if (path && path.toUpperCase() !== state.folderId.toUpperCase()) return
        try {
          state.notify({ accountId: session.account.id, folderId: path ?? state.folderId })
        } catch {
          /* Observers cannot abort the protocol event handler. */
        }
      }
      const closed = () => {
        if (this.watches.get(session.account.id) !== state) return
        notify()
        state.armed = false
        this.watches.delete(session.account.id)
      }
      client.on('error', () => client.close())
      client.on('close', closed)
      client.on('exists', (event) => {
        if (event.count !== event.prevCount) notify(event.path)
      })
      client.on('expunge', (event) => notify(event.path))
      client.on('flags', (event) => notify(event.path))
      client.on('highestModseq', (event) => notify(event.path))
      try {
        await client.connect()
        if (state.stopped || this.watches.get(session.account.id) !== state)
          throw new MailError('CANCELLED', '邮箱监听已取消。')
        if (!client.capabilities.has('IDLE')) {
          state.stopped = true
          this.watches.delete(session.account.id)
          await this.closeClient(client)
          return
        }
        // This connection never selects another folder. Ignore initial SELECT
        // EXISTS/FLAGS so opening a mailbox cannot schedule a synthetic change.
        const mailbox = await client.mailboxOpen('INBOX', { readOnly: true })
        state.folderId = mailbox?.path || (client.mailbox && client.mailbox.path) || 'INBOX'
        if (state.stopped || this.watches.get(session.account.id) !== state)
          throw new MailError('CANCELLED', '邮箱监听已取消。')
        state.armed = true
        // idle() waits until IDLE ends; watcher readiness must not wait for that.
        // ImapFlow's auto-IDLE/maxIdleTime owns renewal after it finishes.
        void client
          .idle({ whenFree: true })
          .then((result) => {
            if (result === false) client.close()
          })
          .catch(() => client.close())
      } catch (error) {
        state.stopped = true
        if (this.watches.get(session.account.id) === state) this.watches.delete(session.account.id)
        client.close()
        throw providerError(error)
      }
    })
  }
  private stopWatch(accountId: string): ImapFlow | undefined {
    const state = this.watches.get(accountId)
    if (!state) return undefined
    state.stopped = true
    state.armed = false
    this.watches.delete(accountId)
    return state.client
  }
  async disconnectAccount(accountId: string): Promise<void> {
    this.watchVersions.set(accountId, (this.watchVersions.get(accountId) ?? 0) + 1)
    const watcher = this.stopWatch(accountId)
    // Stop a pending SELECT/IDLE immediately, before waiting for ordinary work.
    if (watcher) watcher.close()
    await this.serial.run(accountId, async () => {
      const client = this.clients.get(accountId)
      this.clients.delete(accountId)
      for (const [key, snapshot] of this.snapshots)
        if (snapshot.accountId === accountId) this.snapshots.delete(key)
      if (client) await this.closeClient(client)
    })
  }
  async dispose(): Promise<void> {
    this.connectionEpoch++
    this.snapshots.clear()
    for (const accountId of this.watches.keys()) this.stopWatch(accountId)?.close()
    await Promise.allSettled([...this.clients.values()].map((client) => this.closeClient(client)))
    this.clients.clear()
  }
}
