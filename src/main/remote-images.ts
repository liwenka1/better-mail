import { lookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { createHash } from 'node:crypto'
import ipaddr from 'ipaddr.js'
import { imageSize } from 'image-size'
import { requestSchemas } from '../shared/contracts'
import { MailError } from '../shared/model'
import { normalizeRemoteImageSource, type RemoteImagesResult } from '../shared/remote-images'
import type {
  RemoteImageCacheContext,
  RemoteImageCacheEntry,
  RemoteImageCacheScope
} from '../core/store'
import {
  imageSources,
  REMOTE_IMAGE_CACHE_LIMITS,
  validateCachedImage as checkCachedImage
} from '../infrastructure/storage/remote-image-cache'

export const REMOTE_IMAGE_LIMITS = {
  images: REMOTE_IMAGE_CACHE_LIMITS.imagesPerMessage,
  concurrency: 3,
  redirects: 3,
  imageBytes: REMOTE_IMAGE_CACHE_LIMITS.imageBytes,
  totalBytes: REMOTE_IMAGE_CACHE_LIMITS.messageBytes,
  deadlineMs: 12_000,
  dimension: REMOTE_IMAGE_CACHE_LIMITS.dimension,
  pixels: REMOTE_IMAGE_CACHE_LIMITS.imagePixels,
  totalPixels: REMOTE_IMAGE_CACHE_LIMITS.messagePixels
} as const

interface Address {
  address: string
  family: number
}
export interface RemoteImageResponse {
  status: number
  headers: IncomingHttpHeaders
  body: AsyncIterable<Uint8Array>
  dispose(): void
}
export interface RemoteImageDependencies {
  cache: {
    read(scope: RemoteImageCacheScope): Promise<RemoteImageCacheContext>
    write(scope: RemoteImageCacheScope, images: RemoteImageCacheEntry[]): Promise<void>
  }
  resolve?: (hostname: string) => Promise<Address[]>
  transport?: (url: URL, address: Address, signal: AbortSignal) => Promise<RemoteImageResponse>
  /** Each I/O phase has this budget; explicit cancellation spans all phases. */
  deadlineMs?: number
}

function imageFailure(): MailError {
  return new MailError('NETWORK', '部分图片暂时无法加载，可稍后重试。', true)
}
function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw imageFailure()
}
function withinDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', cancel)
    const cancel = () => {
      cleanup()
      reject(imageFailure())
    }
    signal.addEventListener('abort', cancel, { once: true })
    // Observe the operation even if it aborted synchronously before returning its promise.
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      }
    )
    if (signal.aborted) cancel()
  })
}

/** No browser session, proxy agent, cookies, authorization or Referer is involved. */
export function requestRemoteImage(
  url: URL,
  address: Address,
  signal: AbortSignal
): Promise<RemoteImageResponse> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: 'GET',
        agent: false,
        signal,
        rejectUnauthorized: true,
        family: address.family,
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [address])
          else callback(null, address.address, address.family)
        },
        headers: {
          Accept: 'image/png,image/jpeg,image/gif,image/webp',
          'Accept-Encoding': 'identity'
        },
        maxHeaderSize: 16 * 1024
      },
      (response) =>
        resolve({
          status: response.statusCode || 0,
          headers: response.headers,
          body: response,
          dispose: () => response.destroy()
        })
    )
    request.once('error', reject)
    request.end()
  })
}

export function isPublicImageAddress(address: string): boolean {
  try {
    // IPv4-mapped IPv6, transition, link-local, private and reserved ranges all fail closed.
    return ipaddr.parse(address).range() === 'unicast'
  } catch {
    return false
  }
}

export function remoteImageSources(html: string): string[] {
  return [...imageSources(html)]
}

function rasterType(bytes: Buffer): 'png' | 'jpeg' | 'gif' | 'webp' | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg'
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'gif'
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'webp'
  return null
}

function rasterDetails(content: Buffer, contentType: string): { bytes: number; pixels: number } {
  const type = rasterType(content)
  if (!type || contentType !== `image/${type}` || content.length > REMOTE_IMAGE_LIMITS.imageBytes)
    throw imageFailure()
  const dimensions = imageSize(content)
  if (
    !dimensions.width ||
    !dimensions.height ||
    dimensions.width > REMOTE_IMAGE_LIMITS.dimension ||
    dimensions.height > REMOTE_IMAGE_LIMITS.dimension ||
    dimensions.width * dimensions.height > REMOTE_IMAGE_LIMITS.pixels
  )
    throw imageFailure()
  return { bytes: content.length, pixels: dimensions.width * dimensions.height }
}

function validateCachedImage(entry: RemoteImageCacheEntry): RemoteImageCacheEntry | null {
  try {
    checkCachedImage(entry)
    return entry
  } catch {
    return null
  }
}

export class RemoteImageLoader {
  private readonly inflight = new Map<string, Promise<RemoteImagesResult>>()
  private readonly controllers = new Set<AbortController>()
  constructor(private readonly dependencies: RemoteImageDependencies) {}

  private deadlineScope(parent?: AbortSignal): { signal: AbortSignal; finish(): void } {
    const controller = new AbortController()
    if (!parent) this.controllers.add(controller)
    const timer = setTimeout(
      () => controller.abort(),
      this.dependencies.deadlineMs ?? REMOTE_IMAGE_LIMITS.deadlineMs
    )
    return {
      signal: parent ? AbortSignal.any([parent, controller.signal]) : controller.signal,
      finish: () => {
        clearTimeout(timer)
        controller.abort()
        this.controllers.delete(controller)
      }
    }
  }

  private async context(scope: RemoteImageCacheScope): Promise<RemoteImageCacheContext> {
    const context = await this.dependencies.cache.read(scope)
    if (createHash('sha256').update(context.html).digest('hex') !== scope.bodyHash)
      throw new MailError('VALIDATION', '邮件正文已变化，请重新打开邮件后加载图片。')
    return context
  }

  private cachedEntries(
    context: RemoteImageCacheContext,
    retained: string[]
  ): RemoteImageCacheEntry[] {
    const available = new Map<string, RemoteImageCacheEntry>()
    for (const entry of context.images) {
      if (retained.includes(entry.source) && !available.has(entry.source)) {
        const valid = validateCachedImage(entry)
        if (valid) available.set(entry.source, valid)
      }
    }
    const entries: RemoteImageCacheEntry[] = []
    let bytes = 0
    let pixels = 0
    for (const source of retained) {
      const entry = available.get(source)
      if (!entry) continue
      if (
        bytes + entry.bytes > REMOTE_IMAGE_LIMITS.totalBytes ||
        pixels + entry.pixels > REMOTE_IMAGE_LIMITS.totalPixels
      )
        continue
      entries.push(entry)
      bytes += entry.bytes
      pixels += entry.pixels
    }
    return entries
  }

  /** A cache lookup never resolves a host or downloads a missing image. */
  async cached(raw: unknown): Promise<RemoteImagesResult> {
    const scope = requestSchemas['messages.cachedImages'].parse(raw)
    const deadline = this.deadlineScope()
    try {
      const context = await withinDeadline(this.context(scope), deadline.signal)
      const sources = remoteImageSources(context.html)
      const retained = sources.slice(0, REMOTE_IMAGE_LIMITS.images)
      const entries = this.cachedEntries(context, retained)
      return {
        images: entries.map(({ source, dataUrl }) => ({ source, dataUrl })),
        failed: retained.length - entries.length,
        skipped: sources.length - retained.length
      }
    } finally {
      deadline.finish()
    }
  }

  cancelAll(): void {
    for (const controller of this.controllers) controller.abort()
  }

  load(raw: unknown): Promise<RemoteImagesResult> {
    const input = requestSchemas['messages.loadImages'].parse(raw)
    const key = JSON.stringify([input.accountId, input.messageId, input.bodyHash])
    const existing = this.inflight.get(key)
    if (existing) return existing
    if (this.inflight.size >= 2)
      return Promise.reject(new MailError('NETWORK', '已有图片正在加载，请稍后重试。', true))
    const pending = this.loadMessage(input)
    this.inflight.set(key, pending)
    void pending.finally(() => this.inflight.delete(key)).catch(() => undefined)
    return pending
  }

  private async loadMessage(scope: RemoteImageCacheScope): Promise<RemoteImagesResult> {
    // Explicit cancellation spans both phases; the network deadline must not
    // discard completed images before the separately bounded cache write.
    const cancellation = new AbortController()
    this.controllers.add(cancellation)
    const deadline = this.deadlineScope(cancellation.signal)
    const { signal } = deadline
    const networkBudget = new AbortController()
    const networkSignal = AbortSignal.any([signal, networkBudget.signal])
    let receivedBytes = 0
    let receivedPixels = 0
    try {
      const context = await withinDeadline(this.context(scope), signal)
      const sources = remoteImageSources(context.html)
      const retained = sources.slice(0, REMOTE_IMAGE_LIMITS.images)
      const existing = this.cachedEntries(context, retained)
      const completed = new Map(existing.map((entry) => [entry.source, entry]))
      const missing = retained.filter((source) => !completed.has(source))
      const downloaded: RemoteImageCacheEntry[] = []
      receivedBytes = existing.reduce((sum, entry) => sum + entry.bytes, 0)
      receivedPixels = existing.reduce((sum, entry) => sum + entry.pixels, 0)
      let next = 0
      await Promise.all(
        Array.from(
          { length: Math.min(missing.length, REMOTE_IMAGE_LIMITS.concurrency) },
          async () => {
            while (next < missing.length) {
              const source = missing[next++]!
              try {
                const image = await this.download(
                  new URL(source),
                  networkSignal,
                  (length) => {
                    receivedBytes += length
                    if (receivedBytes > REMOTE_IMAGE_LIMITS.totalBytes) {
                      networkBudget.abort()
                      throw imageFailure()
                    }
                  },
                  (pixels) => {
                    if (receivedPixels + pixels > REMOTE_IMAGE_LIMITS.totalPixels)
                      throw imageFailure()
                    receivedPixels += pixels
                  }
                )
                const entry = { source, ...image }
                downloaded.push(entry)
                completed.set(source, entry)
              } catch {
                // Successful cached or downloaded images remain available for a later retry.
              }
            }
          }
        )
      )
      deadline.finish()
      if (downloaded.length) {
        aborted(cancellation.signal)
        const persistence = this.deadlineScope(cancellation.signal)
        try {
          await withinDeadline(this.dependencies.cache.write(scope, downloaded), persistence.signal)
        } finally {
          persistence.finish()
        }
      }
      return {
        images: retained.flatMap((source) => {
          const entry = completed.get(source)
          return entry ? [{ source, dataUrl: entry.dataUrl }] : []
        }),
        failed: retained.length - completed.size,
        skipped: sources.length - retained.length
      }
    } finally {
      deadline.finish()
      networkBudget.abort()
      cancellation.abort()
      this.controllers.delete(cancellation)
    }
  }

  private async download(
    initial: URL,
    signal: AbortSignal,
    consume: (length: number) => void,
    consumePixels: (pixels: number) => void
  ): Promise<Omit<RemoteImageCacheEntry, 'source'>> {
    let url = initial
    for (let redirect = 0; redirect <= REMOTE_IMAGE_LIMITS.redirects; redirect++) {
      aborted(signal)
      const hostname = url.hostname.replace(/^\[|\]$/g, '')
      const addresses = isIP(hostname)
        ? [{ address: hostname, family: isIP(hostname) }]
        : await withinDeadline(
            (this.dependencies.resolve || ((host) => lookup(host, { all: true })))(hostname),
            signal
          )
      if (!addresses.length || addresses.some((address) => !isPublicImageAddress(address.address)))
        throw imageFailure()
      aborted(signal)
      const response = await withinDeadline(
        (this.dependencies.transport || requestRemoteImage)(url, addresses[0]!, signal),
        signal
      )
      try {
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (redirect === REMOTE_IMAGE_LIMITS.redirects || !response.headers.location)
            throw imageFailure()
          const target = normalizeRemoteImageSource(new URL(response.headers.location, url).href)
          if (!target) throw imageFailure()
          url = new URL(target)
          continue
        }
        if (response.status !== 200) throw imageFailure()
        const encoding = response.headers['content-encoding']
        if (encoding && encoding.toLowerCase() !== 'identity') throw imageFailure()
        const contentType = response.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
        if (
          !contentType ||
          !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(contentType)
        )
          throw imageFailure()
        const length = response.headers['content-length']
        if (length && (!/^\d+$/.test(length) || Number(length) > REMOTE_IMAGE_LIMITS.imageBytes))
          throw imageFailure()
        const chunks: Buffer[] = []
        let bytes = 0
        const iterator = response.body[Symbol.asyncIterator]()
        while (true) {
          const next = await withinDeadline(iterator.next(), signal)
          if (next.done) break
          bytes += next.value.byteLength
          consume(next.value.byteLength)
          if (bytes > REMOTE_IMAGE_LIMITS.imageBytes) throw imageFailure()
          chunks.push(Buffer.from(next.value))
        }
        const content = Buffer.concat(chunks)
        const details = rasterDetails(content, contentType)
        consumePixels(details.pixels)
        return { dataUrl: `data:${contentType};base64,${content.toString('base64')}`, ...details }
      } finally {
        response.dispose()
      }
    }
    throw imageFailure()
  }
}
