import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ImageOff } from 'lucide-react'
import type { RemoteImagesResult } from '../../../shared/remote-images'
import type { WindowTheme } from '../../../shared/window'
import { prepareMailDocument } from '../security'
import { MAIL_DOCUMENT_REVISION_META, useMailFrameHeight } from '../useMailFrameHeight'
import { errorMessage, request } from '../lib'
import { Button } from './ui/button'
import { Spinner } from './primitives'
import '../remote-images.css'

interface ImageState {
  scope: string
  html: string
  bodyHash?: string
  restoring: boolean
  pending: boolean
  hidden: boolean
  result?: RemoteImagesResult
  error?: string
  cacheError?: boolean
}

async function bodyFingerprint(html: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(html))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Loading images grants this document no network or script permissions. */
export function MailHtmlBody({
  accountId,
  messageId,
  html,
  theme,
  onHeightLimit
}: {
  accountId: string
  messageId: string
  html: string
  theme: WindowTheme
  onHeightLimit?: (text: string) => void
}) {
  const scope = JSON.stringify([accountId, messageId])
  const identity = useMemo(() => ({ scope, html }), [scope, html])
  const activeIdentity = useRef<typeof identity | null>(identity)
  useLayoutEffect(() => {
    activeIdentity.current = identity
    return () => {
      if (activeIdentity.current === identity) activeIdentity.current = null
    }
  }, [identity])
  const [state, setState] = useState<ImageState>({
    scope,
    html,
    restoring: true,
    pending: false,
    hidden: false
  })
  const inFlight = useRef<{ identity: typeof identity } | null>(null)
  const current: ImageState =
    state.scope === scope && state.html === html
      ? state
      : { scope, html, restoring: true, pending: false, hidden: false }
  const images = useMemo(
    () =>
      new Map(
        current.hidden ? [] : current.result?.images.map((image) => [image.source, image.dataUrl])
      ),
    [current.result, current.hidden]
  )
  const prepared = useMemo(() => prepareMailDocument(html, images), [html, images])
  const frameDocument = useMemo(() => {
    const revision = crypto.randomUUID()
    return {
      revision,
      html: prepared.document.replace(
        '<head>',
        `<head><meta name="${MAIL_DOCUMENT_REVISION_META}" content="${revision}">`
      )
    }
  }, [prepared.document])
  const frame = useRef<HTMLIFrameElement | null>(null)
  const onFrameLoad = useMailFrameHeight(frame, frameDocument.revision, onHeightLimit)
  const loaded = prepared.loadedImageCount
  const hasRemoteImages = prepared.remoteImageCount > 0
  const hasCachedImages = Boolean(current.result?.images.length)
  useEffect(() => {
    const ticket = { identity }
    inFlight.current = ticket
    let bodyHash: string | undefined
    setState({ scope, html, restoring: hasRemoteImages, pending: false, hidden: false })
    if (hasRemoteImages)
      void (async () => {
        try {
          bodyHash = await bodyFingerprint(html)
          if (inFlight.current !== ticket || activeIdentity.current !== identity) return
          const result = await request('messages.cachedImages', { accountId, messageId, bodyHash })
          if (inFlight.current !== ticket || activeIdentity.current !== identity) return
          setState({
            scope,
            html,
            bodyHash,
            restoring: false,
            pending: false,
            hidden: false,
            result: result.images.length ? result : undefined
          })
        } catch (caught) {
          if (inFlight.current !== ticket || activeIdentity.current !== identity) return
          setState({
            scope,
            html,
            bodyHash,
            restoring: false,
            pending: false,
            hidden: false,
            error: errorMessage(caught),
            cacheError: true
          })
        } finally {
          if (inFlight.current === ticket) inFlight.current = null
        }
      })()
    else inFlight.current = null
    return () => {
      if (inFlight.current?.identity === identity) inFlight.current = null
    }
  }, [accountId, messageId, scope, html, identity, hasRemoteImages])
  async function loadImages() {
    if (inFlight.current?.identity === identity || activeIdentity.current !== identity) return
    const ticket = { identity }
    inFlight.current = ticket
    setState({ ...current, pending: true, error: undefined, cacheError: false })
    try {
      const bodyHash = current.bodyHash || (await bodyFingerprint(html))
      if (inFlight.current !== ticket || activeIdentity.current !== identity) return
      const result = await request('messages.loadImages', { accountId, messageId, bodyHash })
      if (inFlight.current === ticket && activeIdentity.current === identity)
        setState({
          scope,
          html,
          bodyHash,
          restoring: false,
          pending: false,
          hidden: false,
          result
        })
    } catch (caught) {
      if (inFlight.current === ticket && activeIdentity.current === identity)
        setState({ ...current, pending: false, error: errorMessage(caught), cacheError: false })
    } finally {
      if (inFlight.current === ticket) inFlight.current = null
    }
  }
  return (
    <>
      {prepared.remoteImageCount > 0 && (
        <div
          className="remote-image-notice"
          aria-busy={current.pending || current.restoring || undefined}
        >
          <ImageOff size={15} aria-hidden="true" />
          <div className="remote-image-copy">
            <p role="status" aria-live="polite">
              {current.restoring
                ? '正在读取本地图片…'
                : current.pending
                  ? '正在加载远程图片…'
                  : current.error
                    ? current.cacheError
                      ? '本地图片缓存读取失败'
                      : '远程图片加载失败'
                    : current.hidden
                      ? '本封邮件的图片已隐藏'
                      : current.result
                        ? loaded === prepared.remoteImageCount
                          ? '已显示本封邮件的图片'
                          : `已显示 ${loaded} / ${prepared.remoteImageCount} 张图片，其余图片可手动加载。`
                        : `已阻止 ${prepared.remoteImageCount} 张远程图片自动加载`}
            </p>
            <small>手动加载会连接图片服务器，可能让发件人知道你已阅读。</small>
            {current.error && <small role="alert">{current.error}</small>}
          </div>
          <div className="remote-image-actions">
            {hasCachedImages && (
              <Button
                unstyled
                type="button"
                className="button"
                disabled={current.pending || current.restoring}
                onClick={() => setState({ ...current, hidden: !current.hidden })}
              >
                {current.hidden ? '显示图片' : '隐藏图片'}
              </Button>
            )}
            {!current.hidden && loaded < prepared.remoteImageCount && (
              <Button
                unstyled
                type="button"
                className="button"
                disabled={current.pending || current.restoring}
                onClick={() => void loadImages()}
              >
                {current.pending && <Spinner size={12} />}
                {current.pending
                  ? '正在加载'
                  : current.result || current.error
                    ? '重新加载'
                    : '加载图片'}
              </Button>
            )}
          </div>
        </div>
      )}
      <iframe
        ref={frame}
        onLoad={onFrameLoad}
        title="邮件正文（隔离阅读）"
        sandbox="allow-same-origin"
        scrolling="no"
        srcDoc={frameDocument.html}
        referrerPolicy="no-referrer"
        className="mail-html"
        style={{ colorScheme: theme }}
      />
    </>
  )
}
