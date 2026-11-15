import { lookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { Parser } from 'htmlparser2'
import ipaddr from 'ipaddr.js'
import { imageSize } from 'image-size'
import { requestSchemas } from '../shared/contracts'
import { MailError, type MessageDetail } from '../shared/model'
import { normalizeRemoteImageSource, type RemoteImagesResult } from '../shared/remote-images'

export const REMOTE_IMAGE_LIMITS = {
  images: 24,
  concurrency: 3,
  redirects: 3,
  imageBytes: 2 * 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
  deadlineMs: 12_000,
  dimension: 12_000,
  pixels: 25_000_000,
  totalPixels: 40_000_000
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
  getMessage(accountId: string, messageId: string): Promise<MessageDetail>
  resolve?: (hostname: string) => Promise<Address[]>
  transport?: (url: URL, address: Address, signal: AbortSignal) => Promise<RemoteImageResponse>
  deadlineMs?: number
}

function imageFailure(): MailError {
  return new MailError('NETWORK', '部分图片暂时无法加载，可稍后重试。', true)
}
function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw imageFailure()
}
function withinDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  aborted(signal)
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(imageFailure())
    signal.addEventListener('abort', cancel, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
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
  const sources = new Set<string>()
  const parser = new Parser({
    onopentag(name, attributes) {
      if (name !== 'img' || !attributes.src) return
      const source = normalizeRemoteImageSource(attributes.src)
      if (source) sources.add(source)
    }
  })
  parser.end(html)
  return [...sources]
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

export class RemoteImageLoader {
  private readonly inflight = new Map<string, Promise<RemoteImagesResult>>()
  private readonly controllers = new Set<AbortController>()
  constructor(private readonly dependencies: RemoteImageDependencies) {}

  cancelAll(): void {
    for (const controller of this.controllers) controller.abort()
  }

  load(raw: unknown): Promise<RemoteImagesResult> {
    const input = requestSchemas['messages.loadImages'].parse(raw)
    const key = JSON.stringify([input.accountId, input.messageId])
    const existing = this.inflight.get(key)
    if (existing) return existing
    if (this.inflight.size >= 2)
      return Promise.reject(new MailError('NETWORK', '已有图片正在加载，请稍后重试。', true))
    const pending = this.loadMessage(input.accountId, input.messageId)
    this.inflight.set(key, pending)
    void pending.finally(() => this.inflight.delete(key)).catch(() => undefined)
    return pending
  }

  private async loadMessage(accountId: string, messageId: string): Promise<RemoteImagesResult> {
    const controller = new AbortController()
    this.controllers.add(controller)
    const { signal } = controller
    const timer = setTimeout(
      () => controller.abort(),
      this.dependencies.deadlineMs ?? REMOTE_IMAGE_LIMITS.deadlineMs
    )
    let receivedBytes = 0
    let receivedPixels = 0
    try {
      const message = await withinDeadline(
        this.dependencies.getMessage(accountId, messageId),
        signal
      )
      if (message.accountId !== accountId || message.id !== messageId)
        throw new MailError('VALIDATION', '邮件与账号不匹配。')
      const sources = remoteImageSources(message.body.html || '')
      const retained = sources.slice(0, REMOTE_IMAGE_LIMITS.images)
      const result: RemoteImagesResult = {
        images: [],
        failed: 0,
        skipped: sources.length - retained.length
      }
      let next = 0
      await Promise.all(
        Array.from(
          { length: Math.min(retained.length, REMOTE_IMAGE_LIMITS.concurrency) },
          async () => {
            while (next < retained.length) {
              const source = retained[next++]!
              try {
                const dataUrl = await this.download(
                  new URL(source),
                  signal,
                  (length) => {
                    receivedBytes += length
                    if (receivedBytes > REMOTE_IMAGE_LIMITS.totalBytes) {
                      controller.abort()
                      throw imageFailure()
                    }
                  },
                  (pixels) => {
                    if (receivedPixels + pixels > REMOTE_IMAGE_LIMITS.totalPixels)
                      throw imageFailure()
                    receivedPixels += pixels
                  }
                )
                result.images.push({ source, dataUrl })
              } catch {
                result.failed++
              }
            }
          }
        )
      )
      return result
    } finally {
      clearTimeout(timer)
      controller.abort()
      this.controllers.delete(controller)
    }
  }

  private async download(
    initial: URL,
    signal: AbortSignal,
    consume: (length: number) => void,
    consumePixels: (pixels: number) => void
  ): Promise<string> {
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
        const type = rasterType(content)
        if (!type || contentType !== `image/${type}`) throw imageFailure()
        const dimensions = imageSize(content)
        if (
          !dimensions.width ||
          !dimensions.height ||
          dimensions.width > REMOTE_IMAGE_LIMITS.dimension ||
          dimensions.height > REMOTE_IMAGE_LIMITS.dimension ||
          dimensions.width * dimensions.height > REMOTE_IMAGE_LIMITS.pixels
        )
          throw imageFailure()
        consumePixels(dimensions.width * dimensions.height)
        return `data:${contentType};base64,${content.toString('base64')}`
      } finally {
        response.dispose()
      }
    }
    throw imageFailure()
  }
}
