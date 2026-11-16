import { Button } from './ui/button'
import { ScrollArea } from './ui/scroll-area'
import { useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  CircleAlert,
  Check,
  Clock3,
  FileText,
  Inbox,
  Layers3,
  LockKeyhole,
  MailOpen,
  PencilLine,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Workflow
} from 'lucide-react'
import type { Account, Draft, Operation, SentCopyState } from '../../../shared/model'
import { dateLabel, errorMessage, fullDate, request } from '../lib'
import { ErrorPanel, IconButton, Spinner } from './primitives'
import { ConfirmDialog } from './ConfirmDialog'
import { UtilityPageHeader } from './UtilityPageHeader'
import { BrandMark } from './BrandMark'

export function Welcome({
  onAdd,
  onDemo,
  busy,
  error,
  onRetry
}: {
  onAdd: () => void
  onDemo: () => void
  busy: boolean
  error?: string
  onRetry: () => void
}) {
  return (
    <main className="welcome-view">
      <div className="welcome-top">
        <span>一个收件箱，连接你的每一面。</span>
        <span>
          <ShieldCheck size={14} />
          隐私，从本机开始
        </span>
      </div>
      {error && (
        <div className="welcome-error">
          <ErrorPanel message={error} retry={onRetry} />
        </div>
      )}
      <div className="welcome-content">
        <div className="welcome-art" aria-hidden="true">
          <div className="art-orbit orbit-one" />
          <div className="art-orbit orbit-two" />
          <div className="art-note note-one">
            <span />
            <span />
            <span />
          </div>
          <div className="art-envelope">
            <BrandMark size={88} />
          </div>
          <div className="art-account account-one">@</div>
          <div className="art-account account-two">
            <MailOpen size={17} />
          </div>
          <span className="art-spark spark-one">✦</span>
          <span className="art-spark spark-two">✧</span>
        </div>
        <div className="welcome-eyebrow">
          <span />
          为更轻松的邮件日常
        </div>
        <h1>
          少一点切换，
          <br />
          多一点<span>专注。</span>
        </h1>
        <p>
          工作、生活、每一个你。
          <br />
          把不同邮箱放在一起，让重要的邮件自然浮现。
        </p>
        <div className="welcome-buttons">
          <Button unstyled className="button primary" onClick={onAdd}>
            <Plus size={17} />
            添加第一个邮箱
          </Button>
          <Button unstyled className="button demo-button" onClick={onDemo} disabled={busy}>
            {busy ? <Spinner /> : <Sparkles size={15} />}体验演示
            <ArrowRight size={14} />
          </Button>
        </div>
        <div className="welcome-supported">支持 QQ · 网易 · Gmail · Outlook · IMAP 邮箱</div>
        <div className="welcome-features">
          <div>
            <span>
              <Layers3 size={20} strokeWidth={1.5} />
            </span>
            <strong>所有账号，一处查看</strong>
            <p>统一收件，也能随时分开。</p>
          </div>
          <div>
            <span>
              <LockKeyhole size={20} strokeWidth={1.5} />
            </span>
            <strong>你的邮件，留在本机</strong>
            <p>直接连接邮箱，安心阅读。</p>
          </div>
          <div>
            <span>
              <Inbox size={20} strokeWidth={1.5} />
            </span>
            <strong>熟悉的邮箱，全新日常</strong>
            <p>保留习惯，减少繁杂。</p>
          </div>
        </div>
      </div>
      <div className="welcome-footer">
        <span>BETTER MAIL</span>
        <p>给收件箱减负，也给自己一点留白。</p>
        <span>✦</span>
      </div>
    </main>
  )
}
export function DraftsView({
  drafts,
  accounts,
  loading,
  error,
  onOpen,
  onCompose,
  onChanged,
  notify
}: {
  drafts: Draft[]
  accounts: Account[]
  loading: boolean
  error?: string
  onOpen: (draft: Draft) => void
  onCompose: () => void
  onChanged: () => void
  notify: (message: string) => void
}) {
  const [removingDraft, setRemovingDraft] = useState<Draft | null>(null)
  const removeTrigger = useRef<HTMLButtonElement | null>(null)
  async function remove(id: string) {
    await request('drafts.delete', { draftId: id })
    onChanged()
    notify('草稿已删除')
  }
  return (
    <main className="utility-view utility-scroll-view drafts-view">
      <ScrollArea
        className="utility-scroll-area"
        viewportClassName="utility-main"
        viewportProps={{ 'aria-label': '草稿箱内容', tabIndex: 0 }}
      >
        <UtilityPageHeader
          title="草稿箱"
          count={drafts.length}
          description="还没写完的话，先好好留着。"
          actions={
            <Button unstyled className="button primary" onClick={onCompose}>
              <Plus size={16} />
              写邮件
            </Button>
          }
        />
        {error && <ErrorPanel message={error} />}
        {loading ? (
          <div className="utility-loading">
            <Spinner size={26} />
          </div>
        ) : drafts.length === 0 ? (
          <div className="utility-empty">
            <div className="utility-empty-icon">
              <PencilLine size={38} strokeWidth={1.2} />
            </div>
            <h2>每封好邮件，都从一句问候开始</h2>
            <p>在写信窗口保存的草稿，会安静地等在这里。</p>
            <Button unstyled className="button" onClick={onCompose}>
              <PencilLine size={15} />
              开始写信
            </Button>
          </div>
        ) : (
          <div className="draft-grid">
            {drafts.map((draft) => (
              <div className="draft-card" key={draft.id}>
                <Button unstyled className="draft-card-main" onClick={() => onOpen(draft)}>
                  <span className="draft-account">
                    <i
                      style={{
                        background:
                          accounts.find((account) => account.id === draft.accountId)?.color ||
                          '#82917a'
                      }}
                    />
                    {accounts.find((account) => account.id === draft.accountId)?.name || '邮箱'}
                    <time>{dateLabel(draft.updatedAt)}</time>
                  </span>
                  <h3>{draft.subject || '（无主题草稿）'}</h3>
                  <small>收件人：{draft.to.join(', ') || '尚未填写'}</small>
                  <p>{draft.text || '还没有正文，继续写下你的想法…'}</p>
                  <span className="draft-open">
                    继续编辑
                    <ArrowRight size={13} />
                  </span>
                </Button>
                <div className="draft-card-bottom">
                  <span>
                    <FileText size={12} />
                    本机草稿
                  </span>
                  <IconButton
                    label={`删除草稿 ${draft.subject}`}
                    onClick={(event) => {
                      removeTrigger.current = event.currentTarget
                      setRemovingDraft(draft)
                    }}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              </div>
            ))}
          </div>
        )}
        <ConfirmDialog
          open={removingDraft !== null}
          onOpenChange={(open) => {
            if (!open) setRemovingDraft(null)
          }}
          title="删除这份草稿？"
          description={`“${removingDraft?.subject || '无主题草稿'}”将从本机删除，删除后无法恢复。`}
          returnFocusRef={removeTrigger}
          onConfirm={async () => {
            if (removingDraft) await remove(removingDraft.id)
          }}
        />
      </ScrollArea>
    </main>
  )
}
const operationLabels: Record<Operation['kind'], string> = {
  markRead: '更新已读状态',
  star: '更新星标',
  trash: '移到垃圾箱',
  send: '发送邮件'
}
const stateLabels: Record<Operation['state'], string> = {
  queued: '等待执行',
  running: '正在处理',
  succeeded: '已完成',
  failed: '未完成',
  uncertain: '结果待确认'
}
const copyLabels: Record<SentCopyState, string> = {
  pending: '服务器副本待处理',
  saving: '正在核验或保存服务器副本',
  saved: '服务器副本已保存',
  failed: '服务器副本保存失败',
  uncertain: '副本结果待核验',
  missing: '服务器中未找到已发送副本'
}
export function OperationsView({
  operations,
  accounts,
  loading,
  error,
  stats,
  pagination,
  onChanged,
  notify
}: {
  operations: Operation[]
  accounts: Account[]
  loading: boolean
  error?: string
  stats?: { total: number; pending: number; attention: number }
  pagination?: {
    page: number
    hasPrevious: boolean
    hasNext: boolean
    onPrevious: () => void
    onNext: () => void
    loading?: boolean
  }
  onChanged: () => void
  notify: (message: string) => void
}) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const mainRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (!pagination?.loading && mainRef.current) mainRef.current.scrollTop = 0
  }, [pagination?.page, pagination?.loading])
  async function retry(id: string) {
    setBusyId(id)
    try {
      await request('operations.retry', { operationId: id })
      onChanged()
      notify('已重新加入操作队列')
    } catch (caught) {
      notify(errorMessage(caught))
    } finally {
      setBusyId(null)
    }
  }
  function verifyCopyOnly(operation: Operation) {
    return (
      operation.sentCopy?.state === 'uncertain' ||
      accounts.find((account) => account.id === operation.accountId)?.provider !== 'imap'
    )
  }
  async function retryCopy(operation: Operation) {
    setBusyId(operation.id)
    try {
      await request('sentCopies.retry', { operationId: operation.id })
      onChanged()
      notify(
        verifyCopyOnly(operation)
          ? '已请求核验副本，不会重新发送邮件。'
          : '已请求补存副本，不会重新发送邮件。'
      )
    } catch (caught) {
      notify(errorMessage(caught))
    } finally {
      setBusyId(null)
    }
  }
  const pending =
    stats?.pending ??
    operations.filter(
      (operation) =>
        operation.state === 'queued' ||
        operation.state === 'running' ||
        (operation.state === 'succeeded' &&
          ['pending', 'saving'].includes(operation.sentCopy?.state ?? ''))
    ).length
  const needAttention =
    stats?.attention ??
    operations.filter(
      (operation) =>
        operation.state === 'failed' ||
        operation.state === 'uncertain' ||
        (operation.state === 'succeeded' &&
          ['failed', 'missing', 'uncertain'].includes(operation.sentCopy?.state ?? ''))
    ).length
  return (
    <main
      className="utility-view utility-scroll-view"
      aria-busy={loading || pagination?.loading || undefined}
    >
      <ScrollArea
        className="utility-scroll-area"
        viewportClassName="utility-main"
        viewportRef={mainRef}
        viewportProps={{ 'aria-label': '操作队列内容', tabIndex: 0 }}
      >
        <UtilityPageHeader
          title="操作队列"
          description="每一次发送与更改，都有迹可循。"
          actions={
            <span className="local-badge">
              <ShieldCheck size={14} />
              保存在本机
            </span>
          }
        />
        <div className="operation-stats">
          <div>
            <Clock3 size={19} />
            <span>
              等待 / 处理中<strong>{pending}</strong>
            </span>
          </div>
          <div>
            <CircleAlert size={19} />
            <span>
              需要关注<strong>{needAttention}</strong>
            </span>
          </div>
          <div>
            <Workflow size={19} />
            <span>
              全部操作<strong>{stats?.total ?? operations.length}</strong>
            </span>
          </div>
        </div>
        {error && <ErrorPanel message={error} />}
        {loading ? (
          <div className="utility-loading">
            <Spinner size={25} />
          </div>
        ) : operations.length === 0 ? (
          <div className="utility-empty">
            <div className="utility-empty-icon">
              <Workflow size={38} strokeWidth={1.3} />
            </div>
            <h2>一切就绪，随时出发</h2>
            <p>发送邮件、标记已读或移动邮件后，处理状态会显示在这里。</p>
          </div>
        ) : (
          <div className="operations-table">
            <div className="operations-table-head">
              <span>操作</span>
              <span>账号</span>
              <span>时间</span>
              <span>状态</span>
            </div>
            {operations.map((operation) => (
              <div
                className={`operation-row ${operation.state === 'uncertain' ? 'uncertain' : ''}`}
                key={operation.id}
              >
                <div className="operation-row-summary">
                  <span className="operation-kind">
                    <Workflow size={16} />
                    <strong>{operationLabels[operation.kind]}</strong>
                    <small>
                      {operation.kind === 'send'
                        ? '邮件发送'
                        : `${operation.messageIds.length} 封邮件`}
                    </small>
                  </span>
                  <span className="operation-account">
                    {accounts.find((account) => account.id === operation.accountId)?.email ||
                      '已移除账号'}
                  </span>
                  <time dateTime={new Date(operation.createdAt).toISOString()}>
                    {fullDate(operation.createdAt)}
                  </time>
                  <span className={`operation-state state-${operation.state}`}>
                    {operation.state === 'running' && <Spinner size={11} />}
                    {operation.kind === 'send' && operation.state === 'succeeded'
                      ? '已发送'
                      : stateLabels[operation.state]}
                  </span>
                </div>
                {(operation.error || operation.state === 'uncertain') && (
                  <div className="operation-error">
                    <CircleAlert size={14} />
                    <span>
                      {operation.state === 'uncertain'
                        ? '邮件可能已经发送。请先在邮箱网页版确认，避免重复发送。'
                        : operation.error}
                    </span>
                    {operation.state === 'failed' && (
                      <Button
                        unstyled
                        className="text-button"
                        disabled={busyId === operation.id || pagination?.loading}
                        onClick={() => void retry(operation.id)}
                      >
                        {busyId === operation.id ? <Spinner size={12} /> : <RefreshCw size={12} />}
                        重试
                      </Button>
                    )}
                  </div>
                )}
                {operation.kind === 'send' && operation.sentCopy && (
                  <div
                    className={`operation-error sent-copy-status sent-copy-${operation.sentCopy.state}`}
                  >
                    {operation.sentCopy.state === 'saved' ? (
                      <Check size={14} />
                    ) : ['pending', 'saving'].includes(operation.sentCopy.state) ? (
                      <Clock3 size={14} />
                    ) : (
                      <CircleAlert size={14} />
                    )}
                    <span>
                      {copyLabels[operation.sentCopy.state]}
                      {operation.sentCopy.error ? `：${operation.sentCopy.error}` : ''}
                    </span>
                    {operation.state === 'succeeded' &&
                      ['failed', 'missing', 'uncertain'].includes(operation.sentCopy.state) && (
                        <Button
                          unstyled
                          type="button"
                          className="text-button"
                          disabled={busyId === operation.id || pagination?.loading}
                          onClick={() => void retryCopy(operation)}
                        >
                          {busyId === operation.id ? (
                            <Spinner size={12} />
                          ) : (
                            <RefreshCw size={12} />
                          )}
                          {verifyCopyOnly(operation) ? '核验副本' : '补存副本'}
                        </Button>
                      )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {pagination && !loading && (
          <nav className="operation-pagination" aria-label="操作队列分页">
            <span className="operation-pagination-status" role="status" aria-live="polite">
              {pagination.loading ? (
                <>
                  <Spinner size={12} />
                  正在加载…
                </>
              ) : (
                `第 ${pagination.page} 页`
              )}
            </span>
            <div className="operation-pagination-controls">
              <Button
                variant="outline"
                size="sm"
                disabled={!pagination.hasPrevious || pagination.loading}
                onClick={pagination.onPrevious}
              >
                上一页
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!pagination.hasNext || pagination.loading}
                onClick={pagination.onNext}
              >
                下一页
              </Button>
            </div>
          </nav>
        )}
      </ScrollArea>
    </main>
  )
}
