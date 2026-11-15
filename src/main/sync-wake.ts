import { MailError } from '../shared/model'

export type SyncWakeReason = 'resume' | 'online' | 'foreground'

interface WakeEventSource {
  on(event: string, listener: () => void): unknown
  removeListener(event: string, listener: () => void): unknown
}

interface SyncWakeOptions {
  powerMonitor: WakeEventSource
  isOnline: () => boolean
  notify: (reason: SyncWakeReason) => void | Promise<unknown>
  now?: () => number
}

/** This input is private to the host/worker channel, never a renderer method. */
export function parseSyncWakeReason(input: unknown): SyncWakeReason {
  if (input && typeof input === 'object' && !Array.isArray(input) && 'reason' in input) {
    const reason = input.reason
    if (reason === 'resume' || reason === 'online' || reason === 'foreground') return reason
  }
  throw new MailError('VALIDATION', '无效的后台同步唤醒信号。')
}

const priority: Record<SyncWakeReason, number> = { foreground: 0, online: 1, resume: 2 }

/** Host signals are hints. The core owns synchronization, backoff and account state. */
export class SyncWakeController {
  private readonly windows = new Map<WakeEventSource, () => void>()
  private readonly lastSent = new Map<SyncWakeReason, number>()
  private readonly now: () => number
  private readonly onlineTimer: ReturnType<typeof setInterval>
  private wakeTimer: ReturnType<typeof setTimeout> | null = null
  private pending: SyncWakeReason | null = null
  private online: boolean | null
  private disposed = false
  private readonly resumed = (): void => this.schedule('resume')

  constructor(private readonly options: SyncWakeOptions) {
    this.now = options.now ?? (() => performance.now())
    this.online = this.readOnline()
    options.powerMonitor.on('resume', this.resumed)
    options.powerMonitor.on('unlock-screen', this.resumed)
    this.onlineTimer = setInterval(() => this.pollOnline(), 30_000)
    this.onlineTimer.unref?.()
  }

  register(window: WakeEventSource): void {
    if (this.disposed || this.windows.has(window)) return
    const focused = (): void => this.schedule('foreground')
    const unregister = (): void => {
      window.removeListener('focus', focused)
      window.removeListener('closed', unregister)
      this.windows.delete(window)
    }
    window.on('focus', focused)
    window.on('closed', unregister)
    this.windows.set(window, unregister)
  }

  private readOnline(): boolean | null {
    try {
      return this.options.isOnline()
    } catch {
      // An unavailable OS connectivity hint must not stop background polling.
      return null
    }
  }

  private pollOnline(): void {
    if (this.disposed) return
    const online = this.readOnline()
    if (online === null) return
    if (this.online === false && online) this.schedule('online')
    this.online = online
  }

  private schedule(reason: SyncWakeReason): void {
    if (this.disposed) return
    const last = this.lastSent.get(reason)
    if (last !== undefined && this.now() - last < 1000) return
    if (this.pending === null || priority[reason] > priority[this.pending]) this.pending = reason
    if (this.wakeTimer) return
    // A wake commonly emits resume, unlock and focus together. Send one hint.
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null
      const next = this.pending
      this.pending = null
      if (this.disposed || !next) return
      this.lastSent.set(next, this.now())
      void Promise.resolve()
        .then(() => {
          if (!this.disposed) return this.options.notify(next)
          return undefined
        })
        .catch(() => {
          // The engine reports its own failures. Future wake/poll signals remain usable.
        })
    }, 150)
    this.wakeTimer.unref?.()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearInterval(this.onlineTimer)
    if (this.wakeTimer) clearTimeout(this.wakeTimer)
    this.wakeTimer = null
    this.pending = null
    this.options.powerMonitor.removeListener('resume', this.resumed)
    this.options.powerMonitor.removeListener('unlock-screen', this.resumed)
    for (const unregister of this.windows.values()) unregister()
    this.windows.clear()
    this.lastSent.clear()
  }
}
