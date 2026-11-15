import { Button } from './ui/button'
import { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileText,
  Folder,
  Inbox,
  Layers3,
  Plus,
  RefreshCw,
  Send,
  Settings,
  Star,
  SquarePen,
  Trash2,
  Workflow
} from 'lucide-react'
import type { AppSnapshot, MailFolder } from '../../../shared/model'
import { useUi, type View } from '../store'
import { fullDate } from '../lib'
import { IconButton } from './primitives'
import { TooltipHint } from './Tooltip'

const navigation: { view: View; label: string; icon: typeof Inbox }[] = [
  { view: 'inbox', label: '收件箱', icon: Inbox },
  { view: 'starred', label: '星标邮件', icon: Star },
  { view: 'drafts', label: '草稿箱', icon: FileText },
  { view: 'sent', label: '已发送', icon: Send },
  { view: 'all', label: '所有邮件', icon: Layers3 },
  { view: 'trash', label: '垃圾箱', icon: Trash2 }
]
function folderView(folder: MailFolder): View {
  return folder.role === 'sent'
    ? 'sent'
    : folder.role === 'trash'
      ? 'trash'
      : folder.role === 'inbox'
        ? 'inbox'
        : 'all'
}

export function Sidebar({
  snapshot,
  onAdd,
  onSettings,
  draftCount,
  onCompose,
  platform
}: {
  snapshot: AppSnapshot
  onAdd: () => void
  onSettings: () => void
  draftCount: number
  onCompose: () => void
  platform: string
}) {
  const { view, accountId, folderId, navigate, switchAccount, navigationBlocked } = useUi()
  const [expanded, setExpanded] = useState<string[]>([])
  const visibleAccounts = snapshot.accounts.filter((account) => !account.hidden)
  const visibleAccountIds = new Set(visibleAccounts.map((account) => account.id))
  const unread = snapshot.folders
    .filter(
      (folder) =>
        visibleAccountIds.has(folder.accountId) &&
        folder.role === 'inbox' &&
        (!accountId || folder.accountId === accountId)
    )
    .reduce((total, folder) => total + folder.unreadCount, 0)
  const errors = visibleAccounts.filter(
    (account) => account.status === 'error' || account.status === 'reauth'
  )
  const statusAccounts = snapshot.accounts.filter(
    (account) => !accountId || account.id === accountId
  )
  const statusErrors = statusAccounts.filter(
    (account) => account.status === 'error' || account.status === 'reauth'
  )
  const syncingCount = statusAccounts.filter((account) => account.status === 'syncing').length
  const completedCount = statusAccounts.filter((account) => account.lastSyncAt !== null).length
  const statusTone = statusErrors.length
    ? 'error'
    : syncingCount
      ? 'syncing'
      : !statusAccounts.length || completedCount < statusAccounts.length
        ? 'pending'
        : 'ready'
  const statusLabel = !snapshot.accounts.length
    ? '尚未添加邮箱'
    : !statusAccounts.length
      ? '等待同步'
      : statusErrors.length
        ? statusAccounts.length > 1
          ? `${statusErrors.length} 个账号同步异常`
          : statusErrors[0]!.status === 'reauth'
            ? '需要重新授权'
            : '同步异常'
        : syncingCount
          ? '正在同步邮件'
          : completedCount === 0
            ? '等待首次同步'
            : completedCount < statusAccounts.length
              ? '部分账号等待同步'
              : '最近同步完成'
  const statusDetail = statusAccounts
    .map(
      (account) =>
        `${account.name}：${
          account.error ||
          (account.status === 'reauth'
            ? '需要重新授权'
            : account.status === 'error'
              ? '同步异常'
              : account.status === 'syncing'
                ? '正在同步'
                : account.lastSyncAt === null
                  ? '尚未完成首次同步'
                  : `最近成功同步 ${fullDate(account.lastSyncAt)}`)
        }`
    )
    .join('\n')
  return (
    <aside className="sidebar" aria-label="邮箱与文件夹">
      <div className="sidebar-primary-actions">
        <TooltipHint
          content={`写邮件 (${platform === 'darwin' ? '⌘' : 'Ctrl'} N)`}
          side="right"
          disabledWrapperStyle={{ display: 'flex', width: '100%' }}
        >
          <Button
            unstyled
            type="button"
            className="sidebar-compose compose-main"
            onClick={onCompose}
            disabled={navigationBlocked}
          >
            <SquarePen size={16} aria-hidden="true" />
            <span>写邮件</span>
            <kbd aria-hidden="true">{platform === 'darwin' ? '⌘ N' : 'Ctrl N'}</kbd>
          </Button>
        </TooltipHint>
      </div>
      <div className="sidebar-scroll">
        <div className="sidebar-section-label">邮件</div>
        <nav className="folder-navigation" aria-label="邮件视图">
          {navigation.map((item) => {
            const active = view === item.view && !folderId
            const count = item.view === 'inbox' ? unread : item.view === 'drafts' ? draftCount : 0
            return (
              <Button
                unstyled
                type="button"
                key={item.view}
                className={`nav-item ${active ? 'active' : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => navigate(item.view, accountId)}
                disabled={navigationBlocked}
              >
                <item.icon size={17} strokeWidth={1.7} />
                <span>{item.label}</span>
                {count > 0 && <small>{count > 999 ? '999+' : count}</small>}
              </Button>
            )
          })}
        </nav>
        <div className="accounts-heading">
          <span>
            邮箱账号 <small>{visibleAccounts.length}</small>
          </span>
          <IconButton label="添加邮箱" onClick={onAdd} disabled={navigationBlocked}>
            <Plus size={15} />
          </IconButton>
        </div>
        <Button
          unstyled
          type="button"
          className={`all-accounts ${!accountId ? 'selected' : ''}`}
          aria-pressed={!accountId}
          onClick={() => switchAccount(undefined, snapshot.folders)}
          disabled={navigationBlocked}
        >
          <span className="all-accounts-icon">
            <Layers3 size={15} />
          </span>
          <span>全部账号</span>
          {!accountId && <span className="selected-indicator" />}
        </Button>
        <div className="account-navigation">
          {visibleAccounts.map((account) => {
            const isExpanded = expanded.includes(account.id)
            const active = accountId === account.id
            return (
              <div className="account-group" key={account.id}>
                <div className={`account-nav-row ${active ? 'selected' : ''}`}>
                  <Button
                    unstyled
                    type="button"
                    className="expand-account"
                    aria-label={`${isExpanded ? '收起' : '展开'} ${account.name} 文件夹`}
                    aria-expanded={isExpanded}
                    aria-controls={isExpanded ? `account-folders-${account.id}` : undefined}
                    onClick={() =>
                      setExpanded((items) =>
                        items.includes(account.id)
                          ? items.filter((id) => id !== account.id)
                          : [...items, account.id]
                      )
                    }
                  >
                    {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </Button>
                  <Button
                    unstyled
                    type="button"
                    className="account-select"
                    data-account-email={account.email}
                    aria-pressed={active}
                    onClick={() => switchAccount(account.id, snapshot.folders)}
                    disabled={navigationBlocked}
                  >
                    <span className="account-select-copy">
                      <strong>
                        <span className="account-color-dot" style={{ background: account.color }} />
                        <span className="account-name">{account.name}</span>
                      </strong>
                      <small>{account.email}</small>
                    </span>
                    {account.provider === 'demo' && <i className="demo-label">演示</i>}
                    {account.status === 'syncing' && (
                      <RefreshCw className="spin" size={12} aria-label="正在同步" />
                    )}
                    {(account.status === 'error' || account.status === 'reauth') && (
                      <CircleAlert size={13} className="danger-text" aria-label="账号需要处理" />
                    )}
                  </Button>
                </div>
                {isExpanded && (
                  <div className="account-folders" id={`account-folders-${account.id}`}>
                    {snapshot.folders
                      .filter((folder) => folder.accountId === account.id)
                      .map((folder) => (
                        <Button
                          unstyled
                          type="button"
                          key={folder.id}
                          className={folderId === folder.id ? 'active' : ''}
                          aria-current={folderId === folder.id ? 'page' : undefined}
                          onClick={() => navigate(folderView(folder), account.id, folder.id)}
                          disabled={navigationBlocked}
                        >
                          <Folder size={12} />
                          <span>{folder.name}</span>
                          {folder.unreadCount > 0 && (
                            <small>{folder.unreadCount > 999 ? '999+' : folder.unreadCount}</small>
                          )}
                        </Button>
                      ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        {snapshot.accounts.length === 0 && (
          <Button
            unstyled
            type="button"
            className="empty-account-button"
            onClick={onAdd}
            disabled={navigationBlocked}
          >
            <Plus size={15} />
            <span>添加你的第一个邮箱</span>
          </Button>
        )}
        {errors.length > 0 && (
          <Button
            unstyled
            type="button"
            className="sidebar-error"
            onClick={onSettings}
            disabled={navigationBlocked}
          >
            <CircleAlert size={14} />
            <span>
              {errors.length} 个账号需要处理
              <small>{errors[0]?.error || '请重新授权或检查连接'}</small>
            </span>
            <ChevronRight size={13} />
          </Button>
        )}
      </div>
      <div className="sidebar-footer">
        <TooltipHint content={statusDetail || '添加邮箱后自动同步'} side="right">
          <div
            className="sidebar-status"
            role="status"
            aria-label="同步状态"
            aria-live="polite"
            aria-atomic="true"
            tabIndex={0}
          >
            <span className={`status-dot ${statusTone}`} aria-hidden="true" />
            <span className="sidebar-status-label">{statusLabel}</span>
            {statusErrors.length > 0 && syncingCount > 0 && (
              <small>另有 {syncingCount} 个同步中</small>
            )}
          </div>
        </TooltipHint>
        <div className="sidebar-tools">
          <Button
            unstyled
            type="button"
            className={`sidebar-tool sidebar-queue ${view === 'operations' ? 'active' : ''}`}
            aria-current={view === 'operations' ? 'page' : undefined}
            onClick={() => navigate('operations')}
            disabled={navigationBlocked}
          >
            <Workflow size={16} strokeWidth={1.7} aria-hidden="true" />
            <span>操作队列</span>
            {snapshot.pendingOperations > 0 && (
              <small>{snapshot.pendingOperations > 99 ? '99+' : snapshot.pendingOperations}</small>
            )}
          </Button>
          <Button
            unstyled
            type="button"
            className={`sidebar-tool sidebar-settings ${view === 'settings' ? 'active' : ''}`}
            onClick={onSettings}
            aria-label="设置"
            aria-current={view === 'settings' ? 'page' : undefined}
            disabled={navigationBlocked}
          >
            <Settings size={16} strokeWidth={1.7} aria-hidden="true" />
            <span>设置</span>
          </Button>
        </div>
      </div>
    </aside>
  )
}
