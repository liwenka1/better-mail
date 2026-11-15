import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { MailService } from '../core/service'
import { SqliteStore } from '../infrastructure/storage'
import {
  DemoProvider,
  GmailProvider,
  GraphProvider,
  ImapProvider
} from '../infrastructure/providers'
import { MailError, type Credentials, type Result } from '../shared/model'
import type { CredentialVault } from '../core/ports'
import type { Method } from '../shared/contracts'
import { parseSyncWakeReason } from './sync-wake'

const port = process.parentPort!
const root = process.env.BETTER_MAIL_DATA_DIR
if (!root || !port) throw new Error('Mail engine requires a data directory and a parent port')
const vaultPending = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
>()
let nextVaultId = 0
function vaultRequest(
  method: string,
  accountId: string,
  credentials?: Credentials
): Promise<unknown> {
  const id = `vault:${++nextVaultId}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      vaultPending.delete(id)
      reject(new MailError('VAULT_UNAVAILABLE', '系统安全存储响应超时'))
    }, 60_000)
    vaultPending.set(id, { resolve, reject, timer })
    port.postMessage({ type: 'vault', id, method, accountId, credentials })
  })
}
const vault: CredentialVault = {
  get: (id) => vaultRequest('get', id) as Promise<Credentials | null>,
  set: (id, credentials) => vaultRequest('set', id, credentials) as Promise<void>,
  delete: (id) => vaultRequest('delete', id) as Promise<void>
}
async function boot() {
  mkdirSync(root!, { recursive: true, mode: 0o700 })
  const store = new SqliteStore(join(root!, 'mail.sqlite'))
  const providers = [
    new ImapProvider(),
    new GmailProvider(),
    new GraphProvider(),
    new DemoProvider(join(root!, 'demo-state.json'))
  ]
  const service = new MailService({
    store,
    providers,
    vault,
    emit: (event) => port.postMessage({ type: 'event', event }),
    attachmentDir: join(root!, 'attachments')
  })
  port.on('message', async ({ data }) => {
    if (data.type === 'vault.result') {
      const pending = vaultPending.get(data.id)
      if (!pending) return
      clearTimeout(pending.timer)
      vaultPending.delete(data.id)
      if (data.result.ok) pending.resolve(data.result.value)
      else pending.reject(new MailError(data.result.error.code, data.result.error.message))
      return
    }
    if (data.type !== 'request') return
    let result: Result<unknown>
    try {
      let value: unknown
      if (data.method === '$shutdown') {
        await service.stop()
        store.close()
      } else if (data.method === '$sync.wake') {
        service.notifyEnvironmentChange(parseSyncWakeReason(data.input))
      } else if (data.method === '$oauth.add') value = await service.addOAuthAccount(data.input)
      else if (data.method === '$attachments.import')
        value = await service.importAttachments(data.input.paths)
      else if (data.method === '$attachments.download')
        value = await service.downloadAttachment(data.input)
      else value = await service.handle(data.method as Method, data.input)
      result = { ok: true, value }
    } catch (error) {
      const e =
        error instanceof MailError
          ? error
          : new MailError('INTERNAL', '操作未完成，请查看账号状态后重试')
      // Do not forward raw provider exceptions (may contain credentials or message contents).
      result = { ok: false, error: { code: e.code, message: e.message, retryable: e.retryable } }
    }
    port.postMessage({ type: 'result', id: data.id, result })
  })
  service.start()
  port.postMessage({ type: 'ready' })
}
void boot().catch(() => {
  port.postMessage({ type: 'fatal', message: '邮件数据库或引擎初始化失败，请检查本机数据目录权限' })
  process.exitCode = 1
})
