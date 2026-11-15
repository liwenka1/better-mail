import { createServer, type Server } from 'node:http'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library'
import { PublicClientApplication } from '@azure/msal-node'
import { MailError, type Credentials, type OAuthInput, type ProviderConfig } from '../shared/model'

export interface OAuthIdentity {
  email: string
  name: string
  color: string
  config: ProviderConfig
  credentials: Credentials
}
export function validateOAuthState(actual: string | null, expected: string): boolean {
  if (!actual) return false
  const supplied = Buffer.from(actual)
  const wanted = Buffer.from(expected)
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted)
}
/** An ephemeral loopback listener, bound only to the local interface. */
async function callbackServer(host: string, state: string) {
  let server: Server
  let resolve!: (code: string) => void
  let reject!: (error: Error) => void
  const code = new Promise<string>((yes, no) => {
    resolve = yes
    reject = no
  })
  // A browser-open failure may precede the awaited callback.
  void code.catch(() => undefined)
  server = createServer((request, response) => {
    let url: URL
    try {
      url = new URL(request.url ?? '/', 'http://localhost')
    } catch {
      response.writeHead(400).end()
      return
    }
    if (request.method !== 'GET' || url.pathname !== '/') {
      response.writeHead(404).end()
      return
    }
    if (!validateOAuthState(url.searchParams.get('state'), state)) {
      response.writeHead(400).end('Invalid authorization state.')
      return
    }
    response.setHeader('Content-Type', 'text/plain; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Security-Policy', "default-src 'none'")
    if (url.searchParams.has('error')) {
      response.end('授权已取消，可以关闭此页面并返回 Better Mail。')
      reject(new MailError('CANCELLED', '邮箱授权已取消'))
    } else if (url.searchParams.get('code')) {
      response.end('授权完成，可以关闭此页面并返回 Better Mail。')
      resolve(url.searchParams.get('code')!)
    } else {
      response.writeHead(400).end('Missing authorization code.')
      return
    }
    server.close()
  })
  await new Promise<void>((yes, no) => {
    server.once('error', no)
    server.listen(0, '127.0.0.1', yes)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new MailError('INTERNAL', '无法启动本机授权回调')
  const timer = setTimeout(() => {
    reject(new MailError('CANCELLED', '授权超时，请重试'))
    server.close()
  }, 180_000)
  timer.unref()
  return {
    redirectUri: `http://${host}:${address.port}`,
    code,
    close: () => {
      clearTimeout(timer)
      server.close()
    }
  }
}

export async function authorizeMailbox(
  input: OAuthInput,
  openBrowser: (url: string) => Promise<void>
): Promise<OAuthIdentity> {
  const state = randomBytes(32).toString('base64url')
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const callback = await callbackServer(
    input.provider === 'gmail' ? '127.0.0.1' : 'localhost',
    state
  )
  try {
    if (input.provider === 'gmail') {
      const client = new OAuth2Client({
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        redirectUri: callback.redirectUri
      })
      const url = client.generateAuthUrl({
        scope: ['https://www.googleapis.com/auth/gmail.modify'],
        access_type: 'offline',
        prompt: 'consent',
        state,
        code_challenge: challenge,
        code_challenge_method: CodeChallengeMethod.S256
      })
      await openBrowser(url)
      const { tokens } = await client.getToken({
        code: await callback.code,
        codeVerifier: verifier
      })
      client.setCredentials(tokens)
      const response = await client.request<{ emailAddress: string }>({
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
        timeout: 30_000
      })
      if (!tokens.refresh_token)
        throw new MailError('AUTH', '未获得离线授权，请撤销旧授权后重新连接')
      return {
        email: response.data.emailAddress,
        name: input.name,
        color: input.color,
        config: { kind: 'gmail', clientId: input.clientId },
        credentials: {
          accessToken: tokens.access_token ?? undefined,
          refreshToken: tokens.refresh_token,
          expiresAt: tokens.expiry_date ?? undefined,
          clientSecret: input.clientSecret
        }
      }
    }
    const tenant = input.tenant || 'common'
    const client = new PublicClientApplication({
      auth: { clientId: input.clientId, authority: `https://login.microsoftonline.com/${tenant}` }
    })
    const scopes = [
      'https://graph.microsoft.com/Mail.ReadWrite',
      'https://graph.microsoft.com/Mail.Send',
      'https://graph.microsoft.com/User.Read',
      'offline_access'
    ]
    const url = await client.getAuthCodeUrl({
      scopes,
      redirectUri: callback.redirectUri,
      state,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      prompt: 'select_account'
    })
    await openBrowser(url)
    const result = await client.acquireTokenByCode({
      code: await callback.code,
      scopes,
      redirectUri: callback.redirectUri,
      codeVerifier: verifier
    })
    if (!result?.accessToken) throw new MailError('AUTH', '未获得 Microsoft 授权')
    const response = await fetch(
      'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName',
      {
        headers: { Authorization: `Bearer ${result.accessToken}` },
        signal: AbortSignal.timeout(30_000)
      }
    )
    if (!response.ok) throw new MailError('AUTH', '无法获取 Microsoft 邮箱资料')
    const profile = (await response.json()) as { mail?: string; userPrincipalName?: string }
    const email = profile.mail || profile.userPrincipalName
    if (!email) throw new MailError('AUTH', '此账号没有可用邮箱地址')
    return {
      email,
      name: input.name,
      color: input.color,
      config: { kind: 'graph', clientId: input.clientId, tenant },
      credentials: {
        accessToken: result.accessToken,
        expiresAt: result.expiresOn?.getTime(),
        tokenCache: client.getTokenCache().serialize()
      }
    }
  } catch (error) {
    if (error instanceof MailError) throw error
    throw new MailError('AUTH', '邮箱授权失败，请检查应用注册、回调地址和网络后重试')
  } finally {
    callback.close()
  }
}
