import {
  sqliteTable,
  text,
  integer,
  blob,
  index,
  primaryKey,
  uniqueIndex
} from 'drizzle-orm/sqlite-core'

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  color: text('color').notNull(),
  hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  provider: text('provider').notNull(),
  config: text('config').notNull(),
  status: text('status').notNull(),
  error: text('error'),
  lastSyncAt: integer('last_sync_at'),
  createdAt: integer('created_at').notNull()
})
export const folders = sqliteTable(
  'folders',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    remoteId: text('remote_id').notNull(),
    name: text('name').notNull(),
    role: text('role').notNull()
  },
  (table) => [uniqueIndex('folders_remote').on(table.accountId, table.remoteId)]
)
export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    remoteId: text('remote_id').notNull(),
    subject: text('subject').notNull(),
    from: text('from_json').notNull(),
    to: text('to_json').notNull(),
    date: integer('date').notNull(),
    snippet: text('snippet').notNull(),
    isRead: integer('is_read', { mode: 'boolean' }).notNull(),
    isStarred: integer('is_starred', { mode: 'boolean' }).notNull(),
    hasAttachments: integer('has_attachments', { mode: 'boolean' }).notNull(),
    internetMessageId: text('internet_message_id'),
    body: text('body_json')
  },
  (table) => [uniqueIndex('messages_remote').on(table.accountId, table.remoteId)]
)
export const memberships = sqliteTable(
  'memberships',
  {
    accountId: text('account_id').notNull(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    folderId: text('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    ref: text('ref_json').notNull()
  },
  (table) => [primaryKey({ columns: [table.messageId, table.folderId] })]
)
export const syncState = sqliteTable('sync_state', {
  accountId: text('account_id').notNull(),
  folderId: text('folder_id')
    .primaryKey()
    .references(() => folders.id, { onDelete: 'cascade' }),
  cursor: text('cursor'),
  updatedAt: integer('updated_at').notNull()
})
export const accountSyncState = sqliteTable('account_sync_state', {
  accountId: text('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  failures: integer('failures').notNull().default(0),
  nextAttemptAt: integer('next_attempt_at').notNull().default(0),
  lastReconcileAt: integer('last_reconcile_at')
})
export const orphanMarkers = sqliteTable('orphan_markers', {
  messageId: text('message_id')
    .primaryKey()
    .references(() => messages.id, { onDelete: 'cascade' }),
  accountId: text('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  detectedAt: integer('detected_at').notNull()
})
export const operations = sqliteTable(
  'operations',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    kind: text('kind').notNull(),
    state: text('state').notNull(),
    messageIds: text('message_ids_json').notNull(),
    payload: text('payload_json').notNull(),
    attempts: integer('attempts').notNull(),
    error: text('error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    nextAttemptAt: integer('next_attempt_at').notNull()
  },
  (table) => [
    uniqueIndex('operations_request').on(table.accountId, table.requestId),
    index('operations_history_order').on(table.createdAt, table.id),
    index('operations_account_history_order').on(table.accountId, table.createdAt, table.id)
  ]
)
export const drafts = sqliteTable('drafts', {
  id: text('id').primaryKey(),
  accountId: text('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  content: text('content_json').notNull(),
  updatedAt: integer('updated_at').notNull()
})
export const assets = sqliteTable('assets', {
  id: text('id').primaryKey(),
  filename: text('filename').notNull(),
  size: integer('size').notNull(),
  createdAt: integer('created_at').notNull()
})
export const operationTargets = sqliteTable(
  'operation_targets',
  {
    operationId: text('operation_id')
      .notNull()
      .references(() => operations.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    messageId: text('message_id').notNull()
  },
  (table) => [primaryKey({ columns: [table.operationId, table.messageId] })]
)
export const assetGarbage = sqliteTable('asset_gc', {
  assetId: text('asset_id')
    .primaryKey()
    .references(() => assets.id, { onDelete: 'cascade' }),
  queuedAt: integer('queued_at').notNull()
})
export const outgoingSends = sqliteTable(
  'outgoing_sends',
  {
    operationId: text('operation_id')
      .primaryKey()
      .references(() => operations.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    localMessageId: text('local_message_id').notNull().unique(),
    internetMessageId: text('internet_message_id').notNull(),
    date: integer('date').notNull(),
    from: text('from_json').notNull().default('[]'),
    acceptedAt: integer('accepted_at'),
    archiveState: text('archive_state', {
      enum: ['pending', 'saving', 'saved', 'failed', 'uncertain', 'missing']
    })
      .notNull()
      .default('pending'),
    archiveError: text('archive_error'),
    archiveRef: text('archive_ref_json'),
    archiveAttempts: integer('archive_attempts').notNull().default(0),
    archiveNextAttemptAt: integer('archive_next_attempt_at').notNull().default(0),
    forceSave: integer('force_save', { mode: 'boolean' }).notNull().default(false),
    receipt: text('receipt_json'),
    remoteId: text('remote_id'),
    bound: integer('bound', { mode: 'boolean' }).notNull().default(false)
  },
  (table) => [
    index('outgoing_identity').on(table.accountId, table.internetMessageId),
    index('outgoing_remote').on(table.accountId, table.remoteId),
    index('outgoing_archive_queue').on(
      table.archiveState,
      table.archiveNextAttemptAt,
      table.acceptedAt
    )
  ]
)
export const outgoingMime = sqliteTable('outgoing_mime', {
  operationId: text('operation_id')
    .primaryKey()
    .references(() => outgoingSends.operationId, { onDelete: 'cascade' }),
  raw: blob('raw', { mode: 'buffer' }).notNull()
})

export const remoteImageCache = sqliteTable(
  'remote_image_cache',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    messageId: text('message_id').notNull(),
    bodyHash: text('body_hash').notNull(),
    source: text('source').notNull(),
    dataUrl: text('data_url').notNull(),
    bytes: integer('bytes').notNull(),
    pixels: integer('pixels').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastAccessAt: integer('last_access_at').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.messageId, table.bodyHash, table.source] }),
    index('remote_image_cache_expiry').on(table.updatedAt),
    index('remote_image_cache_lru').on(table.lastAccessAt, table.updatedAt)
  ]
)
