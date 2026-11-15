import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import type { CredentialVault } from '../core/ports'
import { MailError, type AppEvent, type Credentials, type Result } from '../shared/model'

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}
export class MailWorkerClient {
  private worker: UtilityProcess
  private pending = new Map<string, Pending>()
  private nextId = 0
  private ready: Promise<void>
  private closed = false
  constructor(
    dataDir: string,
    private vault: CredentialVault,
    emit: (event: AppEvent) => void
  ) {
    this.worker = utilityProcess.fork(join(__dirname, 'mail-worker.cjs'), [], {
      serviceName: 'Better Mail engine',
      env: { ...process.env, BETTER_MAIL_DATA_DIR: dataDir }
    })
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new MailError('INTERNAL', '邮件引擎启动超时')), 30_000)
      this.worker.on('message', (message) => {
        if (message.type === 'ready') {
          clearTimeout(timer)
          resolve()
        }
        if (message.type === 'fatal') {
          clearTimeout(timer)
          reject(new MailError('INTERNAL', message.message))
        }
      })
      this.worker.once('exit', () => {
        clearTimeout(timer)
        reject(new MailError('INTERNAL', '邮件引擎已退出'))
      })
    })
    void this.ready.catch(() => undefined)
    this.worker.on('message', (message) => {
      if (message.type === 'event') emit(message.event as AppEvent)
      if (message.type === 'vault') void this.handleVault(message)
      if (message.type === 'result') {
        const pending = this.pending.get(message.id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(message.id)
        const result = message.result as Result<unknown>
        if (result.ok) pending.resolve(result.value)
        else
          pending.reject(
            new MailError(result.error.code, result.error.message, result.error.retryable)
          )
      }
    })
    this.worker.on('exit', () => {
      this.closed = true
      for (const item of this.pending.values()) {
        clearTimeout(item.timer)
        item.reject(new MailError('INTERNAL', '邮件引擎已退出，请重新启动应用'))
      }
      this.pending.clear()
    })
  }
  private async handleVault(message: {
    id: string
    method: string
    accountId: string
    credentials?: Credentials
  }) {
    let result: Result<unknown>
    try {
      let value: unknown
      if (message.method === 'get') value = await this.vault.get(message.accountId)
      else if (message.method === 'set' && message.credentials)
        value = await this.vault.set(message.accountId, message.credentials)
      else if (message.method === 'delete') value = await this.vault.delete(message.accountId)
      else throw new MailError('VALIDATION', '无效的凭据请求')
      result = { ok: true, value }
    } catch (error) {
      const e =
        error instanceof MailError
          ? error
          : new MailError('VAULT_UNAVAILABLE', '系统安全存储访问失败')
      result = { ok: false, error: { code: e.code, message: e.message, retryable: e.retryable } }
    }
    if (!this.closed) this.worker.postMessage({ type: 'vault.result', id: message.id, result })
  }
  async request(method: string, input: unknown): Promise<unknown> {
    await this.ready
    if (this.closed) throw new MailError('INTERNAL', '邮件引擎不可用')
    const id = `${++this.nextId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new MailError('NETWORK', '操作仍在后台处理，请稍后查看状态', true))
      }, 180_000)
      this.pending.set(id, { resolve, reject, timer })
      this.worker.postMessage({ type: 'request', id, method, input })
    })
  }
  async stop() {
    if (this.closed) return
    try {
      await Promise.race([
        this.request('$shutdown', {}),
        new Promise((resolve) => setTimeout(resolve, 5000))
      ])
    } finally {
      if (!this.closed) this.worker.kill()
    }
  }
}
