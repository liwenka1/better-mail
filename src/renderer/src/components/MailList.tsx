import { useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator
} from './ui/context-menu'
import { Inbox, Mail, MailOpen, Paperclip, RefreshCw, Star, Trash2 } from 'lucide-react'
import type { Account, MessageSummary } from '../../../shared/model'
import { dateLabel, initials, senderName } from '../lib'
import { useUi, type View } from '../store'
import { ErrorPanel, IconButton, Spinner } from './primitives'
import type { MessageAction } from './MailReader'
import { Button } from './ui/button'
import { ScrollArea } from './ui/scroll-area'
import { TooltipHint } from './Tooltip'

const viewNames: Record<View, string> = {
  inbox: '收件箱',
  starred: '星标邮件',
  all: '所有邮件',
  sent: '已发送',
  trash: '垃圾箱',
  drafts: '草稿箱',
  operations: '操作队列',
  settings: '设置'
}
export function MailList({
  accounts,
  messages,
  loading,
  error,
  loadingMore,
  hasMore,
  loadMore,
  onSync,
  syncing,
  onAction,
  folderName,
  unreadCount,
  trashFolderIds = []
}: {
  accounts: Account[]
  messages: MessageSummary[]
  loading: boolean
  error?: string
  loadingMore: boolean
  hasMore: boolean
  loadMore: () => void
  onSync: () => void
  syncing: boolean
  onAction: MessageAction
  folderName?: string
  unreadCount?: number
  trashFolderIds?: string[]
}) {
  const {
    view,
    accountId,
    folderId,
    selected,
    select,
    search,
    setSearch,
    readFilter,
    setReadFilter
  } = useUi()
  const parentRef = useRef<HTMLDivElement>(null)
  const listReady = !loading && !error && messages.length > 0
  const virtualizer = useVirtualizer({
    enabled: listReady,
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 96,
    overscan: 6,
    getItemKey: (index) => messages[index]!.id
  })
  const items = virtualizer.getVirtualItems()
  const lastIndex = items.at(-1)?.index
  useEffect(() => {
    if (lastIndex !== undefined && lastIndex >= messages.length - 4 && hasMore && !loadingMore)
      loadMore()
  }, [lastIndex, messages.length, hasMore, loadingMore, loadMore])
  useLayoutEffect(() => {
    if (listReady && parentRef.current) virtualizer.scrollToOffset(0, { behavior: 'auto' })
  }, [view, accountId, folderId, search, readFilter, listReady, virtualizer])
  const title = folderName || (view === 'inbox' && !accountId ? '全部收件箱' : viewNames[view])
  return (
    <section className="list-pane" aria-label="邮件列表">
      <div className="list-top">
        <div className="list-heading">
          <div>
            <h2>{title}</h2>
            {unreadCount !== undefined && (
              <span className="list-heading-meta">{unreadCount} 封未读</span>
            )}
          </div>
          <IconButton label="同步邮件" onClick={onSync} disabled={syncing}>
            <RefreshCw size={16} className={syncing ? 'spin' : ''} />
          </IconButton>
        </div>
      </div>
      <div className="list-filter-row">
        <div className="mail-filter-tabs" role="group" aria-label="邮件筛选">
          {(
            [
              { value: 'all', label: '全部' },
              { value: 'unread', label: '未读' }
            ] as const
          ).map((filter) => (
            <Button
              unstyled
              type="button"
              key={filter.value}
              aria-pressed={readFilter === filter.value}
              onClick={() => setReadFilter(filter.value)}
            >
              {filter.label}
            </Button>
          ))}
        </div>
        {search && <span className="list-sort-label">搜索结果</span>}
      </div>
      {error ? (
        <div className="list-state">
          <ErrorPanel message={error} retry={onSync} />
        </div>
      ) : loading ? (
        <div className="mail-skeletons">
          {Array.from({ length: 6 }, (_, index) => (
            <div className="mail-skeleton" key={index}>
              <span />
              <span />
              <span />
            </div>
          ))}
        </div>
      ) : messages.length === 0 ? (
        <div className="list-empty">
          <Inbox size={32} strokeWidth={1.3} />
          <strong>
            {search ? '没有找到相关邮件' : readFilter === 'unread' ? '没有未读邮件' : '暂无邮件'}
          </strong>
          <p>
            {search
              ? '换一个关键词，再试试看。'
              : readFilter === 'unread'
                ? '当前视图的邮件都已读完。'
                : '同步完成后，邮件会出现在这里。'}
          </p>
          {search && (
            <Button unstyled className="text-button" onClick={() => setSearch('')}>
              清除搜索
            </Button>
          )}
        </div>
      ) : (
        <ScrollArea
          className="message-list-scroll-area"
          viewportClassName="message-list-scroll"
          viewportRef={parentRef}
          viewportProps={{ 'aria-label': '邮件列表滚动区域', tabIndex: 0 }}
        >
          <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
            {items.map((item) => {
              const message = messages[item.index]!
              const account = accounts.find((entry) => entry.id === message.accountId)
              const active = selected?.id === message.id && selected.accountId === message.accountId
              const inTrash =
                view === 'trash' || message.folderIds.some((id) => trashFolderIds.includes(id))
              return (
                <ContextMenu key={message.id}>
                  <ContextMenuTrigger asChild>
                    <div
                      className={`message-row ${active ? 'selected' : ''} ${message.isRead ? '' : 'unread'}`}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: item.size,
                        transform: `translateY(${item.start}px)`
                      }}
                    >
                      <Button
                        unstyled
                        className="message-open"
                        onClick={() => select({ id: message.id, accountId: message.accountId })}
                        aria-label={`阅读 ${message.subject || '无主题'}，来自 ${senderName(message)}`}
                        aria-pressed={active}
                      >
                        <span
                          className="message-sender-avatar"
                          style={{ '--sender-color': account?.color || '#8b93ab' } as CSSProperties}
                        >
                          {initials(senderName(message))}
                          <i className={`unread-dot ${message.isRead ? 'read' : ''}`} />
                        </span>
                        <span className="message-row-main">
                          <span className="message-row-top">
                            <strong>{senderName(message)}</strong>
                            <time dateTime={new Date(message.date).toISOString()}>
                              {dateLabel(message.date)}
                            </time>
                          </span>
                          <span className="message-row-subject">
                            {message.subject || '（无主题）'}
                          </span>
                          <span className="message-snippet">
                            {message.snippet || '打开查看邮件内容'}
                          </span>
                          <span className="message-row-bottom">
                            <span className="message-account">
                              <i style={{ background: account?.color || '#8b93ab' }} />
                              {account?.name || '邮箱'}
                              {message.localOnly && (
                                <TooltipHint content="尚未关联服务器副本">
                                  <small>本地</small>
                                </TooltipHint>
                              )}
                            </span>
                            {message.hasAttachments && (
                              <Paperclip
                                className="attachment-indicator"
                                size={12}
                                aria-label="含附件"
                              />
                            )}
                          </span>
                        </span>
                      </Button>
                      <TooltipHint
                        content={
                          message.localOnly
                            ? '服务器副本尚未确认，暂不能修改星标'
                            : message.isStarred
                              ? '取消星标'
                              : '添加星标'
                        }
                        disabledWrapperStyle={{
                          position: 'absolute',
                          right: 15,
                          bottom: 7,
                          width: 22,
                          height: 22,
                          zIndex: 2
                        }}
                      >
                        <Button
                          unstyled
                          aria-label={message.isStarred ? '取消星标' : '添加星标'}
                          className={`row-star ${message.isStarred ? 'starred' : ''}`}
                          disabled={message.localOnly}
                          style={{ position: 'static' }}
                          onClick={() => void onAction(message, 'star', !message.isStarred)}
                        >
                          <Star size={13} fill={message.isStarred ? 'currentColor' : 'none'} />
                        </Button>
                      </TooltipHint>
                    </div>
                  </ContextMenuTrigger>

                  <ContextMenuContent unstyled className="menu-content">
                    <ContextMenuItem
                      unstyled
                      className="menu-item"
                      onSelect={() => void onAction(message, 'markRead', !message.isRead)}
                      disabled={message.localOnly}
                    >
                      {message.isRead ? <Mail size={14} /> : <MailOpen size={14} />}标记为
                      {message.isRead ? '未读' : '已读'}
                    </ContextMenuItem>
                    <ContextMenuItem
                      unstyled
                      className="menu-item"
                      onSelect={() => void onAction(message, 'star', !message.isStarred)}
                      disabled={message.localOnly}
                    >
                      <Star size={14} />
                      {message.isStarred ? '取消星标' : '添加星标'}
                    </ContextMenuItem>
                    {!inTrash && (
                      <>
                        <ContextMenuSeparator unstyled className="menu-separator" />
                        <ContextMenuItem
                          unstyled
                          className="menu-item danger-text"
                          onSelect={() => void onAction(message, 'trash')}
                          disabled={message.localOnly}
                        >
                          <Trash2 size={14} />
                          移到垃圾箱
                        </ContextMenuItem>
                      </>
                    )}
                  </ContextMenuContent>
                </ContextMenu>
              )
            })}
          </div>
          {hasMore && (
            <Button unstyled className="load-more" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? (
                <>
                  <Spinner />
                  正在加载更多…
                </>
              ) : (
                '加载更多邮件'
              )}
            </Button>
          )}
        </ScrollArea>
      )}
    </section>
  )
}
