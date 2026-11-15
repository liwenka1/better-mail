import { randomUUID } from 'node:crypto'
import { MailError } from '../shared/model'
import { windowCloseResolutionSchema } from '../shared/window-contracts'
import type { WindowCloseRequest } from '../shared/window'

export interface CloseTarget {
  isDestroyed(): boolean
  close(): void
}
interface CloseOptions {
  emit: (window: CloseTarget, request: WindowCloseRequest) => void
  reveal?: (window: CloseTarget) => void
  quit: () => Promise<void>
  defer?: (action: () => void) => void
}

/** No timeout can silently discard edits. Only this target's one-use ack permits exit. */
export class WindowCloseCoordinator {
  private readonly targets = new Set<CloseTarget>()
  private readonly ready = new Set<CloseTarget>()
  private readonly approved = new Set<CloseTarget>()
  private readonly pending = new Map<CloseTarget, WindowCloseRequest>()
  private quitting = false
  constructor(private readonly options: CloseOptions) {}

  register(window: CloseTarget): void {
    this.targets.add(window)
  }
  rendererReady(window: CloseTarget): void {
    if (this.targets.has(window)) this.ready.add(window)
  }
  rendererGone(window: CloseTarget): void {
    this.ready.delete(window)
    this.pending.delete(window)
  }
  unregister(window: CloseTarget): void {
    this.targets.delete(window)
    this.ready.delete(window)
    this.approved.delete(window)
    this.pending.delete(window)
  }
  /** Return true when the native close event must be prevented. */
  interceptClose(window: CloseTarget): boolean {
    if (this.quitting || this.approved.delete(window)) return false
    if (!this.ready.has(window)) return false
    this.request(window, 'close')
    return true
  }
  request(window: CloseTarget | undefined, reason: WindowCloseRequest['reason']): void {
    if (this.quitting) return
    if (!window || window.isDestroyed() || !this.targets.has(window)) {
      if (reason === 'quit') this.beginQuit()
      return
    }
    if (!this.ready.has(window)) {
      if (reason === 'quit') this.beginQuit()
      else
        this.defer(() => {
          if (!window.isDestroyed()) {
            this.approved.add(window)
            window.close()
          }
        })
      return
    }
    // A previous prompt can itself have been minimized. Reveal the host on
    // every explicit attempt without issuing duplicate confirmation tokens.
    this.options.reveal?.(window)
    const existing = this.pending.get(window)
    if (existing) {
      if (reason === 'quit') existing.reason = 'quit'
      return
    }
    const request: WindowCloseRequest = { requestId: randomUUID(), reason }
    this.pending.set(window, request)
    this.options.emit(window, { ...request })
  }
  resolve(window: CloseTarget, input: unknown): void {
    const parsed = windowCloseResolutionSchema.safeParse(input)
    const request = this.pending.get(window)
    if (!parsed.success || !request || request.requestId !== parsed.data.requestId)
      throw new MailError('VALIDATION', '关闭确认已经失效，请重新操作。')
    this.pending.delete(window)
    if (!parsed.data.allow) return
    if (request.reason === 'quit')
      this.defer(() => {
        this.beginQuit()
      })
    else
      this.defer(() => {
        if (!window.isDestroyed()) {
          this.approved.add(window)
          window.close()
        }
      })
  }
  /** Called only after approval, before app.quit emits each window's close event. */
  allowQuit(): void {
    this.quitting = true
    this.pending.clear()
  }
  private beginQuit(): void {
    if (this.quitting) return
    this.quitting = true
    this.pending.clear()
    void this.options.quit().catch(() => undefined)
  }
  private defer(action: () => void): void {
    ;(this.options.defer ?? setImmediate)(action)
  }
}

interface RendererLifecycleSource {
  on(event: string, callback: () => void): unknown
  removeListener(event: string, callback: () => void): unknown
}

/** A blocked navigation attempt must not revoke the live document's guard. */
export function bindRendererCloseLifecycle(
  coordinator: WindowCloseCoordinator,
  window: CloseTarget,
  contents: RendererLifecycleSource
): () => void {
  const committedOrGone = (): void => {
    coordinator.rendererGone(window)
  }
  contents.on('did-navigate', committedOrGone)
  contents.on('render-process-gone', committedOrGone)
  return () => {
    contents.removeListener('did-navigate', committedOrGone)
    contents.removeListener('render-process-gone', committedOrGone)
  }
}
