import { Button } from './ui/button'
import { ScrollArea } from './ui/scroll-area'
import { useLayoutEffect, useRef, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator
} from './ui/dropdown-menu'
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  CircleAlert,
  Clock3,
  Ellipsis,
  Mail,
  MailOpen,
  Paperclip,
  Reply,
  Star,
  Trash2
} from 'lucide-react'
import type {
  Account,
  DraftInput,
  MessageDetail,
  MessageSummary,
  SentCopyState
} from '../../../shared/model'
import type { WindowTheme } from '../../../shared/window'
import { errorMessage, escapeHtml, fileSize, fullDate, initials, request, senderName } from '../lib'
import { MailHtmlBody } from './MailHtmlBody'
import { ErrorPanel, IconButton, Spinner } from './primitives'
import { TooltipHint } from './Tooltip'

export type MessageAction = (
  message: MessageSummary,
  action: 'markRead' | 'star' | 'trash',
  value?: boolean
) => Promise<void>
const copyMessages: Record<SentCopyState, string> = {
  pending: '邮件已提交发送，服务器副本待处理。',
  saving: '正在核验或保存服务器上的已发送副本。',
  saved: '服务器副本已保存。',
  failed: '邮件已提交发送，但服务器副本保存失败。',
  uncertain: '邮件已提交发送，副本保存结果待核验。请勿重复发送。',
  missing: '服务器中未找到已发送副本，本机仍保留这份发送记录。'
}
export function MailReader({
  message: receivedMessage,
  summary,
  account: receivedAccount,
  loading,
  error,
  theme,
  trashFolderIds = [],
  isTrashView = false,
  onAction,
  onCompose,
  notify
}: {
  message?: MessageDetail
  summary?: MessageSummary
  account?: Account
  loading: boolean
  error?: string
  theme: WindowTheme
  trashFolderIds?: string[]
  isTrashView?: boolean
  onAction: MessageAction
  onCompose: (seed: DraftInput) => void
  notify: (message: string) => void
}) {
  const message =
    receivedMessage &&
    (!summary ||
      (receivedMessage.id === summary.id && receivedMessage.accountId === summary.accountId))
      ? receivedMessage
      : undefined
  const displayed = message ?? summary
  const inTrash =
    isTrashView ||
    [displayed, summary].some((item) =>
      item?.folderIds.some((folderId) => trashFolderIds.includes(folderId))
    )
  const account =
    receivedAccount && (!displayed || receivedAccount.id === displayed.accountId)
      ? receivedAccount
      : undefined
  const ready = Boolean(message && !loading && !error)
  const [plainText, setPlainText] = useState(false)
  const [oversizedHtml, setOversizedHtml] = useState<{
    accountId: string
    messageId: string
    html: string
    text: string
  } | null>(null)
  const [downloading, setDownloading] = useState<string | null>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const htmlFallback =
    oversizedHtml?.accountId === message?.accountId &&
    oversizedHtml?.messageId === message?.id &&
    oversizedHtml?.html === message?.body.html
      ? oversizedHtml
      : null
  const showPlainText = plainText || Boolean(htmlFallback)
  const hasHtml = Boolean(message?.body.html)
  useLayoutEffect(() => {
    if (scroll.current) {
      scroll.current.scrollTop = 0
      scroll.current.scrollLeft = 0
    }
  }, [displayed?.accountId, displayed?.id])
  async function download(id: string) {
    if (!message || !ready) return
    setDownloading(id)
    try {
      const saved = await request('attachments.save', {
        accountId: message.accountId,
        messageId: message.id,
        attachmentId: id
      })
      if (saved.saved) notify('附件已保存')
    } catch (caught) {
      notify(errorMessage(caught))
    } finally {
      setDownloading(null)
    }
  }
  function compose(forward = false) {
    if (!message || !ready) return
    const quote = `\n\n────────── ${forward ? '转发邮件' : '原始邮件'} ──────────\n发件人：${message.from.map((item) => item.address).join(', ')}\n时间：${fullDate(message.date)}\n主题：${message.subject}\n\n${message.body.text}`
    onCompose({
      accountId: message.accountId,
      to: forward
        ? []
        : (message.body.replyTo?.length ? message.body.replyTo : message.from).map(
            (item) => item.address
          ),
      cc: [],
      bcc: [],
      subject: /^(re|回复|fwd|fw|转发):/i.test(message.subject)
        ? message.subject
        : `${forward ? 'Fwd' : 'Re'}: ${message.subject}`,
      text: quote,
      html: `<p></p><blockquote>${escapeHtml(quote).replace(/\n/g, '<br>')}</blockquote>`,
      attachmentIds: []
    })
  }
  if (!loading && !error && !displayed)
    return (
      <section className="reader-pane reader-empty" aria-label="邮件阅读面板">
        <div className="reader-empty-art">
          <MailOpen size={44} strokeWidth={1.25} />
          <span />
          <span />
        </div>
        <h2>留一些空间，给重要的事</h2>
        <p>选择一封邮件，开始阅读。</p>
        <div className="reader-empty-shortcut">
          <kbd>{window.mail?.platform === 'darwin' ? '⌘' : 'Ctrl'}</kbd>
          <kbd>N</kbd>
          <span>写一封新邮件</span>
        </div>
      </section>
    )
  return (
    <section className="reader-pane" aria-label="邮件阅读面板" aria-busy={loading || undefined}>
      <div className="reader-toolbar">
        <div className="toolbar-actions">
          <IconButton label="回复" disabled={!ready} onClick={() => compose()}>
            <Reply size={18} />
          </IconButton>
          <IconButton label="转发" disabled={!ready} onClick={() => compose(true)}>
            <ArrowRight size={18} />
          </IconButton>
          <span className="toolbar-separator" />
          <IconButton
            label={displayed?.isStarred ? '取消星标' : '添加星标'}
            className={displayed?.isStarred ? 'starred' : ''}
            aria-pressed={displayed?.isStarred}
            disabled={!ready || displayed?.localOnly}
            onClick={() => {
              if (ready && displayed) void onAction(displayed, 'star', !displayed.isStarred)
            }}
          >
            <Star size={17} fill={displayed?.isStarred ? 'currentColor' : 'none'} />
          </IconButton>
          <IconButton
            label={displayed?.isRead ? '标记为未读' : '标记为已读'}
            disabled={!ready || displayed?.localOnly}
            onClick={() => {
              if (ready && displayed) void onAction(displayed, 'markRead', !displayed.isRead)
            }}
          >
            {displayed?.isRead ? <Mail size={18} /> : <MailOpen size={18} />}
          </IconButton>
          {!inTrash && (
            <IconButton
              label="移到垃圾箱"
              disabled={!ready || displayed?.localOnly}
              onClick={() => {
                if (ready && displayed) void onAction(displayed, 'trash')
              }}
            >
              <Trash2 size={17} />
            </IconButton>
          )}
        </div>
        <div className="reader-toolbar-right">
          <span className="reader-account">
            <span style={{ background: account?.color || '#8b9883' }} />
            {account?.name || '邮箱'}
            {account?.provider === 'demo' && <i>演示</i>}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label="更多邮件操作" disabled={!ready}>
                <Ellipsis size={20} />
              </IconButton>
            </DropdownMenuTrigger>

            <DropdownMenuContent unstyled className="menu-content" align="end" sideOffset={8}>
              <DropdownMenuItem
                unstyled
                className="menu-item"
                onSelect={() => {
                  if (htmlFallback) setOversizedHtml(null)
                  setPlainText(!showPlainText)
                }}
                disabled={!ready}
              >
                {showPlainText && <Check size={14} />}
                <span>{showPlainText ? '查看 HTML 正文' : '查看纯文本正文'}</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                unstyled
                className="menu-item"
                onSelect={() => {
                  if (ready && displayed) void onAction(displayed, 'markRead', !displayed.isRead)
                }}
                disabled={!ready || displayed?.localOnly}
              >
                <Mail size={14} />
                标记为{displayed?.isRead ? '未读' : '已读'}
              </DropdownMenuItem>
              {!inTrash && (
                <>
                  <DropdownMenuSeparator unstyled className="menu-separator" />
                  <DropdownMenuItem
                    unstyled
                    className="menu-item danger-text"
                    onSelect={() => {
                      if (ready && displayed) void onAction(displayed, 'trash')
                    }}
                    disabled={!ready || displayed?.localOnly}
                  >
                    <Trash2 size={14} />
                    移到垃圾箱
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <ScrollArea
        className="reader-scroll-area"
        viewportClassName="reader-scroll"
        viewportRef={scroll}
        viewportProps={{ 'aria-label': '邮件阅读滚动区域', tabIndex: 0 }}
        horizontal
      >
        <article className="mail-article">
          {displayed ? (
            <>
              <h1>{displayed.subject || '（无主题）'}</h1>
              <div className="sender-row">
                <div
                  className="sender-avatar"
                  style={{
                    background: `${account?.color || '#7c8b76'}17`,
                    color: account?.color || '#7c8b76'
                  }}
                >
                  {initials(senderName(displayed))}
                </div>
                <div className="sender-info">
                  <div>
                    <strong>{senderName(displayed)}</strong>
                    <span>&lt;{displayed.from[0]?.address}&gt;</span>
                  </div>
                  <div className="recipient-line">
                    <span>发送至</span>
                    <TooltipHint
                      content={
                        displayed.to.map((item) => item.address).join(', ') || account?.email
                      }
                    >
                      <span tabIndex={0}>
                        {displayed.to.map((item) => item.name || item.address).join(', ') ||
                          account?.email}
                      </span>
                    </TooltipHint>
                    {message?.body.cc?.length ? (
                      <small> · 抄送 {message.body.cc.length} 人</small>
                    ) : null}
                  </div>
                </div>
                <time dateTime={new Date(displayed.date).toISOString()}>
                  {fullDate(displayed.date)}
                </time>
              </div>
            </>
          ) : (
            <div className="reader-metadata-placeholder" aria-hidden="true">
              <div className="reader-subject-placeholder reader-placeholder" />
              <div className="sender-row">
                <div className="sender-avatar reader-placeholder" />
                <div className="reader-sender-placeholder">
                  <span className="reader-placeholder" />
                  <span className="reader-placeholder" />
                </div>
              </div>
            </div>
          )}
          {ready &&
            message &&
            (message.localOnly || (message.sentCopy && message.sentCopy.state !== 'saved')) && (
              <div
                role="status"
                className={`sent-copy-reader sent-copy-${message.sentCopy?.state ?? 'pending'}`}
              >
                {message.sentCopy && ['pending', 'saving'].includes(message.sentCopy.state) ? (
                  <Clock3 size={15} />
                ) : (
                  <CircleAlert size={15} />
                )}
                <div>
                  <p>
                    {message.sentCopy
                      ? copyMessages[message.sentCopy.state]
                      : '这是本机发送记录，尚未关联服务器副本。'}
                  </p>
                  {message.sentCopy?.error && <small>{message.sentCopy.error}</small>}
                  {message.sentCopy &&
                    ['failed', 'missing', 'uncertain'].includes(message.sentCopy.state) && (
                      <small>可在操作队列中补存或核验副本，不会重新投递邮件。</small>
                    )}
                </div>
              </div>
            )}
          <div
            className={`mail-content ${ready && hasHtml && !showPlainText ? 'html-document' : 'text-document'}`}
          >
            {error ? (
              <div className="reader-loading-content">
                <ErrorPanel message={error} />
              </div>
            ) : !ready ? (
              <div className="reader-loading-content">
                <div
                  key={`${displayed?.accountId || ''}:${displayed?.id || ''}`}
                  className="reader-loading-status"
                  role="status"
                >
                  <Spinner size={14} />
                  <span>{displayed ? '正在载入正文…' : '正在载入邮件…'}</span>
                </div>
              </div>
            ) : message?.body.html && !showPlainText ? (
              <MailHtmlBody
                key={`${message.accountId}:${message.id}`}
                accountId={message.accountId}
                messageId={message.id}
                html={message.body.html}
                theme={theme}
                onHeightLimit={(text) => {
                  setOversizedHtml({
                    accountId: message.accountId,
                    messageId: message.id,
                    html: message.body.html!,
                    text
                  })
                  notify('邮件正文过长，已切换为纯文本阅读。')
                }}
              />
            ) : (
              <div className="mail-plain">
                {htmlFallback?.text || message?.body.text || '这封邮件没有文本正文。'}
              </div>
            )}
          </div>
          {ready && message && message.body.attachments.length > 0 && (
            <div className="reader-attachments">
              <div className="attachment-heading">
                <Paperclip size={14} />
                <span>{message.body.attachments.length} 个附件</span>
              </div>
              <div className="attachment-grid">
                {message.body.attachments.map((attachment) => (
                  <Button
                    unstyled
                    className="attachment-card"
                    key={attachment.id}
                    disabled={downloading !== null}
                    onClick={() => void download(attachment.id)}
                  >
                    <span className="file-icon">
                      {attachment.filename.split('.').pop()?.slice(0, 4).toUpperCase() || 'FILE'}
                    </span>
                    <span>
                      <strong>{attachment.filename}</strong>
                      <small>{fileSize(attachment.size)} · 点击保存</small>
                    </span>
                    {downloading === attachment.id ? <Spinner /> : <ArrowDownToLine size={16} />}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <div className="reader-reply-actions">
            <Button
              unstyled
              className="button reply-button"
              disabled={!ready}
              onClick={() => compose()}
            >
              <Reply size={16} />
              回复
            </Button>
            <Button unstyled className="button" disabled={!ready} onClick={() => compose(true)}>
              <ArrowRight size={16} />
              转发
            </Button>
          </div>
        </article>
      </ScrollArea>
    </section>
  )
}
