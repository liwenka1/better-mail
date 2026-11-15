import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'

export const MAIL_DOCUMENT_REVISION_META = 'better-mail-document'
export const MAX_MAIL_FRAME_HEIGHT = 1_000_000

function frameDocument(frame: HTMLIFrameElement): Document | null {
  try {
    return frame.contentDocument
  } catch {
    return null
  }
}

/** Parent-owned observers measure an inert document; received HTML never executes. */
export function observeMailFrameHeight(
  frame: HTMLIFrameElement,
  revision: string,
  onHeightLimit: (text: string) => void,
  isCurrent: () => boolean = () => true
): () => void {
  const document = frameDocument(frame)
  const body = document?.body
  if (
    !document ||
    !body ||
    document
      .querySelector(`meta[name="${MAIL_DOCUMENT_REVISION_META}"]`)
      ?.getAttribute('content') !== revision
  )
    return () => undefined

  let active = true
  let pendingFrame = 0
  let reportedLimit = false
  const current = () =>
    active && frame.isConnected && isCurrent() && frameDocument(frame) === document
  const measure = () => {
    pendingFrame = 0
    if (!current()) return
    // Body uses a flow-root and intrinsic height. document.scrollHeight would
    // include the old iframe viewport and prevent shrinking on wider windows.
    const naturalHeight = body.getBoundingClientRect().height
    if (!Number.isFinite(naturalHeight) || naturalHeight < 0) return
    if (naturalHeight > MAX_MAIL_FRAME_HEIGHT) {
      if (!reportedLimit) {
        reportedLimit = true
        onHeightLimit(body.innerText ?? body.textContent ?? '')
      }
      return
    }
    const height = Math.max(1, Math.ceil(naturalHeight) + 1)
    if (frame.style.height !== `${height}px`) frame.style.height = `${height}px`
  }
  const schedule = () => {
    if (current() && !pendingFrame) pendingFrame = requestAnimationFrame(measure)
  }
  const observer = new ResizeObserver(schedule)
  observer.observe(body)
  // Images and native disclosures can change the content after its initial load.
  document.addEventListener('load', schedule, true)
  document.addEventListener('toggle', schedule, true)
  window.addEventListener('resize', schedule)
  schedule()
  return () => {
    active = false
    observer.disconnect()
    document.removeEventListener('load', schedule, true)
    document.removeEventListener('toggle', schedule, true)
    window.removeEventListener('resize', schedule)
    if (pendingFrame) cancelAnimationFrame(pendingFrame)
  }
}

export function useMailFrameHeight(
  frameRef: RefObject<HTMLIFrameElement | null>,
  revision: string,
  onHeightLimit?: (text: string) => void
): () => void {
  const currentRevision = useRef(revision)
  const limitCallback = useRef(onHeightLimit)
  const dispose = useRef<(() => void) | undefined>(undefined)
  useLayoutEffect(() => {
    currentRevision.current = revision
    limitCallback.current = onHeightLimit
  }, [revision, onHeightLimit])
  const onLoad = useCallback(() => {
    dispose.current?.()
    dispose.current = undefined
    const frame = frameRef.current
    if (!frame || currentRevision.current !== revision) return
    dispose.current = observeMailFrameHeight(
      frame,
      revision,
      (text) => limitCallback.current?.(text),
      () => frameRef.current === frame && currentRevision.current === revision
    )
  }, [frameRef, revision])
  useLayoutEffect(() => {
    onLoad()
    return () => {
      dispose.current?.()
      dispose.current = undefined
    }
  }, [onLoad])
  return onLoad
}
