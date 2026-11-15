import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { MailError } from '../../shared/model'
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
  MailAddress,
  MailFolder,
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
} from '../../shared/model'
import type {
  ActionPayload,
  AccountProfilePatch,
  MailStore,
  PreparedSend,
  SendPayload,
  SentCopyPatch,
  SentCopyWork,
  StoredMessage,
  SyncSchedule
} from '../../core/store'
import type {
  RemoteFolder,
  RemoteMessage,
  RemoteRef,
  SendReceipt,
  SyncPage
} from '../../core/ports'
import * as schema from './schema'
import { migrate } from './migrations'

type Row = Record<string, unknown>
type OperationPosition = [createdAt: number, id: string]
interface OperationsCursor {
  version: 1
  accountId: string | null
  before: OperationPosition
  through: OperationPosition
}
function operationPosition(value: unknown): value is OperationPosition {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isSafeInteger(value[0]) &&
    value[0] >= 0 &&
    typeof value[1] === 'string' &&
    value[1].length > 0 &&
    value[1].length <= 512
  )
}
function operationsCursor(input: ListOperationsInput): OperationsCursor | null {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
    throw new MailError('VALIDATION', '操作列表每页数量无效。')
  if (input.cursor === undefined) return null
  try {
    if (input.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error()
    const cursor = JSON.parse(
      Buffer.from(input.cursor, 'base64url').toString('utf8')
    ) as Partial<OperationsCursor> | null
    if (
      !cursor ||
      cursor.version !== 1 ||
      cursor.accountId !== (input.accountId ?? null) ||
      !operationPosition(cursor.before) ||
      !operationPosition(cursor.through) ||
      cursor.before[0] > cursor.through[0] ||
      (cursor.before[0] === cursor.through[0] && cursor.before[1] > cursor.through[1])
    )
      throw new Error()
    return cursor as OperationsCursor
  } catch {
    throw new MailError('VALIDATION', '操作列表分页位置无效，请返回第一页。')
  }
}
const json = <T>(value: unknown): T => JSON.parse(String(value)) as T
function missing(): never {
  throw new MailError('NOT_FOUND', '请求的数据不存在，或不属于当前账号。')
}
function draftContent(draft: DraftInput): string {
  return JSON.stringify({
    accountId: draft.accountId,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    text: draft.text,
    html: draft.html,
    attachmentIds: draft.attachmentIds
  })
}

export class SqliteStore implements MailStore {
  private readonly raw: Database.Database
  private readonly orm: ReturnType<typeof drizzle<typeof schema>>

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
    this.raw = new Database(dbPath)
    this.raw.pragma('foreign_keys = ON')
    this.raw.pragma('journal_mode = WAL')
    this.raw.pragma('busy_timeout = 5000')
    try {
      migrate(this.raw)
    } catch (error) {
      this.raw.close()
      throw error
    }
    this.orm = drizzle(this.raw, { schema })
  }

  close(): void {
    this.raw.close()
  }

  listAccounts(): Account[] {
    return this.orm
      .select()
      .from(schema.accounts)
      .all()
      .map((row) => this.account(row))
  }
  private account(row: typeof schema.accounts.$inferSelect): Account {
    const { config: _config, ...account } = row
    return account as Account
  }
  getConnection(accountId: string): AccountConnection | null {
    const row = this.orm
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .get()
    return row ? { account: this.account(row), config: json<ProviderConfig>(row.config) } : null
  }
  findAccount(provider: ProviderKind, email: string): Account | null {
    return (
      this.listAccounts().find(
        (account) =>
          account.provider === provider && account.email.toLowerCase() === email.toLowerCase()
      ) ?? null
    )
  }
  insertAccount(account: Account, config: ProviderConfig): void {
    this.orm
      .insert(schema.accounts)
      .values({ ...account, config: JSON.stringify(config) })
      .run()
  }
  updateConfig(accountId: string, config: ProviderConfig): void {
    this.orm
      .update(schema.accounts)
      .set({ config: JSON.stringify(config) })
      .where(eq(schema.accounts.id, accountId))
      .run()
  }
  updateAccount(
    accountId: string,
    patch: { status: AccountStatus; error?: string | null; lastSyncAt?: number }
  ): void {
    this.orm.update(schema.accounts).set(patch).where(eq(schema.accounts.id, accountId)).run()
  }
  updateAccountProfile(accountId: string, patch: AccountProfilePatch): Account {
    if (!this.getConnection(accountId)) missing()
    const values = { name: patch.name, color: patch.color, hidden: patch.hidden }
    if (Object.values(values).every((value) => value === undefined))
      throw new MailError('VALIDATION', '请至少修改一项账号设置。')
    this.orm.update(schema.accounts).set(values).where(eq(schema.accounts.id, accountId)).run()
    return this.getConnection(accountId)!.account
  }
  removeAccount(accountId: string): void {
    if (!this.getConnection(accountId)) missing()
    this.raw.transaction(() => {
      // Queue only assets associated with this account. Freshly picked, unsaved
      // assets belonging to another composer are intentionally left untouched.
      this.raw
        .prepare(
          `INSERT OR IGNORE INTO asset_gc(asset_id,queued_at)
        SELECT a.id,? FROM assets a WHERE
        EXISTS(SELECT 1 FROM drafts d,json_each(d.content_json,'$.attachmentIds') ref WHERE d.account_id=? AND ref.value=a.id)
        OR EXISTS(SELECT 1 FROM operations o,json_each(o.payload_json,'$.draft.attachmentIds') ref WHERE o.account_id=? AND o.kind='send' AND ref.value=a.id)`
        )
        .run(Date.now(), accountId, accountId)
      this.orm.delete(schema.accounts).where(eq(schema.accounts.id, accountId)).run()
    })()
  }
  snapshot(): AppSnapshot {
    return {
      accounts: this.listAccounts(),
      folders: this.raw
        .prepare(this.folderQuery())
        .all()
        .map((row) => this.folder(row as Row)),
      pendingOperations: Number(
        (
          this.raw
            .prepare(
              `SELECT COUNT(*) n FROM operations o WHERE state IN ('queued','running','failed','uncertain')
              OR EXISTS(SELECT 1 FROM outgoing_sends s WHERE s.operation_id=o.id AND s.accepted_at IS NOT NULL AND s.archive_state!='saved')`
            )
            .get() as Row
        ).n
      )
    }
  }

  private folderQuery(): string {
    return `SELECT f.*, (SELECT COUNT(*) FROM memberships mm JOIN messages m ON m.id=mm.message_id WHERE mm.folder_id=f.id AND m.is_read=0) unread_count FROM folders f`
  }
  private folder(row: Row): MailFolder {
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      remoteId: String(row.remote_id),
      name: String(row.name),
      role: row.role as MailFolder['role'],
      unreadCount: Number(row.unread_count ?? 0)
    }
  }
  listFolders(accountId: string): MailFolder[] {
    return this.raw
      .prepare(`${this.folderQuery()} WHERE f.account_id=? ORDER BY f.name`)
      .all(accountId)
      .map((row) => this.folder(row as Row))
  }
  replaceFolders(accountId: string, folders: RemoteFolder[]): MailFolder[] {
    if (!this.getConnection(accountId)) missing()
    this.raw.transaction(() => {
      const keep = new Set(folders.map((folder) => folder.id))
      for (const folder of folders) {
        this.raw
          .prepare(
            `INSERT INTO folders(id,account_id,remote_id,name,role) VALUES(?,?,?,?,?)
          ON CONFLICT(account_id,remote_id) DO UPDATE SET name=excluded.name,role=excluded.role`
          )
          .run(randomUUID(), accountId, folder.id, folder.name, folder.role)
      }
      for (const folder of this.listFolders(accountId))
        if (!keep.has(folder.remoteId))
          this.raw
            .prepare('DELETE FROM folders WHERE id=? AND account_id=?')
            .run(folder.id, accountId)
    })()
    return this.listFolders(accountId)
  }
  checkpoint(accountId: string, folderId: string): string | null {
    const row = this.raw
      .prepare('SELECT cursor FROM sync_state WHERE account_id=? AND folder_id=?')
      .get(accountId, folderId) as Row | undefined
    return row?.cursor === null || !row ? null : String(row.cursor)
  }

  syncSchedule(accountId: string): SyncSchedule {
    if (!this.getConnection(accountId)) missing()
    const row = this.raw
      .prepare('SELECT * FROM account_sync_state WHERE account_id=?')
      .get(accountId) as Row | undefined
    return row
      ? {
          failures: Number(row.failures),
          nextAttemptAt: Number(row.next_attempt_at),
          lastReconcileAt: row.last_reconcile_at === null ? null : Number(row.last_reconcile_at)
        }
      : { failures: 0, nextAttemptAt: 0, lastReconcileAt: null }
  }
  updateSyncSchedule(accountId: string, schedule: SyncSchedule): void {
    if (!this.getConnection(accountId)) missing()
    this.raw
      .prepare(
        `INSERT INTO account_sync_state(account_id,failures,next_attempt_at,last_reconcile_at) VALUES(?,?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET failures=excluded.failures,next_attempt_at=excluded.next_attempt_at,last_reconcile_at=excluded.last_reconcile_at`
      )
      .run(accountId, schedule.failures, schedule.nextAttemptAt, schedule.lastReconcileAt)
  }
  applySyncPage(accountId: string, folderId: string, page: SyncPage): boolean {
    const folder = this.raw
      .prepare('SELECT * FROM folders WHERE account_id=? AND id=?')
      .get(accountId, folderId) as Row | undefined
    if (!folder) missing()
    return this.raw.transaction(() => {
      const before = Number((this.raw.prepare('SELECT total_changes() n').get() as Row).n)
      for (const remote of page.messages)
        this.mergeMessage(accountId, folderId, String(folder.role), remote)
      for (const patch of page.flags ?? []) {
        const message = this.raw
          .prepare('SELECT id,is_read,is_starred FROM messages WHERE account_id=? AND remote_id=?')
          .get(accountId, patch.remoteId) as Row | undefined
        if (!message) continue
        const messageId = String(message.id)
        const readIntent = this.latestIntent(accountId, messageId, 'markRead')
        const starIntent = this.latestIntent(accountId, messageId, 'star')
        const isRead = readIntent
          ? Number(Boolean((readIntent.payload as ActionPayload).value))
          : patch.isRead === undefined
            ? Number(message.is_read)
            : Number(patch.isRead)
        const isStarred = starIntent
          ? Number(Boolean((starIntent.payload as ActionPayload).value))
          : patch.isStarred === undefined
            ? Number(message.is_starred)
            : Number(patch.isStarred)
        this.raw
          .prepare(
            'UPDATE messages SET is_read=?,is_starred=? WHERE account_id=? AND id=? AND (is_read!=? OR is_starred!=?)'
          )
          .run(isRead, isStarred, accountId, messageId, isRead, isStarred)
      }
      const removeMembership = this.raw.prepare(
        'DELETE FROM memberships WHERE account_id=? AND folder_id=? AND message_id=?'
      )
      for (const remoteId of page.removedIds) {
        const message = this.raw
          .prepare('SELECT id FROM messages WHERE account_id=? AND remote_id=?')
          .get(accountId, remoteId) as Row | undefined
        if (message && !this.pendingTrash(accountId, String(message.id)))
          removeMembership.run(accountId, folderId, message.id)
      }
      // Never treat an intermediate page or reset signal as a full snapshot.
      if (page.presentIds && !page.hasMore) {
        const present = new Set(page.presentIds)
        const current = this.raw
          .prepare(
            'SELECT m.id,m.remote_id FROM messages m JOIN memberships mm ON mm.message_id=m.id WHERE mm.account_id=? AND mm.folder_id=?'
          )
          .all(accountId, folderId) as Row[]
        for (const row of current)
          if (!present.has(String(row.remote_id)) && !this.pendingTrash(accountId, String(row.id)))
            removeMembership.run(accountId, folderId, row.id)
      }
      const changed =
        Number((this.raw.prepare('SELECT total_changes() n').get() as Row).n) !== before
      this.raw
        .prepare(
          `INSERT INTO sync_state(account_id,folder_id,cursor,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(folder_id) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at`
        )
        .run(accountId, folderId, page.cursor, Date.now())
      return changed
    })()
  }

  finishSync(accountId: string): void {
    // Reconcile identity after all folders, including a MOVE's destination.
    this.raw.transaction(() => {
      this.removeOrphans(accountId)
    })()
  }

  private latestIntent(
    accountId: string,
    messageId: string,
    kind: Operation['kind']
  ): Operation | null {
    const row = this.raw
      .prepare(
        `SELECT o.* FROM operation_targets target JOIN operations o ON o.id=target.operation_id
      WHERE target.account_id=? AND o.kind=? AND target.message_id=? ORDER BY o.created_at DESC LIMIT 1`
      )
      .get(accountId, kind, messageId) as Row | undefined
    if (!row || row.state === 'succeeded') return null
    return this.operation(row)
  }
  private pendingTrash(accountId: string, messageId: string): boolean {
    return this.latestIntent(accountId, messageId, 'trash') !== null
  }
  private mergeMessage(
    accountId: string,
    folderId: string,
    role: string,
    remote: RemoteMessage
  ): void {
    const existing = this.raw
      .prepare('SELECT id FROM messages WHERE account_id=? AND remote_id=?')
      .get(accountId, remote.remoteId) as Row | undefined
    const outgoing = this.matchOutgoing(accountId, role, remote)
    const id = outgoing
      ? String(outgoing.local_message_id)
      : existing
        ? String(existing.id)
        : randomUUID()
    if (existing && String(existing.id) !== id)
      this.adoptMessageId(accountId, String(existing.id), id)
    const readIntent = this.latestIntent(accountId, id, 'markRead')
    const starIntent = this.latestIntent(accountId, id, 'star')
    const isRead = readIntent ? Boolean((readIntent.payload as ActionPayload).value) : remote.isRead
    const isStarred = starIntent
      ? Boolean((starIntent.payload as ActionPayload).value)
      : remote.isStarred
    this.raw
      .prepare(
        `INSERT INTO messages(id,account_id,remote_id,subject,from_json,to_json,date,snippet,is_read,is_starred,has_attachments,internet_message_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,remote_id) DO UPDATE SET subject=excluded.subject,
      from_json=excluded.from_json,to_json=excluded.to_json,date=excluded.date,snippet=excluded.snippet,is_read=excluded.is_read,
      is_starred=excluded.is_starred,has_attachments=excluded.has_attachments,internet_message_id=excluded.internet_message_id`
      )
      .run(
        id,
        accountId,
        remote.remoteId,
        remote.subject,
        JSON.stringify(remote.from),
        JSON.stringify(remote.to),
        remote.date,
        remote.snippet,
        Number(isRead),
        Number(isStarred),
        Number(remote.hasAttachments),
        remote.internetMessageId ?? null
      )
    if (outgoing) {
      // Only a real Sent membership completes reconciliation. A receipt can
      // identify a Gmail message first encountered under another label.
      this.raw
        .prepare(
          `UPDATE outgoing_sends SET remote_id=?,bound=CASE WHEN ?='sent' THEN 1 ELSE bound END,
        archive_state=CASE WHEN ?='sent' THEN 'saved' ELSE archive_state END,
        archive_error=CASE WHEN ?='sent' THEN NULL ELSE archive_error END,
        archive_ref_json=CASE WHEN ?='sent' THEN ? ELSE archive_ref_json END
        WHERE operation_id=?`
        )
        .run(
          remote.remoteId,
          role,
          role,
          role,
          role,
          JSON.stringify(remote.ref),
          outgoing.operation_id
        )
      const body = this.outgoingBody(outgoing)
      this.raw
        .prepare(
          'UPDATE messages SET body_json=COALESCE(body_json,?),has_attachments=CASE WHEN ? THEN 1 ELSE has_attachments END WHERE account_id=? AND id=?'
        )
        .run(JSON.stringify(body), Number(body.attachments.length > 0), accountId, id)
    }
    if (!this.pendingTrash(accountId, id) || role === 'trash') {
      this.raw
        .prepare(
          `INSERT INTO memberships(account_id,message_id,folder_id,ref_json) VALUES(?,?,?,?)
        ON CONFLICT(message_id,folder_id) DO UPDATE SET ref_json=excluded.ref_json`
        )
        .run(accountId, id, folderId, JSON.stringify(remote.ref))
      this.raw
        .prepare('DELETE FROM orphan_markers WHERE account_id=? AND message_id=?')
        .run(accountId, id)
    }
  }

  private matchOutgoing(accountId: string, role: string, remote: RemoteMessage): Row | undefined {
    const candidates = this.raw
      .prepare(
        `SELECT s.*,o.payload_json FROM outgoing_sends s JOIN operations o ON o.id=s.operation_id
      WHERE s.account_id=? AND s.accepted_at IS NOT NULL AND
      (s.remote_id=? OR (?='sent' AND (s.internet_message_id=? OR
        (json_extract(s.archive_ref_json,'$.id')=? AND json_extract(s.archive_ref_json,'$.folderId')=?))))
      ORDER BY CASE WHEN s.remote_id=? THEN 0 ELSE 1 END,s.accepted_at`
      )
      .all(
        accountId,
        remote.remoteId,
        role,
        remote.internetMessageId ?? '',
        remote.ref.id,
        remote.ref.folderId,
        remote.remoteId
      ) as Row[]
    return candidates.find((candidate) => {
      if (candidate.remote_id === remote.remoteId) return true
      const canonical = this.raw
        .prepare('SELECT remote_id FROM messages WHERE account_id=? AND id=?')
        .get(accountId, candidate.local_message_id) as Row | undefined
      // Do not collapse two different real copies merely because their headers
      // contain the same Message-ID. An unbound record can claim its first copy.
      if (canonical && canonical.remote_id !== remote.remoteId) return false
      const ref = candidate.archive_ref_json ? json<RemoteRef>(candidate.archive_ref_json) : null
      const sameRef =
        ref?.id === remote.ref.id &&
        ref.folderId === remote.ref.folderId &&
        (ref.uidValidity ?? null) === (remote.ref.uidValidity ?? null)
      const from = json<MailAddress[]>(candidate.from_json)
      return (
        sameRef ||
        (remote.internetMessageId === candidate.internet_message_id &&
          remote.from.some((address) =>
            from.some((sender) => sender.address.toLowerCase() === address.address.toLowerCase())
          ))
      )
    })
  }

  private adoptMessageId(accountId: string, previousId: string, nextId: string): void {
    // A copy can have appeared under another label before Sent is visited.
    // Preserve the ID already shown for the local outgoing record, including
    // any pending intentions attached to the earlier remote representation.
    this.raw.pragma('defer_foreign_keys = ON')
    const operations = this.raw
      .prepare(
        `SELECT o.* FROM operations o JOIN operation_targets t ON t.operation_id=o.id
      WHERE t.account_id=? AND t.message_id=?`
      )
      .all(accountId, previousId) as Row[]
    this.raw
      .prepare('UPDATE messages SET id=? WHERE account_id=? AND id=?')
      .run(nextId, accountId, previousId)
    this.raw
      .prepare('UPDATE memberships SET message_id=? WHERE account_id=? AND message_id=?')
      .run(nextId, accountId, previousId)
    for (const row of operations) {
      const payload = json<ActionPayload>(row.payload_json)
      payload.targets = payload.targets.map((target) => ({
        ...target,
        messageId: target.messageId === previousId ? nextId : target.messageId
      }))
      if (payload.completedMessageIds)
        payload.completedMessageIds = payload.completedMessageIds.map((id) =>
          id === previousId ? nextId : id
        )
      this.raw
        .prepare('UPDATE operations SET message_ids_json=?,payload_json=? WHERE id=?')
        .run(
          JSON.stringify(
            json<string[]>(row.message_ids_json).map((id) => (id === previousId ? nextId : id))
          ),
          JSON.stringify(payload),
          row.id
        )
    }
    this.raw
      .prepare('UPDATE operation_targets SET message_id=? WHERE account_id=? AND message_id=?')
      .run(nextId, accountId, previousId)
    this.raw
      .prepare('UPDATE orphan_markers SET message_id=? WHERE account_id=? AND message_id=?')
      .run(nextId, accountId, previousId)
  }
  private removeOrphans(accountId: string): void {
    // A targeted delta can observe a move before its destination becomes
    // visible. Retain identity/body across later rounds and process restarts.
    this.raw
      .prepare(
        `DELETE FROM orphan_markers WHERE account_id=? AND
      EXISTS(SELECT 1 FROM memberships mm WHERE mm.account_id=? AND mm.message_id=orphan_markers.message_id)`
      )
      .run(accountId, accountId)
    this.raw
      .prepare(
        `INSERT OR IGNORE INTO orphan_markers(message_id,account_id,detected_at)
      SELECT id,account_id,? FROM messages WHERE account_id=? AND
      NOT EXISTS(SELECT 1 FROM memberships mm WHERE mm.message_id=messages.id)`
      )
      .run(Date.now(), accountId)
    this.raw
      .prepare(
        `DELETE FROM messages WHERE account_id=? AND NOT EXISTS(SELECT 1 FROM memberships WHERE message_id=messages.id)
      AND EXISTS(SELECT 1 FROM orphan_markers marker WHERE marker.message_id=messages.id AND marker.detected_at<=?)
      AND NOT EXISTS(SELECT 1 FROM operation_targets target JOIN operations o ON o.id=target.operation_id
        WHERE target.account_id=messages.account_id AND target.message_id=messages.id AND o.state!='succeeded')`
      )
      .run(accountId, Date.now() - 24 * 60 * 60_000)
  }

  listMessages(input: ListMessagesInput): MessagePage {
    if (input.accountId && !this.getConnection(input.accountId)) missing()
    // Account visibility is applied before cursor/LIMIT, including local Sent
    // copies. Hidden accounts keep syncing and retain their stored identities.
    const where = ['EXISTS(SELECT 1 FROM accounts a WHERE a.id=m.account_id AND a.hidden=0)']
    const params: unknown[] = []
    // Apply the unread predicate in SQLite before both cursor and LIMIT. A
    // client-side page filter would hide older unread mail behind read items.
    if (input.unreadOnly) where.push('m.is_read=0')
    if (input.accountId) {
      where.push('m.account_id=?')
      params.push(input.accountId)
    }
    if (input.folderId) {
      const folder = this.raw
        .prepare('SELECT account_id,role FROM folders WHERE id=?')
        .get(input.folderId) as Row | undefined
      if (!folder || (input.accountId && folder.account_id !== input.accountId)) missing()
      if (folder.role === 'sent') {
        where.push(
          '(EXISTS(SELECT 1 FROM memberships mm WHERE mm.message_id=m.id AND mm.folder_id=?) OR (m.local_sent=1 AND m.account_id=?))'
        )
        params.push(input.folderId, folder.account_id)
      } else {
        where.push(
          'EXISTS(SELECT 1 FROM memberships mm WHERE mm.message_id=m.id AND mm.folder_id=?)'
        )
        params.push(input.folderId)
      }
    } else if (input.view === 'starred') {
      where.push(
        'm.is_starred=1',
        "NOT EXISTS(SELECT 1 FROM memberships mm JOIN folders f ON f.id=mm.folder_id WHERE mm.message_id=m.id AND f.role='trash')"
      )
    } else if (input.view !== 'all') {
      where.push(
        input.view === 'sent'
          ? '(m.local_sent=1 OR EXISTS(SELECT 1 FROM memberships mm JOIN folders f ON f.id=mm.folder_id WHERE mm.message_id=m.id AND f.role=?))'
          : 'EXISTS(SELECT 1 FROM memberships mm JOIN folders f ON f.id=mm.folder_id WHERE mm.message_id=m.id AND f.role=?)'
      )
      params.push(input.view)
    }
    if (input.search?.trim()) {
      // Search is intentionally metadata-only; LIKE wildcards are escaped and all values are bound.
      const term = `%${input.search.trim().replace(/[\\%_]/g, (value) => `\\${value}`)}%`
      where.push(
        "(m.subject LIKE ? ESCAPE '\\' OR m.from_json LIKE ? ESCAPE '\\' OR m.to_json LIKE ? ESCAPE '\\' OR m.snippet LIKE ? ESCAPE '\\')"
      )
      params.push(term, term, term, term)
    }
    if (input.cursor) {
      let cursor: { date: number; id: string }
      try {
        cursor = JSON.parse(
          Buffer.from(input.cursor, 'base64url').toString('utf8')
        ) as typeof cursor
        if (!Number.isFinite(cursor.date) || typeof cursor.id !== 'string') throw new Error()
      } catch {
        throw new MailError('VALIDATION', '邮件分页位置无效，请刷新列表。')
      }
      where.push('(m.date<? OR (m.date=? AND m.id<?))')
      params.push(cursor.date, cursor.date, cursor.id)
    }
    const rows = this.raw
      .prepare(
        `WITH visible_messages AS (
          SELECT m.*,0 local_only,EXISTS(SELECT 1 FROM outgoing_sends s WHERE s.account_id=m.account_id
            AND s.local_message_id=m.id AND s.accepted_at IS NOT NULL AND s.bound=0) local_sent
          FROM messages m WHERE EXISTS(SELECT 1 FROM memberships visible WHERE visible.message_id=m.id AND visible.account_id=m.account_id)
          UNION ALL
          SELECT s.local_message_id,s.account_id,NULL,json_extract(o.payload_json,'$.draft.subject'),s.from_json,
            (SELECT json_group_array(json_object('address',value)) FROM json_each(o.payload_json,'$.draft.to')),
            s.date,substr(json_extract(o.payload_json,'$.draft.text'),1,180),1,0,
            json_array_length(o.payload_json,'$.draft.attachmentIds')>0,s.internet_message_id,NULL,1,1
          FROM outgoing_sends s JOIN operations o ON o.id=s.operation_id
          WHERE s.accepted_at IS NOT NULL AND s.bound=0 AND NOT EXISTS(
            SELECT 1 FROM messages existing JOIN memberships mm ON mm.message_id=existing.id
            WHERE existing.account_id=s.account_id AND existing.id=s.local_message_id)
        ) SELECT m.* FROM visible_messages m WHERE ${where.join(' AND ')} ORDER BY m.date DESC,m.id DESC LIMIT ?`
      )
      .all(...params, input.limit + 1) as Row[]
    const hasMore = rows.length > input.limit
    const items = rows.slice(0, input.limit).map((row) => this.summary(row))
    const last = items.at(-1)
    return {
      items,
      nextCursor:
        hasMore && last
          ? Buffer.from(JSON.stringify({ date: last.date, id: last.id })).toString('base64url')
          : null
    }
  }
  private summary(row: Row): MessageSummary {
    const outgoing = this.outgoingForMessage(String(row.account_id), String(row.id))
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      subject: String(row.subject),
      from: json(row.from_json),
      to: json(row.to_json),
      date: Number(row.date),
      snippet: String(row.snippet),
      isRead: Boolean(row.is_read),
      isStarred: Boolean(row.is_starred),
      hasAttachments: Boolean(row.has_attachments),
      ...(row.local_only ? { localOnly: true } : {}),
      ...(outgoing ? { sentCopy: this.sentCopy(outgoing) } : {}),
      folderIds: (
        this.raw
          .prepare(
            'SELECT folder_id FROM memberships WHERE account_id=? AND message_id=? ORDER BY folder_id'
          )
          .all(row.account_id, row.id) as Row[]
      ).map((item) => String(item.folder_id))
    }
  }
  getMessage(accountId: string, messageId: string): StoredMessage {
    const row = this.raw
      .prepare('SELECT * FROM messages WHERE account_id=? AND id=?')
      .get(accountId, messageId) as Row | undefined
    const membership = this.raw
      .prepare(
        `SELECT mm.ref_json FROM memberships mm JOIN folders f ON f.id=mm.folder_id
      WHERE mm.account_id=? AND mm.message_id=? ORDER BY CASE f.role WHEN 'inbox' THEN 0 WHEN 'trash' THEN 2 ELSE 1 END LIMIT 1`
      )
      .get(accountId, messageId) as Row | undefined
    const outgoing = this.outgoingForMessage(accountId, messageId)
    if ((!row || !membership) && outgoing && !outgoing.bound) {
      const { draft } = json<SendPayload>(outgoing.payload_json)
      return {
        summary: {
          id: messageId,
          accountId,
          subject: draft.subject,
          from: json<MailAddress[]>(outgoing.from_json),
          to: draft.to.map((address) => ({ address })),
          date: Number(outgoing.date),
          snippet: draft.text.slice(0, 180),
          isRead: true,
          isStarred: false,
          hasAttachments: draft.attachmentIds.length > 0,
          folderIds: [],
          localOnly: true,
          sentCopy: this.sentCopy(outgoing)
        },
        body: this.outgoingBody(outgoing),
        ref: null
      }
    }
    if (!row || !membership) missing()
    return {
      summary: this.summary(row),
      body: row.body_json
        ? json<MessageBody>(row.body_json)
        : outgoing
          ? this.outgoingBody(outgoing)
          : null,
      ref: json<RemoteRef>(membership.ref_json)
    }
  }

  private outgoingForMessage(accountId: string, messageId: string): Row | undefined {
    return this.raw
      .prepare(
        `SELECT s.*,o.payload_json FROM outgoing_sends s JOIN operations o ON o.id=s.operation_id
      WHERE s.account_id=? AND s.local_message_id=? AND s.accepted_at IS NOT NULL`
      )
      .get(accountId, messageId) as Row | undefined
  }

  private sentCopy(row: Row): NonNullable<Operation['sentCopy']> {
    return {
      state: row.archive_state as SentCopyState,
      error: row.archive_error === null ? null : String(row.archive_error)
    }
  }

  private outgoingBody(row: Row): MessageBody {
    const { draft } = json<SendPayload>(row.payload_json)
    return {
      text: draft.text,
      html: draft.html,
      cc: draft.cc.map((address) => ({ address })),
      attachments: draft.attachmentIds.map((id) => ({
        ...this.getAsset(id),
        contentType: 'application/octet-stream'
      }))
    }
  }

  localAttachment(
    accountId: string,
    messageId: string,
    attachmentId: string
  ): DraftAttachment | null {
    const outgoing = this.outgoingForMessage(accountId, messageId)
    if (!outgoing) return null
    const { draft } = json<SendPayload>(outgoing.payload_json)
    return draft.attachmentIds.includes(attachmentId) ? this.getAsset(attachmentId) : null
  }
  cacheBody(accountId: string, messageId: string, body: MessageBody): void {
    const result = this.raw
      .prepare('UPDATE messages SET body_json=?,has_attachments=? WHERE account_id=? AND id=?')
      .run(JSON.stringify(body), Number(body.attachments.length > 0), accountId, messageId)
    if (!result.changes) missing()
  }

  private operation(row: Row): Operation {
    const outgoing = this.raw
      .prepare('SELECT * FROM outgoing_sends WHERE operation_id=? AND accepted_at IS NOT NULL')
      .get(row.id) as Row | undefined
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      kind: row.kind as Operation['kind'],
      state: row.state as OperationState,
      messageIds: json<string[]>(row.message_ids_json),
      payload: json(row.payload_json),
      ...(outgoing ? { sentCopy: this.sentCopy(outgoing) } : {}),
      attempts: Number(row.attempts),
      error: row.error === null ? null : String(row.error),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      nextAttemptAt: Number(row.next_attempt_at)
    }
  }
  findRequest(accountId: string, requestId: string, fingerprint: string): Operation | null {
    const row = this.raw
      .prepare('SELECT * FROM operations WHERE account_id=? AND request_id=?')
      .get(accountId, requestId) as Row | undefined
    if (row && row.fingerprint !== fingerprint)
      throw new MailError('VALIDATION', '同一个请求标识不能用于不同的操作。')
    return row ? this.operation(row) : null
  }
  private insertOperation(
    accountId: string,
    requestId: string,
    fingerprint: string,
    kind: Operation['kind'],
    messageIds: string[],
    payload: unknown
  ): Operation {
    const latest = Number(
      (this.raw.prepare('SELECT COALESCE(MAX(created_at),0) n FROM operations').get() as Row).n
    )
    const now = Date.now()
    // Intention ordering must stay strict without postponing an immediately due operation.
    const createdAt = Math.max(now, latest + 1)
    const id = randomUUID()
    this.raw
      .prepare(
        `INSERT INTO operations(id,account_id,request_id,fingerprint,kind,state,message_ids_json,payload_json,attempts,error,created_at,updated_at,next_attempt_at)
      VALUES(?,?,?,?,?,'queued',?,?,0,NULL,?,?,?)`
      )
      .run(
        id,
        accountId,
        requestId,
        fingerprint,
        kind,
        JSON.stringify(messageIds),
        JSON.stringify(payload),
        createdAt,
        now,
        now
      )
    for (const messageId of new Set(messageIds))
      this.raw
        .prepare('INSERT INTO operation_targets(operation_id,account_id,message_id) VALUES(?,?,?)')
        .run(id, accountId, messageId)
    return this.getOperation(id)
  }
  enqueueAction(input: MailActionInput, fingerprint: string): Operation {
    return this.raw.transaction(() => {
      const previous = this.findRequest(input.accountId, input.requestId, fingerprint)
      if (previous) return previous
      const targets = [...new Set(input.messageIds)].map((messageId) => {
        const ref = this.getMessage(input.accountId, messageId).ref
        if (!ref)
          throw new MailError('UNSUPPORTED', '此邮件的远端副本尚未同步，暂不能更改远端状态。')
        return { messageId, ref }
      })
      const operation = this.insertOperation(
        input.accountId,
        input.requestId,
        fingerprint,
        input.action,
        targets.map((target) => target.messageId),
        { value: input.value, targets } satisfies ActionPayload
      )
      if (input.action === 'trash') {
        const trash = this.listFolders(input.accountId).find((folder) => folder.role === 'trash')
        if (!trash)
          throw new MailError('UNSUPPORTED', '此账号没有可用的垃圾箱，请先完成文件夹同步。')
        for (const target of targets) {
          this.raw
            .prepare('DELETE FROM memberships WHERE account_id=? AND message_id=?')
            .run(input.accountId, target.messageId)
          this.raw
            .prepare(
              'INSERT INTO memberships(account_id,message_id,folder_id,ref_json) VALUES(?,?,?,?)'
            )
            .run(input.accountId, target.messageId, trash.id, JSON.stringify(target.ref))
        }
      } else {
        const column = input.action === 'markRead' ? 'is_read' : 'is_starred'
        for (const target of targets)
          this.raw
            .prepare(`UPDATE messages SET ${column}=? WHERE account_id=? AND id=?`)
            .run(Number(input.value), input.accountId, target.messageId)
      }
      return operation
    })()
  }
  enqueueSend(input: SendInput, fingerprint: string): Operation {
    return this.raw.transaction(() => {
      const previous = this.findRequest(input.accountId, input.requestId, fingerprint)
      if (previous) return previous
      if (!this.getConnection(input.accountId)) missing()
      if (input.id) {
        const draft = this.raw.prepare('SELECT account_id FROM drafts WHERE id=?').get(input.id) as
          Row | undefined
        if (draft && draft.account_id !== input.accountId) missing()
        const active = this.raw
          .prepare(
            `SELECT id FROM operations WHERE account_id=? AND kind='send' AND state IN ('queued','running','uncertain') AND json_extract(payload_json,'$.draft.id')=?`
          )
          .get(input.accountId, input.id)
        if (active) throw new MailError('VALIDATION', '这份草稿已有发送任务，请先查看发送状态。')
      }
      for (const assetId of input.attachmentIds) this.getAsset(assetId)
      const { requestId: _requestId, ...draft } = input
      return this.insertOperation(input.accountId, input.requestId, fingerprint, 'send', [], {
        draft,
        messageId: `<${randomUUID()}@better-mail.local>`
      } satisfies SendPayload)
    })()
  }

  private ensureOutgoing(operation: Operation, date: number): Row {
    if (operation.kind !== 'send') throw new MailError('VALIDATION', '此操作不是发送任务。')
    const payload = operation.payload as SendPayload
    this.raw
      .prepare(
        `INSERT OR IGNORE INTO outgoing_sends(operation_id,account_id,local_message_id,internet_message_id,date)
      VALUES(?,?,?,?,?)`
      )
      .run(operation.id, operation.accountId, randomUUID(), payload.messageId, date)
    return this.raw
      .prepare('SELECT * FROM outgoing_sends WHERE operation_id=?')
      .get(operation.id) as Row
  }

  prepareSend(operationId: string, raw: Uint8Array, date: number): void {
    if (!Number.isFinite(date) || !Number.isInteger(date) || date < 0 || raw.byteLength === 0)
      throw new MailError('VALIDATION', '发送原文或日期无效。')
    this.raw.transaction(() => {
      const outgoing = this.ensureOutgoing(this.getOperation(operationId), date)
      if (Number(outgoing.date) !== date)
        throw new MailError('VALIDATION', '已冻结的发送日期不能更改。')
      const existing = this.preparedSend(operationId)
      const bytes = Buffer.from(raw)
      if (existing) {
        if (!bytes.equals(Buffer.from(existing.raw)))
          throw new MailError('VALIDATION', '已冻结的发送原文不能更改。')
        return
      }
      this.raw
        .prepare('INSERT INTO outgoing_mime(operation_id,raw) VALUES(?,?)')
        .run(operationId, bytes)
    })()
  }

  preparedSend(operationId: string): PreparedSend | null {
    const row = this.raw
      .prepare(
        `SELECT m.raw,s.date FROM outgoing_mime m JOIN outgoing_sends s ON s.operation_id=m.operation_id
      WHERE m.operation_id=?`
      )
      .get(operationId) as Row | undefined
    return row ? { raw: Uint8Array.from(row.raw as Uint8Array), date: Number(row.date) } : null
  }

  acceptSend(operationId: string, from: MailAddress, receipt?: SendReceipt): void {
    this.raw.transaction(() => {
      const operation = this.getOperation(operationId)
      const outgoing = this.ensureOutgoing(operation, operation.createdAt)
      if (outgoing.accepted_at !== null) return
      let remote = receipt?.remoteId
        ? (this.raw
            .prepare('SELECT id FROM messages WHERE account_id=? AND remote_id=?')
            .get(operation.accountId, receipt.remoteId) as Row | undefined)
        : undefined
      if (!remote) {
        const candidates = this.raw
          .prepare(
            `SELECT DISTINCT m.id FROM messages m JOIN memberships mm ON mm.message_id=m.id
          JOIN folders f ON f.id=mm.folder_id WHERE m.account_id=? AND f.role='sent'
          AND m.internet_message_id=? AND EXISTS(SELECT 1 FROM json_each(m.from_json) sender
            WHERE lower(json_extract(sender.value,'$.address'))=lower(?)) LIMIT 2`
          )
          .all(
            operation.accountId,
            (operation.payload as SendPayload).messageId,
            from.address
          ) as Row[]
        if (candidates.length === 1) remote = candidates[0]
      }
      // A provider receipt may refer to a copy already cached before this
      // checkpoint. No local ID has been exposed before acceptance.
      const localId = remote ? String(remote.id) : String(outgoing.local_message_id)
      const sentMembership = remote
        ? (this.raw
            .prepare(
              `SELECT mm.ref_json FROM memberships mm JOIN folders f ON f.id=mm.folder_id
            WHERE mm.account_id=? AND mm.message_id=? AND f.role='sent' LIMIT 1`
            )
            .get(operation.accountId, localId) as Row | undefined)
        : undefined
      this.raw
        .prepare(
          `UPDATE outgoing_sends SET local_message_id=?,from_json=?,accepted_at=?,archive_state=?,
        archive_error=NULL,archive_next_attempt_at=?,receipt_json=?,remote_id=?,bound=?,archive_ref_json=?
        WHERE operation_id=?`
        )
        .run(
          localId,
          JSON.stringify([from]),
          Date.now(),
          sentMembership ? 'saved' : 'pending',
          Date.now() + 2000,
          receipt ? JSON.stringify(receipt) : null,
          receipt?.remoteId ??
            (remote
              ? (this.raw.prepare('SELECT remote_id FROM messages WHERE id=?').get(localId) as Row)
                  .remote_id
              : null),
          Number(Boolean(sentMembership)),
          sentMembership?.ref_json ?? (receipt?.ref ? JSON.stringify(receipt.ref) : null),
          operationId
        )
      const { draft } = operation.payload as SendPayload
      if (draft.id) {
        const saved = this.raw
          .prepare('SELECT content_json FROM drafts WHERE id=?')
          .get(draft.id) as Row | undefined
        if (saved && draftContent(json<DraftInput>(saved.content_json)) === draftContent(draft))
          this.deleteDraft(draft.id)
      }
      this.updateOperation(operationId, { state: 'succeeded', error: null })
    })()
  }

  nextSentCopy(now: number): SentCopyWork | null {
    const row = this.raw
      .prepare(
        `SELECT s.*,m.raw FROM outgoing_sends s LEFT JOIN outgoing_mime m ON m.operation_id=s.operation_id
      WHERE s.accepted_at IS NOT NULL AND s.archive_state IN ('pending','uncertain')
        AND s.archive_next_attempt_at<=? ORDER BY s.archive_next_attempt_at,s.accepted_at,s.operation_id LIMIT 1`
      )
      .get(now) as Row | undefined
    if (!row) return null
    return {
      operation: this.getOperation(String(row.operation_id)),
      raw: row.raw ? Uint8Array.from(row.raw as Uint8Array) : null,
      date: Number(row.date),
      state: row.archive_state as SentCopyState,
      attempts: Number(row.archive_attempts),
      forceSave: Boolean(row.force_save),
      ...(row.receipt_json ? { receipt: json<SendReceipt>(row.receipt_json) } : {})
    }
  }

  updateSentCopy(operationId: string, patch: SentCopyPatch): void {
    const row = this.raw
      .prepare('SELECT * FROM outgoing_sends WHERE operation_id=? AND accepted_at IS NOT NULL')
      .get(operationId) as Row | undefined
    if (!row) missing()
    // A late verifier/error must not regress a copy already acknowledged by a
    // concurrent Sent snapshot. Remote deletion does not reopen the archive job.
    if (row.archive_state === 'saved' && patch.state !== 'saved') return
    this.raw
      .prepare(
        `UPDATE outgoing_sends SET archive_state=?,archive_error=?,archive_ref_json=?,
      archive_next_attempt_at=?,archive_attempts=? WHERE operation_id=?`
      )
      .run(
        patch.state,
        patch.error === undefined ? row.archive_error : patch.error,
        patch.ref ? JSON.stringify(patch.ref) : row.archive_ref_json,
        patch.nextAttemptAt ?? row.archive_next_attempt_at,
        Number(row.archive_attempts) + Number(Boolean(patch.incrementAttempts)),
        operationId
      )
  }

  retrySentCopy(operationId: string): void {
    const row = this.raw
      .prepare('SELECT * FROM outgoing_sends WHERE operation_id=? AND accepted_at IS NOT NULL')
      .get(operationId) as Row | undefined
    if (!row) missing()
    if (!['failed', 'missing', 'uncertain'].includes(String(row.archive_state)))
      throw new MailError('VALIDATION', '此邮件的副本无需重试。')
    const verifyOnly = row.archive_state === 'uncertain'
    this.raw
      .prepare(
        `UPDATE outgoing_sends SET archive_state=?,archive_error=NULL,force_save=?,
      archive_attempts=0,archive_next_attempt_at=? WHERE operation_id=?`
      )
      .run(verifyOnly ? 'uncertain' : 'pending', Number(!verifyOnly), Date.now(), operationId)
  }

  listOperations(): Operation[] {
    return (
      this.raw.prepare('SELECT * FROM operations ORDER BY created_at DESC LIMIT 200').all() as Row[]
    ).map((row) => this.operation(row))
  }
  listOperationsPage(input: ListOperationsInput): OperationPage {
    const cursor = operationsCursor(input)
    return this.raw.transaction(() => {
      const scope = input.accountId === undefined ? '' : 'WHERE o.account_id=?'
      const scopeArgs = input.accountId === undefined ? [] : [input.accountId]
      const counts = this.raw
        .prepare(
          `SELECT COUNT(*) total,
          COALESCE(SUM(o.state IN ('queued','running') OR
            (o.state='succeeded' AND s.archive_state IN ('pending','saving'))),0) pending,
          COALESCE(SUM(o.state IN ('failed','uncertain') OR
            (o.state='succeeded' AND s.archive_state IN ('failed','missing','uncertain'))),0) attention
          FROM operations o LEFT JOIN outgoing_sends s
            ON s.operation_id=o.id AND s.accepted_at IS NOT NULL ${scope}`
        )
        .get(...scopeArgs) as Row
      const conditions: string[] = input.accountId === undefined ? [] : ['account_id=?']
      const args: Array<string | number> = [...scopeArgs]
      if (cursor) {
        conditions.push('(created_at,id)<(?,?)')
        args.push(...cursor.before)
        conditions.push('(created_at,id)<=(?,?)')
        args.push(...cursor.through)
      }
      const rows = this.raw
        .prepare(
          `SELECT * FROM operations ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
          ORDER BY created_at DESC,id DESC LIMIT ?`
        )
        .all(...args, input.limit + 1) as Row[]
      const hasMore = rows.length > input.limit
      const retained = rows.slice(0, input.limit)
      const last = retained.at(-1)
      const first = retained[0]
      const nextCursor =
        hasMore && last && first
          ? Buffer.from(
              JSON.stringify({
                version: 1,
                accountId: input.accountId ?? null,
                before: [Number(last.created_at), String(last.id)],
                through: cursor?.through ?? [Number(first.created_at), String(first.id)]
              } satisfies OperationsCursor)
            ).toString('base64url')
          : null
      return {
        items: retained.map((row) => this.operation(row)),
        nextCursor,
        total: Number(counts.total),
        pending: Number(counts.pending),
        attention: Number(counts.attention)
      }
    })()
  }
  getOperation(operationId: string): Operation {
    const row = this.raw.prepare('SELECT * FROM operations WHERE id=?').get(operationId) as
      Row | undefined
    if (!row) missing()
    return this.operation(row)
  }
  nextOperation(now: number): Operation | null {
    const row = this.raw
      .prepare(
        "SELECT * FROM operations WHERE state='queued' AND next_attempt_at<=? ORDER BY created_at LIMIT 1"
      )
      .get(now) as Row | undefined
    return row ? this.operation(row) : null
  }
  updateOperation(
    operationId: string,
    patch: {
      state: OperationState
      error?: string | null
      nextAttemptAt?: number
      incrementAttempts?: boolean
    }
  ): Operation {
    const old = this.getOperation(operationId)
    if (old.sentCopy && patch.state !== 'succeeded')
      throw new MailError('VALIDATION', '服务器已接受的发送任务不能再次投递。')
    this.raw
      .prepare(
        'UPDATE operations SET state=?,error=?,next_attempt_at=?,attempts=?,updated_at=? WHERE id=?'
      )
      .run(
        patch.state,
        patch.error === undefined ? old.error : patch.error,
        patch.nextAttemptAt ?? old.nextAttemptAt,
        old.attempts + Number(patch.incrementAttempts ?? false),
        Date.now(),
        operationId
      )
    return this.getOperation(operationId)
  }
  recoverInterrupted(): void {
    this.raw.transaction(() => {
      const legacySends = this.raw
        .prepare(
          `SELECT o.* FROM operations o WHERE o.kind='send' AND o.state='succeeded'
        AND NOT EXISTS(SELECT 1 FROM outgoing_sends s WHERE s.operation_id=o.id AND s.accepted_at IS NOT NULL)`
        )
        .all() as Row[]
      for (const row of legacySends) {
        const connection = this.getConnection(String(row.account_id))
        if (connection)
          this.acceptSend(String(row.id), {
            address: connection.account.email,
            name: connection.account.name
          })
      }
      this.raw
        .prepare(
          `UPDATE operations SET state='uncertain',error='应用在发送过程中退出，发送结果待确认；请核对已发送邮件，避免重复发送。',updated_at=?
          WHERE state='running' AND kind='send' AND NOT EXISTS(SELECT 1 FROM outgoing_sends s WHERE s.operation_id=operations.id AND s.accepted_at IS NOT NULL)`
        )
        .run(Date.now())
      this.raw
        .prepare(
          "UPDATE operations SET state='queued',next_attempt_at=?,updated_at=? WHERE state='running' AND kind!='send'"
        )
        .run(Date.now(), Date.now())
      this.raw
        .prepare(
          `UPDATE outgoing_sends SET archive_state='uncertain',archive_error='保存副本时应用退出，将先核验远端副本。',
        archive_next_attempt_at=?,force_save=0 WHERE accepted_at IS NOT NULL AND archive_state='saving'`
        )
        .run(Date.now())
      this.raw.prepare("UPDATE accounts SET status='idle' WHERE status='syncing'").run()
    })()
  }
  isSuperseded(operation: Operation): boolean {
    if (operation.kind === 'send') {
      const draftId = (operation.payload as SendPayload).draft.id
      if (!draftId) return false
      return Boolean(
        this.raw
          .prepare(
            `SELECT id FROM operations WHERE account_id=? AND kind='send' AND created_at>?
        AND json_extract(payload_json,'$.draft.id')=? LIMIT 1`
          )
          .get(operation.accountId, operation.createdAt, draftId)
      )
    }
    return operation.messageIds.some((messageId) =>
      Boolean(
        this.raw
          .prepare(
            `SELECT o.id FROM operation_targets target JOIN operations o ON o.id=target.operation_id
      WHERE target.account_id=? AND o.kind=? AND o.created_at>? AND target.message_id=? LIMIT 1`
          )
          .get(operation.accountId, operation.kind, operation.createdAt, messageId)
      )
    )
  }
  checkpointActionTarget(operationId: string, messageId: string): void {
    const operation = this.getOperation(operationId)
    if (operation.kind === 'send' || !operation.messageIds.includes(messageId))
      throw new MailError('VALIDATION', '操作检查点无效。')
    const payload = operation.payload as ActionPayload
    const completed = [...new Set([...(payload.completedMessageIds ?? []), messageId])]
    this.raw
      .prepare('UPDATE operations SET payload_json=?,updated_at=? WHERE id=?')
      .run(JSON.stringify({ ...payload, completedMessageIds: completed }), Date.now(), operationId)
  }

  listDrafts(): Draft[] {
    return (this.raw.prepare('SELECT * FROM drafts ORDER BY updated_at DESC').all() as Row[]).map(
      (row) => {
        const draft = json<DraftInput>(row.content_json)
        return {
          ...draft,
          id: String(row.id),
          updatedAt: Number(row.updated_at),
          attachments: draft.attachmentIds.map((id) => this.getAsset(id))
        }
      }
    )
  }
  saveDraft(input: DraftInput): Draft {
    if (!this.getConnection(input.accountId)) missing()
    if (input.id) {
      const old = this.raw.prepare('SELECT account_id FROM drafts WHERE id=?').get(input.id) as
        Row | undefined
      if (old && old.account_id !== input.accountId) missing()
    }
    for (const assetId of input.attachmentIds) this.getAsset(assetId)
    const draft: Draft = {
      ...input,
      id: input.id ?? randomUUID(),
      updatedAt: Date.now(),
      attachments: input.attachmentIds.map((id) => this.getAsset(id))
    }
    this.raw.transaction(() => {
      const previous = this.raw
        .prepare('SELECT content_json FROM drafts WHERE id=?')
        .get(draft.id) as Row | undefined
      if (previous) this.queueAssetGarbage(json<DraftInput>(previous.content_json).attachmentIds)
      this.raw
        .prepare(
          `INSERT INTO drafts(id,account_id,content_json,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET content_json=excluded.content_json,updated_at=excluded.updated_at`
        )
        .run(draft.id, draft.accountId, JSON.stringify(draft), draft.updatedAt)
    })()
    return draft
  }
  deleteDraft(draftId: string): void {
    this.raw.transaction(() => {
      const previous = this.raw
        .prepare('SELECT content_json FROM drafts WHERE id=?')
        .get(draftId) as Row | undefined
      if (previous) this.queueAssetGarbage(json<DraftInput>(previous.content_json).attachmentIds)
      this.raw.prepare('DELETE FROM drafts WHERE id=?').run(draftId)
    })()
  }
  private queueAssetGarbage(assetIds: string[]): void {
    for (const id of new Set(assetIds))
      this.raw
        .prepare(
          'INSERT OR IGNORE INTO asset_gc(asset_id,queued_at) SELECT id,? FROM assets WHERE id=?'
        )
        .run(Date.now(), id)
  }
  addAsset(asset: DraftAttachment): void {
    this.raw
      .prepare('INSERT INTO assets(id,filename,size,created_at) VALUES(?,?,?,?)')
      .run(asset.id, asset.filename, asset.size, Date.now())
  }
  getAsset(assetId: string): DraftAttachment {
    const row = this.raw.prepare('SELECT id,filename,size FROM assets WHERE id=?').get(assetId) as
      DraftAttachment | undefined
    if (!row) throw new MailError('NOT_FOUND', '附件不存在，请重新选择文件。')
    return row
  }
  private assetUnreferenced(alias: string): string {
    return `NOT EXISTS(SELECT 1 FROM drafts d,json_each(d.content_json,'$.attachmentIds') ref WHERE ref.value=${alias}.id)
      AND NOT EXISTS(SELECT 1 FROM operations o,json_each(o.payload_json,'$.draft.attachmentIds') ref WHERE o.kind='send' AND ref.value=${alias}.id)`
  }
  pendingAssetGarbage(): DraftAttachment[] {
    return this.raw
      .prepare(
        `SELECT a.id,a.filename,a.size FROM assets a JOIN asset_gc gc ON gc.asset_id=a.id
      WHERE ${this.assetUnreferenced('a')}`
      )
      .all() as DraftAttachment[]
  }
  deleteAssetIfUnreferenced(assetId: string): boolean {
    // A second check protects callers from deleting metadata after a new
    // persistent reference has been created.
    return (
      this.raw
        .prepare(
          `DELETE FROM assets WHERE id=? AND EXISTS(SELECT 1 FROM asset_gc gc WHERE gc.asset_id=assets.id)
      AND ${this.assetUnreferenced('assets')}`
        )
        .run(assetId).changes > 0
    )
  }
}
