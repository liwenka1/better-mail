import { useEffect, useMemo, useRef, useState } from 'react'
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
  pending: boolean
  result?: RemoteImagesResult
  error?: string
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
  const [state, setState] = useState<ImageState>({ scope, html, pending: false })
  const inFlight = useRef<{ scope: string; html: string } | null>(null)
  const current: ImageState =
    state.scope === scope && state.html === html ? state : { scope, html, pending: false }
  const images = useMemo(
    () => new Map(current.result?.images.map((image) => [image.source, image.dataUrl])),
    [current.result]
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
  useEffect(() => {
    inFlight.current = null
    setState((previous) =>
      previous.scope === scope && previous.html === html
        ? previous
        : { scope, html, pending: false }
    )
  }, [scope, html])
  useEffect(
    () => () => {
      inFlight.current = null
    },
    []
  )
  async function loadImages() {
    if (inFlight.current?.scope === scope && inFlight.current.html === html) return
    const ticket = { scope, html }
    inFlight.current = ticket
    setState({ ...current, pending: true, error: undefined })
    try {
      const result = await request('messages.loadImages', { accountId, messageId })
      if (inFlight.current === ticket) setState({ scope, html, pending: false, result })
    } catch (caught) {
      if (inFlight.current === ticket)
        setState({ ...current, pending: false, error: errorMessage(caught) })
    } finally {
      if (inFlight.current === ticket) inFlight.current = null
    }
  }
  return (
    <>
      {prepared.remoteImageCount > 0 && (
        <div className="remote-image-notice" aria-busy={current.pending || undefined}>
          <ImageOff size={15} aria-hidden="true" />
          <div className="remote-image-copy">
            <p role="status" aria-live="polite">
              {current.pending
                ? '正在加载远程图片…'
                : current.error
                  ? '远程图片加载失败'
                  : current.result
                    ? loaded === prepared.remoteImageCount
                      ? '已加载本封邮件的远程图片'
                      : `已加载 ${loaded} / ${prepared.remoteImageCount} 张图片，其余图片暂时无法加载。`
                    : `已阻止 ${prepared.remoteImageCount} 张远程图片自动加载`}
            </p>
            <small>加载会连接图片服务器，可能让发件人知道你已阅读。</small>
            {current.error && <small role="alert">{current.error}</small>}
          </div>
          <div className="remote-image-actions">
            {loaded > 0 && (
              <Button
                unstyled
                type="button"
                className="button"
                disabled={current.pending}
                onClick={() => setState({ scope, html, pending: false })}
              >
                隐藏图片
              </Button>
            )}
            {loaded < prepared.remoteImageCount && (
              <Button
                unstyled
                type="button"
                className="button"
                disabled={current.pending}
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
