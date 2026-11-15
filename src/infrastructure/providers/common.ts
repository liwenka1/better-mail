import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import nodemailer from 'nodemailer'
import { PublicClientApplication } from '@azure/msal-node'
import { OAuth2Client } from 'google-auth-library'
import { simpleParser } from 'mailparser'
import type { OutgoingMessage, ProviderSession, RemoteMessage, SyncPage } from '../../core/ports'
import { MailError, type Credentials, type ErrorCode, type FolderRole } from '../../shared/model'

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
export const MAX_BODY_BYTES = 5 * 1024 * 1024
export const PAGE_SIZE = 100

/** Internal HTTP status supports expired-delta recovery without exposing server bodies. */
export class ProviderHttpError extends MailError {
  constructor(
    code: ErrorCode,
    message: string,
    retryable: boolean,
    readonly status: number
  ) {
    super(code, message, retryable)
  }
}

export function folderRole(value: string): FolderRole {
  const key = value.toLowerCase().replace(/[^a-z]/g, '')
  if (['inbox'].includes(key)) return 'inbox'
  if (['sent', 'sentitems', 'sentmail'].includes(key)) return 'sent'
  if (['draft', 'drafts'].includes(key)) return 'drafts'
  if (['trash', 'deleteditems', 'deletedmessages'].includes(key)) return 'trash'
  if (['archive', 'all', 'allmail'].includes(key)) return 'archive'
  if (['junk', 'junkemail', 'spam'].includes(key)) return 'junk'
  return 'other'
}

export function providerError(error: unknown): MailError {
  if (error instanceof MailError) return error
  const e = error as { authenticationFailed?: boolean; code?: string; responseCode?: number }
  if (e.authenticationFailed || e.code === 'EAUTH' || e.responseCode === 535)
    return new MailError('AUTH', '邮箱授权失效，请重新连接账号')
  return new MailError('NETWORK', '无法连接邮箱服务，请检查网络及服务器配置', true)
}

/** A single account's work is serialized to bound IMAP connections and token refreshes. */
export class AccountSerial {
  private readonly tails = new Map<string, Promise<unknown>>()
  async run<T>(id: string, action: () => Promise<T>): Promise<T> {
    const before = this.tails.get(id) ?? Promise.resolve()
    const current = before.catch(() => undefined).then(action)
    this.tails.set(id, current)
    try {
      return await current
    } finally {
      if (this.tails.get(id) === current) this.tails.delete(id)
    }
  }
}

/** A lost/expired opaque checkpoint safely starts a new snapshot. Never reconcile a partial page. */
export class SnapshotPages {
  private readonly states = new Map<
    string,
    { token: string; next: string | null; ids: Set<string>; touched: number }
  >()
  begin(key: string, cursor: string | null): { next: string | null; reset: boolean } {
    const state = this.states.get(key)
    if (cursor && state?.token === cursor && Date.now() - state.touched < 30 * 60_000)
      return { next: state.next, reset: false }
    this.states.set(key, { token: randomUUID(), next: null, ids: new Set(), touched: Date.now() })
    return { next: null, reset: true }
  }
  finish(key: string, messages: RemoteMessage[], next: string | null, reset: boolean): SyncPage {
    const state = this.states.get(key)!
    for (const message of messages) state.ids.add(message.remoteId)
    state.next = next
    state.touched = Date.now()
    if (next) return { messages, removedIds: [], cursor: state.token, hasMore: true, reset }
    this.states.delete(key)
    return {
      messages,
      removedIds: [],
      cursor: null,
      hasMore: false,
      presentIds: [...state.ids],
      reset
    }
  }
  clear(): void {
    this.states.clear()
  }
  forgetAccount(accountId: string): void {
    for (const key of this.states.keys())
      if (key.startsWith(`${accountId}:`)) this.states.delete(key)
  }
}

export async function readBounded(
  stream: AsyncIterable<Uint8Array>,
  limit: number,
  cancel?: () => void
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of stream) {
      size += chunk.byteLength
      if (size > limit)
        throw new MailError(
          'UNSUPPORTED',
          `内容超过客户端大小限制（${Math.round(limit / 1024 / 1024)} MiB）`
        )
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks, size)
  } catch (error) {
    cancel?.()
    throw error
  }
}

/** No automatic retries: particularly important for send endpoints. */
export async function requestJson<T>(
  url: string,
  options: RequestInit = {},
  limit = MAX_BODY_BYTES,
  sending = false
): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(90_000)
    })
  } catch {
    if (sending)
      throw new MailError(
        'SEND_UNCERTAIN',
        '连接中断，邮件可能已被接受。请核对已发送邮件后再决定是否重发'
      )
    throw new MailError('NETWORK', '邮件服务请求失败，请稍后重试', true)
  }
  if (!response.ok) {
    await response.body?.cancel()
    if (sending && response.status >= 500)
      throw new MailError('SEND_UNCERTAIN', '邮件服务未确认发送结果，请核对已发送邮件，勿直接重发')
    if (response.status === 401 || response.status === 403)
      throw new ProviderHttpError(
        'AUTH',
        '邮箱授权已失效或缺少必要权限，请重新连接',
        false,
        response.status
      )
    if (response.status === 404)
      throw new ProviderHttpError('NOT_FOUND', '邮件或附件已不存在', false, 404)
    throw new ProviderHttpError(
      response.status >= 500 || response.status === 429 ? 'NETWORK' : 'VALIDATION',
      `邮件服务拒绝请求（HTTP ${response.status}）`,
      response.status === 429 || response.status >= 500,
      response.status
    )
  }
  if (response.status === 202 || response.status === 204) {
    await response.body?.cancel()
    return undefined as T
  }
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > limit) {
    await response.body?.cancel()
    if (sending)
      throw new MailError('SEND_UNCERTAIN', '服务已响应，但发送确认超过读取限制。请核对已发送邮件')
    throw new MailError('UNSUPPORTED', '邮件内容超过客户端大小限制')
  }
  if (!response.body) return undefined as T
  const reader = response.body.getReader()
  const iterable = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const result = await reader.read()
        if (result.done) break
        yield result.value
      }
    }
  }
  try {
    const data = await readBounded(iterable, limit, () => {
      void reader.cancel()
    })
    return data.length ? (JSON.parse(data.toString('utf8')) as T) : (undefined as T)
  } catch (error) {
    if (sending)
      throw new MailError('SEND_UNCERTAIN', '服务已响应，但发送确认读取失败。请核对已发送邮件')
    if (error instanceof MailError) throw error
    throw new MailError('NETWORK', '邮件服务响应不完整，请重试', true)
  }
}

export class AccessTokens {
  private readonly serial = new AccountSerial()
  async get(session: ProviderSession): Promise<string> {
    return this.serial.run(session.account.id, async () => {
      const old = session.credentials
      if (old.accessToken && (!old.expiresAt || old.expiresAt > Date.now() + 60_000))
        return old.accessToken
      if (session.config.kind === 'gmail' && old.refreshToken) {
        let updated: Credentials
        try {
          const client = new OAuth2Client({
            clientId: session.config.clientId,
            clientSecret: old.clientSecret,
            transporterOptions: { timeout: 30_000 }
          })
          client.setCredentials({ refresh_token: old.refreshToken })
          const { credentials } = await client.refreshAccessToken()
          if (!credentials.access_token) throw new MailError('AUTH', '无法刷新邮箱授权，请重新连接')
          updated = {
            ...old,
            accessToken: credentials.access_token,
            refreshToken: credentials.refresh_token ?? old.refreshToken,
            expiresAt: credentials.expiry_date ?? undefined
          }
        } catch (error) {
          if (error instanceof MailError) throw error
          const status = (error as { response?: { status?: number } }).response?.status
          throw new MailError(
            status === 400 || status === 401 ? 'AUTH' : 'NETWORK',
            status === 400 || status === 401
              ? 'Google 授权已失效，请重新连接邮箱'
              : 'Google 授权刷新暂时失败，请检查网络后重试',
            status !== 400 && status !== 401
          )
        }
        await session.updateCredentials(updated)
        session.credentials = updated
        return updated.accessToken!
      }
      if (session.config.kind === 'graph' && old.tokenCache) {
        try {
          const client = new PublicClientApplication({
            auth: {
              clientId: session.config.clientId,
              authority: `https://login.microsoftonline.com/${encodeURIComponent(session.config.tenant)}`
            }
          })
          client.getTokenCache().deserialize(old.tokenCache)
          const accounts = await client.getTokenCache().getAllAccounts()
          const account =
            accounts.find(
              (item) => item.username.toLowerCase() === session.account.email.toLowerCase()
            ) ?? (accounts.length === 1 ? accounts[0] : undefined)
          if (!account) throw new MailError('AUTH', '授权缓存内找不到对应邮箱，请重新连接')
          const result = await client.acquireTokenSilent({
            account,
            scopes: [
              'https://graph.microsoft.com/Mail.ReadWrite',
              'https://graph.microsoft.com/Mail.Send',
              'https://graph.microsoft.com/User.Read'
            ]
          })
          if (!result?.accessToken) throw new MailError('AUTH', '无法刷新邮箱授权，请重新连接')
          const updated: Credentials = {
            ...old,
            accessToken: result.accessToken,
            expiresAt: result.expiresOn?.getTime(),
            tokenCache: client.getTokenCache().serialize()
          }
          await session.updateCredentials(updated)
          session.credentials = updated
          return updated.accessToken!
        } catch (error) {
          if (error instanceof MailError) throw error
          throw new MailError('AUTH', 'Microsoft 授权刷新失败，请重新连接账号')
        }
      }
      if (!old.refreshToken || (session.config.kind !== 'gmail' && session.config.kind !== 'graph'))
        throw new MailError('AUTH', '缺少可用授权，请重新连接账号')
      const config = session.config
      const endpoint =
        config.kind === 'gmail'
          ? 'https://oauth2.googleapis.com/token'
          : `https://login.microsoftonline.com/${encodeURIComponent(config.tenant)}/oauth2/v2.0/token`
      const body = new URLSearchParams({
        client_id: config.clientId,
        grant_type: 'refresh_token',
        refresh_token: old.refreshToken
      })
      if (old.clientSecret) body.set('client_secret', old.clientSecret)
      let response: { access_token: string; refresh_token?: string; expires_in?: number }
      try {
        response = await requestJson(
          endpoint,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
          },
          1024 * 1024
        )
      } catch (error) {
        if (error instanceof MailError && error.code === 'VALIDATION')
          throw new MailError('AUTH', '授权已过期，请重新连接邮箱')
        throw error
      }
      if (!response.access_token) throw new MailError('AUTH', '邮箱未返回有效授权，请重新连接')
      const updated: Credentials = {
        ...old,
        accessToken: response.access_token,
        refreshToken: response.refresh_token ?? old.refreshToken,
        expiresAt: Date.now() + (response.expires_in ?? 3600) * 1000
      }
      await session.updateCredentials(updated)
      session.credentials = updated
      return updated.accessToken!
    })
  }
}

export async function validateOutgoing(
  message: OutgoingMessage,
  maxBytes = MAX_ATTACHMENT_BYTES
): Promise<void> {
  let size = Buffer.byteLength(message.text) + Buffer.byteLength(message.html ?? '')
  for (const attachment of message.attachments) {
    const info = await stat(attachment.path)
    if (!info.isFile()) throw new MailError('VALIDATION', '附件必须是普通文件')
    size += info.size
    if (size > maxBytes)
      throw new MailError(
        'UNSUPPORTED',
        `邮件及附件合计不能超过 ${Math.floor(maxBytes / 1024 / 1024)} MiB`
      )
  }
  if (size > maxBytes) throw new MailError('UNSUPPORTED', '邮件正文过大')
}

export async function composeRaw(message: OutgoingMessage): Promise<Buffer> {
  await validateOutgoing(message)
  const composer = nodemailer.createTransport({
    streamTransport: true,
    buffer: false,
    newline: 'windows'
  })
  const result = await composer.sendMail({
    ...message,
    date: message.date === undefined ? undefined : new Date(message.date),
    html: message.html ?? undefined,
    disableUrlAccess: true
  })
  if (Buffer.isBuffer(result.message)) {
    if (result.message.length > MAX_ATTACHMENT_BYTES)
      throw new MailError('UNSUPPORTED', '原始邮件超过 50 MiB')
    return result.message
  }
  return readBounded(result.message, MAX_ATTACHMENT_BYTES)
}

/** Remove only private recipient headers; MIME body bytes and boundaries remain frozen. */
export function smtpDeliveryRaw(raw: Uint8Array): Buffer {
  const bytes = Buffer.from(raw)
  const boundary = bytes.indexOf('\r\n\r\n')
  if (boundary < 0) throw new MailError('VALIDATION', '已准备的邮件格式无效，尚未投递。')
  const retained: string[] = []
  let privateHeader = false
  for (const line of bytes.subarray(0, boundary).toString('latin1').split('\r\n')) {
    if (!/^[\t ]/.test(line)) privateHeader = /^(?:resent-)?bcc[\t ]*:/i.test(line)
    if (!privateHeader) retained.push(line)
  }
  return Buffer.concat([Buffer.from(retained.join('\r\n'), 'latin1'), bytes.subarray(boundary)])
}

export function messageIdMatches(values: readonly string[], expected: string): boolean {
  return values.length === 1 && values[0]!.trim() === expected.trim()
}

/** SEARCH HEADER is a substring search; verify one complete Message-ID before reconciling. */
export async function exactMessageIdHeader(
  headers: Uint8Array | undefined,
  expected: string
): Promise<boolean> {
  if (!headers?.byteLength)
    throw new MailError('NETWORK', '服务器未返回副本标识，尚未尝试保存副本。', true)
  if (headers.byteLength > 64 * 1024)
    throw new MailError('UNSUPPORTED', '副本标识响应过大，无法安全核验。')
  const parsed = await simpleParser(
    Buffer.concat([Buffer.from(headers), Buffer.from('\r\n\r\n')]),
    { skipHtmlToText: true, skipTextToHtml: true }
  )
  const identifiers = parsed.headerLines.filter((line) => line.key.toLowerCase() === 'message-id')
  if (identifiers.length !== 1)
    throw new MailError('VALIDATION', '已发送邮件标识缺失或重复，尚未尝试保存副本。')
  return messageIdMatches(parsed.messageId ? [parsed.messageId] : [], expected)
}
