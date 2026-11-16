import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { imageSize } from 'image-size'
import { Parser } from 'htmlparser2'
import type {
  RemoteImageCacheContext,
  RemoteImageCacheEntry,
  RemoteImageCacheScope,
  StoredMessage
} from '../../core/store'
import { MailError } from '../../shared/model'
import { normalizeRemoteImageSource } from '../../shared/remote-images'

export const REMOTE_IMAGE_CACHE_LIMITS = {
  ttlMs: 30 * 24 * 60 * 60_000,
  capacityBytes: 128 * 1024 * 1024,
  entries: 4096,
  imagesPerMessage: 24,
  imageBytes: 2 * 1024 * 1024,
  messageBytes: 8 * 1024 * 1024,
  imagePixels: 25_000_000,
  messagePixels: 40_000_000,
  dimension: 12_000
} as const
const maxDataUrlLength = Math.ceil(REMOTE_IMAGE_CACHE_LIMITS.imageBytes / 3) * 4 + 40
type CacheRow = Record<string, unknown>

function invalid(): never {
  throw new MailError('VALIDATION', '图片缓存与当前邮件正文不匹配，请重新打开邮件后重试。')
}
export function imageSources(html: string): Set<string> {
  const sources = new Set<string>()
  const parser = new Parser({
    onopentag(name, attributes) {
      const source = name === 'img' && normalizeRemoteImageSource(attributes.src || '')
      if (source) sources.add(source)
    }
  })
  parser.end(html)
  return sources
}

/** Entries are bounded and revalidated before crossing the host/worker boundary. */
export function validateCachedImage(entry: RemoteImageCacheEntry): void {
  if (
    !entry ||
    typeof entry.source !== 'string' ||
    normalizeRemoteImageSource(entry.source) !== entry.source ||
    typeof entry.dataUrl !== 'string' ||
    entry.dataUrl.length > maxDataUrlLength ||
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes <= 0 ||
    entry.bytes > REMOTE_IMAGE_CACHE_LIMITS.imageBytes ||
    !Number.isSafeInteger(entry.pixels) ||
    entry.pixels <= 0 ||
    entry.pixels > REMOTE_IMAGE_CACHE_LIMITS.imagePixels
  )
    invalid()
  const encoded = entry.dataUrl.match(
    /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/
  )
  if (!encoded) invalid()
  const bytes = Buffer.from(encoded[2]!, 'base64')
  if (bytes.length !== entry.bytes || bytes.toString('base64') !== encoded[2]) invalid()
  try {
    const dimensions = imageSize(bytes)
    const type = dimensions.type === 'jpg' ? 'jpeg' : dimensions.type
    if (
      type !== encoded[1] ||
      !dimensions.width ||
      !dimensions.height ||
      dimensions.width > REMOTE_IMAGE_CACHE_LIMITS.dimension ||
      dimensions.height > REMOTE_IMAGE_CACHE_LIMITS.dimension ||
      dimensions.width * dimensions.height !== entry.pixels
    )
      invalid()
  } catch {
    invalid()
  }
}

export class SqliteRemoteImageCache {
  private readonly limits: { capacityBytes: number; entries: number }
  constructor(
    private readonly database: Database.Database,
    private readonly getMessage: (accountId: string, messageId: string) => StoredMessage,
    limits: { capacityBytes?: number; entries?: number } = {}
  ) {
    this.limits = {
      capacityBytes: limits.capacityBytes ?? REMOTE_IMAGE_CACHE_LIMITS.capacityBytes,
      entries: limits.entries ?? REMOTE_IMAGE_CACHE_LIMITS.entries
    }
    if (
      !Number.isSafeInteger(this.limits.capacityBytes) ||
      this.limits.capacityBytes <= 0 ||
      !Number.isSafeInteger(this.limits.entries) ||
      this.limits.entries <= 0
    )
      invalid()
  }
  private context(scope: RemoteImageCacheScope): string {
    if (!scope || !/^[a-f0-9]{64}$/.test(scope.bodyHash || '')) invalid()
    const stored = this.getMessage(scope.accountId, scope.messageId)
    if (
      stored.summary.accountId !== scope.accountId ||
      stored.summary.id !== scope.messageId ||
      !stored.body
    )
      invalid()
    const html = stored.body.html || ''
    if (createHash('sha256').update(html).digest('hex') !== scope.bodyHash) invalid()
    return html
  }
  private prune(now: number): void {
    this.database
      .prepare(
        `DELETE FROM remote_image_cache WHERE updated_at<=? OR bytes<=0 OR bytes>? OR pixels<=0 OR pixels>?`
      )
      .run(
        now - REMOTE_IMAGE_CACHE_LIMITS.ttlMs,
        REMOTE_IMAGE_CACHE_LIMITS.imageBytes,
        REMOTE_IMAGE_CACHE_LIMITS.imagePixels
      )
    this.database.exec(`DELETE FROM remote_image_cache AS c WHERE
      NOT EXISTS(SELECT 1 FROM messages m WHERE m.account_id=c.account_id AND m.id=c.message_id)
      AND NOT EXISTS(SELECT 1 FROM outgoing_sends s WHERE s.account_id=c.account_id AND s.local_message_id=c.message_id AND s.accepted_at IS NOT NULL AND s.bound=0)`)
    this.database
      .prepare(
        `DELETE FROM remote_image_cache WHERE rowid IN (
      SELECT rowid FROM (
        SELECT rowid, SUM(bytes) OVER(ORDER BY last_access_at DESC,updated_at DESC,rowid DESC) kept_bytes,
          ROW_NUMBER() OVER(ORDER BY last_access_at DESC,updated_at DESC,rowid DESC) kept_entries FROM remote_image_cache
      ) WHERE kept_bytes>? OR kept_entries>?
    )`
      )
      .run(this.limits.capacityBytes, this.limits.entries)
  }
  private invalidateOldBodies(scope: RemoteImageCacheScope): void {
    this.database
      .prepare(
        'DELETE FROM remote_image_cache WHERE account_id=? AND message_id=? AND body_hash<>?'
      )
      .run(scope.accountId, scope.messageId, scope.bodyHash)
  }
  adoptMessageId(accountId: string, previousId: string, nextId: string): void {
    if (previousId === nextId) return
    this.database.transaction(() => {
      // Both representations may already have cached the same image. Keep the
      // newest valid download without granting it a fresh lifetime on adoption.
      const rows = this.database
        .prepare(
          `SELECT body_hash,source,data_url,bytes,pixels,updated_at,last_access_at
          FROM remote_image_cache WHERE account_id=? AND message_id IN (?,?)
          AND updated_at>? AND length(data_url)<=?
          ORDER BY updated_at DESC,last_access_at DESC,CASE WHEN message_id=? THEN 0 ELSE 1 END,rowid DESC LIMIT ?`
        )
        .all(
          accountId,
          previousId,
          nextId,
          Date.now() - REMOTE_IMAGE_CACHE_LIMITS.ttlMs,
          maxDataUrlLength,
          nextId,
          REMOTE_IMAGE_CACHE_LIMITS.imagesPerMessage * 2
        ) as CacheRow[]
      const selected: CacheRow[] = []
      const seen = new Set<string>()
      const budgets = new Map<string, { count: number; bytes: number; pixels: number }>()
      for (const row of rows) {
        const hash = String(row.body_hash)
        if (!/^[a-f0-9]{64}$/.test(hash)) continue
        const image: RemoteImageCacheEntry = {
          source: String(row.source),
          dataUrl: String(row.data_url),
          bytes: Number(row.bytes),
          pixels: Number(row.pixels)
        }
        try {
          validateCachedImage(image)
        } catch {
          continue
        }
        const key = JSON.stringify([hash, image.source])
        if (seen.has(key)) continue
        const budget = budgets.get(hash) || { count: 0, bytes: 0, pixels: 0 }
        if (
          budget.count >= REMOTE_IMAGE_CACHE_LIMITS.imagesPerMessage ||
          budget.bytes + image.bytes > REMOTE_IMAGE_CACHE_LIMITS.messageBytes ||
          budget.pixels + image.pixels > REMOTE_IMAGE_CACHE_LIMITS.messagePixels
        )
          continue
        seen.add(key)
        budgets.set(hash, {
          count: budget.count + 1,
          bytes: budget.bytes + image.bytes,
          pixels: budget.pixels + image.pixels
        })
        selected.push(row)
      }
      this.database
        .prepare('DELETE FROM remote_image_cache WHERE account_id=? AND message_id IN (?,?)')
        .run(accountId, previousId, nextId)
      const insert = this.database.prepare(
        `INSERT INTO remote_image_cache(account_id,message_id,body_hash,source,data_url,bytes,pixels,updated_at,last_access_at)
        VALUES(?,?,?,?,?,?,?,?,?)`
      )
      for (const row of selected)
        insert.run(
          accountId,
          nextId,
          row.body_hash,
          row.source,
          row.data_url,
          row.bytes,
          row.pixels,
          row.updated_at,
          row.last_access_at
        )
    })()
  }
  read(scope: RemoteImageCacheScope): RemoteImageCacheContext {
    const html = this.context(scope)
    return this.database.transaction(() => {
      const now = Date.now()
      this.prune(now)
      this.invalidateOldBodies(scope)
      this.database
        .prepare(
          'DELETE FROM remote_image_cache WHERE account_id=? AND message_id=? AND body_hash=? AND length(data_url)>?'
        )
        .run(scope.accountId, scope.messageId, scope.bodyHash, maxDataUrlLength)
      const rows = this.database
        .prepare(
          `SELECT source,data_url,bytes,pixels FROM remote_image_cache WHERE account_id=? AND message_id=? AND body_hash=? ORDER BY source LIMIT ?`
        )
        .all(
          scope.accountId,
          scope.messageId,
          scope.bodyHash,
          REMOTE_IMAGE_CACHE_LIMITS.imagesPerMessage + 1
        ) as CacheRow[]
      const allowed = imageSources(html)
      const images: RemoteImageCacheEntry[] = []
      let bytes = 0,
        pixels = 0
      for (const row of rows) {
        const image = {
          source: String(row.source),
          dataUrl: String(row.data_url),
          bytes: Number(row.bytes),
          pixels: Number(row.pixels)
        }
        try {
          validateCachedImage(image)
          if (
            !allowed.has(image.source) ||
            images.length >= REMOTE_IMAGE_CACHE_LIMITS.imagesPerMessage ||
            bytes + image.bytes > REMOTE_IMAGE_CACHE_LIMITS.messageBytes ||
            pixels + image.pixels > REMOTE_IMAGE_CACHE_LIMITS.messagePixels
          )
            invalid()
          images.push(image)
          bytes += image.bytes
          pixels += image.pixels
          this.database
            .prepare(
              'UPDATE remote_image_cache SET last_access_at=? WHERE account_id=? AND message_id=? AND body_hash=? AND source=?'
            )
            .run(now, scope.accountId, scope.messageId, scope.bodyHash, image.source)
        } catch {
          this.database
            .prepare(
              'DELETE FROM remote_image_cache WHERE account_id=? AND message_id=? AND body_hash=? AND source=?'
            )
            .run(scope.accountId, scope.messageId, scope.bodyHash, image.source)
        }
      }
      return { html, images }
    })()
  }
  write(scope: RemoteImageCacheScope, images: RemoteImageCacheEntry[]): void {
    const html = this.context(scope)
    if (!Array.isArray(images) || images.length > REMOTE_IMAGE_CACHE_LIMITS.imagesPerMessage)
      invalid()
    const allowed = imageSources(html)
    const sources = new Set<string>()
    for (const image of images) {
      validateCachedImage(image)
      if (!allowed.has(image.source) || sources.has(image.source)) invalid()
      sources.add(image.source)
    }
    this.database.transaction(() => {
      const now = Date.now()
      this.prune(now)
      this.invalidateOldBodies(scope)
      const save = this.database.prepare(
        `INSERT INTO remote_image_cache(account_id,message_id,body_hash,source,data_url,bytes,pixels,updated_at,last_access_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,message_id,body_hash,source) DO UPDATE SET data_url=excluded.data_url,bytes=excluded.bytes,pixels=excluded.pixels,updated_at=excluded.updated_at,last_access_at=excluded.last_access_at`
      )
      for (const image of images)
        save.run(
          scope.accountId,
          scope.messageId,
          scope.bodyHash,
          image.source,
          image.dataUrl,
          image.bytes,
          image.pixels,
          now,
          now
        )
      const totals = this.database
        .prepare(
          'SELECT COUNT(*) n,COALESCE(SUM(bytes),0) bytes,COALESCE(SUM(pixels),0) pixels FROM remote_image_cache WHERE account_id=? AND message_id=? AND body_hash=?'
        )
        .get(scope.accountId, scope.messageId, scope.bodyHash) as CacheRow
      if (
        Number(totals.n) > REMOTE_IMAGE_CACHE_LIMITS.imagesPerMessage ||
        Number(totals.bytes) > REMOTE_IMAGE_CACHE_LIMITS.messageBytes ||
        Number(totals.pixels) > REMOTE_IMAGE_CACHE_LIMITS.messagePixels
      )
        invalid()
      this.prune(now)
    })()
  }
}
