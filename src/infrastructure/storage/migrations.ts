import type Database from 'better-sqlite3'

// Migrations are immutable and bundled with the application. Each version is
// committed atomically with user_version so interrupted upgrades can be retried.
const migrations = [
  `CREATE TABLE accounts (
    id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL,
    provider TEXT NOT NULL, config TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle',
    error TEXT, last_sync_at INTEGER, created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX accounts_identity ON accounts(provider, email COLLATE NOCASE);
  CREATE TABLE folders (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
    UNIQUE(account_id, remote_id), UNIQUE(account_id, id)
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL, subject TEXT NOT NULL, from_json TEXT NOT NULL, to_json TEXT NOT NULL,
    date INTEGER NOT NULL, snippet TEXT NOT NULL, is_read INTEGER NOT NULL, is_starred INTEGER NOT NULL,
    has_attachments INTEGER NOT NULL, internet_message_id TEXT, body_json TEXT,
    UNIQUE(account_id, remote_id), UNIQUE(account_id, id)
  );
  CREATE INDEX messages_order ON messages(date DESC, id DESC);
  CREATE INDEX messages_account_order ON messages(account_id, date DESC, id DESC);
  CREATE TABLE memberships (
    account_id TEXT NOT NULL, message_id TEXT NOT NULL, folder_id TEXT NOT NULL, ref_json TEXT NOT NULL,
    PRIMARY KEY(message_id, folder_id),
    FOREIGN KEY(account_id, message_id) REFERENCES messages(account_id, id) ON DELETE CASCADE,
    FOREIGN KEY(account_id, folder_id) REFERENCES folders(account_id, id) ON DELETE CASCADE
  );
  CREATE INDEX memberships_folder ON memberships(folder_id, message_id);
  CREATE TABLE sync_state (
    account_id TEXT NOT NULL, folder_id TEXT PRIMARY KEY, cursor TEXT, updated_at INTEGER NOT NULL,
    FOREIGN KEY(account_id, folder_id) REFERENCES folders(account_id, id) ON DELETE CASCADE
  );`,
  `CREATE TABLE operations (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
    message_ids_json TEXT NOT NULL, payload_json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL,
    UNIQUE(account_id, request_id)
  );
  CREATE INDEX operations_queue ON operations(state, next_attempt_at, created_at);
  CREATE TABLE drafts (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    content_json TEXT NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX drafts_account ON drafts(account_id, updated_at DESC);
  CREATE TABLE assets (id TEXT PRIMARY KEY, filename TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL);`,
  `CREATE TABLE operation_targets (
    operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, message_id TEXT NOT NULL,
    PRIMARY KEY(operation_id, message_id)
  );
  CREATE INDEX operation_targets_message ON operation_targets(account_id, message_id, operation_id);
  CREATE INDEX operations_intent ON operations(account_id, kind, created_at DESC);
  INSERT OR IGNORE INTO operation_targets(operation_id,account_id,message_id)
    SELECT o.id,o.account_id,j.value FROM operations o,json_each(o.message_ids_json) j;`,
  `CREATE TABLE asset_gc (
    asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE, queued_at INTEGER NOT NULL
  );`,
  `CREATE TABLE outgoing_sends (
    operation_id TEXT PRIMARY KEY REFERENCES operations(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    local_message_id TEXT NOT NULL UNIQUE, internet_message_id TEXT NOT NULL,
    date INTEGER NOT NULL, from_json TEXT NOT NULL DEFAULT '[]', accepted_at INTEGER,
    archive_state TEXT NOT NULL DEFAULT 'pending' CHECK(archive_state IN ('pending','saving','saved','failed','uncertain','missing')),
    archive_error TEXT, archive_ref_json TEXT, archive_attempts INTEGER NOT NULL DEFAULT 0,
    archive_next_attempt_at INTEGER NOT NULL DEFAULT 0, force_save INTEGER NOT NULL DEFAULT 0,
    receipt_json TEXT, remote_id TEXT, bound INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX outgoing_identity ON outgoing_sends(account_id,internet_message_id);
  CREATE INDEX outgoing_remote ON outgoing_sends(account_id,remote_id);
  CREATE INDEX outgoing_archive_queue ON outgoing_sends(archive_state,archive_next_attempt_at,accepted_at);
  CREATE TABLE outgoing_mime (
    operation_id TEXT PRIMARY KEY REFERENCES outgoing_sends(operation_id) ON DELETE CASCADE,
    raw BLOB NOT NULL
  );`,
  `CREATE TABLE account_sync_state (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    failures INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
    last_reconcile_at INTEGER
  );
  CREATE TABLE orphan_markers (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    detected_at INTEGER NOT NULL
  );
  CREATE INDEX orphan_markers_age ON orphan_markers(account_id,detected_at);`,
  `ALTER TABLE accounts ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1));`,
  `CREATE INDEX operations_history_order ON operations(created_at,id);
  CREATE INDEX operations_account_history_order ON operations(account_id,created_at,id);`
] as const

export const SCHEMA_VERSION = migrations.length
export function migrate(database: Database.Database): void {
  const version = database.pragma('user_version', { simple: true }) as number
  if (version > SCHEMA_VERSION)
    throw new Error(
      `数据库版本 ${version} 高于当前应用支持的版本 ${SCHEMA_VERSION}，请使用较新版本应用。`
    )
  for (let index = version; index < migrations.length; index++) {
    database.transaction(() => {
      database.exec(migrations[index]!)
      database.pragma(`user_version = ${index + 1}`)
    })()
  }
}

// Exported for migration regression tests and offline diagnostics.
export const migrationSql: readonly string[] = migrations
