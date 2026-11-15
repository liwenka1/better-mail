import { safeStorage } from 'electron'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { CredentialVault } from '../core/ports'
import { MailError, type Credentials } from '../shared/model'

/** OS-bound encrypted values only. Never writes a plaintext fallback. */
export class SystemVault implements CredentialVault {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private directory: string) {}
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const work = this.tail.catch(() => undefined).then(action)
    this.tail = work
    return work
  }
  private path(id: string) {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new MailError('VALIDATION', '无效的凭据标识')
    return join(this.directory, `${id}.secret`)
  }
  private async available() {
    if (
      !(await safeStorage.isAsyncEncryptionAvailable()) ||
      (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
    ) {
      throw new MailError(
        'VAULT_UNAVAILABLE',
        '系统安全存储不可用，请解锁钥匙串或启用系统密钥环后重试'
      )
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
  }
  get(id: string): Promise<Credentials | null> {
    return this.serialize(async () => {
      let bytes: Buffer
      try {
        bytes = await readFile(this.path(id))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
      await this.available()
      try {
        const decrypted = await safeStorage.decryptStringAsync(bytes)
        const credentials = JSON.parse(decrypted.result) as Credentials
        if (decrypted.shouldReEncrypt) await this.write(id, credentials)
        return credentials
      } catch {
        throw new MailError('VAULT_UNAVAILABLE', '无法解密账号凭据，请重新授权账号')
      }
    })
  }
  private async write(id: string, credentials: Credentials): Promise<void> {
    const path = this.path(id)
    await this.available()
    const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(credentials))
    await writeFile(`${path}.tmp`, encrypted, { mode: 0o600 })
    await rename(`${path}.tmp`, path)
  }
  set(id: string, credentials: Credentials): Promise<void> {
    return this.serialize(() => this.write(id, credentials))
  }
  delete(id: string): Promise<void> {
    return this.serialize(async () => {
      const { unlink } = await import('node:fs/promises')
      try {
        await unlink(this.path(id))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    })
  }
}
