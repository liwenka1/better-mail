import { Button } from './components/ui/button'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { EyeOff, Info, X } from 'lucide-react'
import type { AppSnapshot, DraftInput, MessageDetail } from '../../shared/model'
import { errorMessage, request } from './lib'
import { useUi } from './store'
import { MailList } from './components/MailList'
import { MailReader, type MessageAction } from './components/MailReader'
import { Sidebar } from './components/Sidebar'
import { DraftsView, OperationsView, Welcome } from './components/UtilityViews'
import { IconButton, Modal, Spinner } from './components/primitives'
import { TitleBar } from './components/TitleBar'
import { SettingsPage } from './components/SettingsPage'
import type { AccountUpdateHandler } from './components/AccountPanel'
import { useWindowChrome } from './useWindowChrome'
import { runCloseGuards } from './close-guards'

const emptySnapshot: AppSnapshot = { accounts: [], folders: [], pendingOperations: 0 }
const ComposeDialog = lazy(() =>
  import('./components/ComposeDialog').then((module) => ({ default: module.ComposeDialog }))
)
export function App() {
  const queryClient = useQueryClient()
  const {
    accountId,
    folderId,
    view,
    search,
    readFilter,
    selected,
    readRequested,
    select,
    preview,
    navigate,
    switchAccount,
    navigationBlocked,
    setNavigationBlocked
  } = useUi()
  const [debouncedSearch, setDebouncedSearch] = useState(search)
  const [accountTab, setAccountTab] = useState<'add' | 'manage'>('add')
  const [settingsPage, setSettingsPage] = useState<'general' | 'accounts' | 'help'>('general')
  const [composeOpen, setComposeOpen] = useState(false)
  const [composeSeed, setComposeSeed] = useState<DraftInput | null>(null)
  const [accountEntryKey, setAccountEntryKey] = useState(0)
  const [demoBusy, setDemoBusy] = useState(false)
  const [syncTargets, setSyncTargets] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const [operationNavigation, setOperationNavigation] = useState<{
    accountId?: string
    cursors: (string | undefined)[]
    index: number
  }>({ cursors: [undefined], index: 0 })
  const autoRead = useRef<string | null>(null)
  const pendingActions = useRef(new Set<string>())
  const closingRequests = useRef(new Set<string>())
  const summaryRefreshes = useRef(new Map<string, { dirty: boolean }>())
  const notify = useCallback((message: string) => setNotice(message), [])
  const { chrome, setTheme, setAccentColor, updating: themeBusy } = useWindowChrome(notify)
  const invalidateMessages = useCallback(
    (affectedAccountId?: string) => {
      return queryClient.invalidateQueries({
        predicate: (query) => {
          if (query.queryKey[0] !== 'messages') return false
          if (!affectedAccountId) return true
          const scope = query.queryKey[1] as { accountId?: string; folderId?: string } | undefined
          if (scope?.accountId) return scope.accountId === affectedAccountId
          if (scope?.folderId) {
            const cached = queryClient.getQueryData<AppSnapshot>(['snapshot'])
            const folder = cached?.folders.find((item) => item.id === scope.folderId)
            if (folder) return folder.accountId === affectedAccountId
          }
          return true
        }
      })
    },
    [queryClient]
  )
  const draftsChanged = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['drafts'] })
  }, [queryClient])
  const operationsChanged = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['operations'] })
    void queryClient.invalidateQueries({ queryKey: ['snapshot'] })
  }, [queryClient])
  const accountsChanged = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['snapshot'] })
    void invalidateMessages()
    draftsChanged()
    operationsChanged()
  }, [queryClient, invalidateMessages, draftsChanged, operationsChanged])
  const accountUpdated = useCallback<AccountUpdateHandler>(
    async (updated, change) => {
      // An earlier snapshot cannot roll a confirmed preference back. The
      // returned account supplies only the metadata changed by this action.
      await queryClient.cancelQueries({ queryKey: ['snapshot'] })
      queryClient.setQueryData<AppSnapshot>(['snapshot'], (cached) => {
        if (!cached || !cached.accounts.some((account) => account.id === updated.id)) return cached
        return {
          ...cached,
          accounts: cached.accounts.map((account) =>
            account.id !== updated.id
              ? account
              : {
                  ...account,
                  ...(change === 'visibility'
                    ? { hidden: Boolean(updated.hidden) }
                    : { name: updated.name, color: updated.color })
                }
          )
        }
      })
      if (change === 'visibility') void invalidateMessages(updated.id)
      void queryClient.invalidateQueries({ queryKey: ['snapshot'] })
    },
    [queryClient, invalidateMessages]
  )
  const compositionChanged = useCallback(
    (affectedAccountId: string, change: 'draft' | 'send') => {
      draftsChanged()
      if (change === 'send') {
        void invalidateMessages(affectedAccountId)
        operationsChanged()
      }
    },
    [draftsChanged, invalidateMessages, operationsChanged]
  )
  const snapshotQuery = useQuery({
    queryKey: ['snapshot'],
    queryFn: () => request('app.snapshot', {}),
    refetchInterval: 20_000
  })
  const snapshot = snapshotQuery.data || emptySnapshot
  const { accounts, folders } = snapshot
  const visibleAccounts = useMemo(() => accounts.filter((account) => !account.hidden), [accounts])
  const hiddenAccountIds = useMemo(() => {
    const hidden = accounts
      .filter((account) => account.hidden)
      .map((account) => account.id)
      .sort()
    return hidden.length ? hidden : undefined
  }, [accounts])
  const knownAccountIds = useMemo(
    () => new Set(visibleAccounts.map((account) => account.id)),
    [visibleAccounts]
  )
  const visibleFolders = useMemo(
    () => folders.filter((folder) => knownAccountIds.has(folder.accountId)),
    [folders, knownAccountIds]
  )
  const trashFolderIds = useMemo(
    () => folders.filter((folder) => folder.role === 'trash').map((folder) => folder.id),
    [folders]
  )
  const folderScopeExists =
    !folderId ||
    visibleFolders.some(
      (folder) => folder.id === folderId && (!accountId || folder.accountId === accountId)
    )
  const mailView =
    view === 'drafts' || view === 'operations' || view === 'settings' ? 'inbox' : view
  const messagesQuery = useInfiniteQuery({
    queryKey: [
      'messages',
      {
        accountId,
        folderId,
        view: mailView,
        search: debouncedSearch,
        readFilter,
        hiddenAccountIds
      }
    ],
    queryFn: ({ pageParam }) =>
      request('messages.list', {
        accountId,
        folderId,
        view: mailView,
        search: debouncedSearch || undefined,
        unreadOnly: readFilter === 'unread',
        cursor: pageParam,
        limit: 50
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor || undefined,
    enabled:
      visibleAccounts.length > 0 &&
      (!accountId || knownAccountIds.has(accountId)) &&
      view !== 'drafts' &&
      view !== 'operations' &&
      view !== 'settings' &&
      (!snapshotQuery.isSuccess || folderScopeExists)
  })
  const messages = useMemo(
    () =>
      messagesQuery.data?.pages
        .flatMap((page) => page.items)
        .filter((message) => knownAccountIds.has(message.accountId)) || [],
    [knownAccountIds, messagesQuery.data]
  )
  const isMailView = view !== 'drafts' && view !== 'operations' && view !== 'settings'
  const validSelection =
    selected &&
    knownAccountIds.has(selected.accountId) &&
    (!accountId || selected.accountId === accountId)
      ? selected
      : null
  const previewMessage =
    isMailView &&
    folderScopeExists &&
    !validSelection &&
    search === debouncedSearch &&
    messagesQuery.isSuccess
      ? messages[0]
      : undefined
  // Resolve the passive candidate in the same render as the first page. The
  // store still records preview intent, while body loading can start now.
  const readingTarget = isMailView
    ? validSelection ||
      (previewMessage ? { accountId: previewMessage.accountId, id: previewMessage.id } : null)
    : null
  const readingSummary = readingTarget
    ? messages.find(
        (message) =>
          message.id === readingTarget.id && message.accountId === readingTarget.accountId
      )
    : undefined
  const detailQuery = useQuery({
    queryKey: ['message', readingTarget?.accountId, readingTarget?.id],
    queryFn: () =>
      request('messages.get', {
        accountId: readingTarget!.accountId,
        messageId: readingTarget!.id
      }),
    enabled: Boolean(readingTarget),
    staleTime: Infinity
  })
  const draftsQuery = useQuery({
    queryKey: ['drafts'],
    queryFn: () => request('drafts.list', {}),
    enabled: accounts.length > 0
  })
  const operationPage =
    operationNavigation.accountId === accountId
      ? operationNavigation
      : { accountId, cursors: [undefined], index: 0 }
  const operationCursor = operationPage.cursors[operationPage.index]
  useEffect(() => {
    setOperationNavigation((current) =>
      current.accountId === accountId ? current : { accountId, cursors: [undefined], index: 0 }
    )
  }, [accountId])
  const operationsQuery = useQuery({
    queryKey: ['operations', { accountId, cursor: operationCursor }],
    queryFn: () => request('operations.page', { accountId, cursor: operationCursor, limit: 20 }),
    enabled: view === 'operations' && accounts.length > 0,
    refetchInterval: view === 'operations' ? 5_000 : false,
    placeholderData: (previous, previousQuery) =>
      (previousQuery?.queryKey[1] as { accountId?: string } | undefined)?.accountId === accountId
        ? previous
        : undefined
  })
  const drafts = (draftsQuery.data || []).filter(
    (draft) => knownAccountIds.has(draft.accountId) && (!accountId || draft.accountId === accountId)
  )
  const refreshSelectedSentSummary = useCallback(
    (affectedAccountId?: string) => {
      const target = useUi.getState().selected
      if (!target || target.accountId !== affectedAccountId) return
      const queryKey = ['message', target.accountId, target.id] as const
      if (!queryClient.getQueryData<MessageDetail>(queryKey)?.sentCopy) return
      const key = JSON.stringify(queryKey)
      const existing = summaryRefreshes.current.get(key)
      if (existing) {
        existing.dirty = true
        return
      }
      const refresh = { dirty: false }
      summaryRefreshes.current.set(key, refresh)
      void (async () => {
        do {
          refresh.dirty = false
          const fresh = await request('messages.get', {
            accountId: target.accountId,
            messageId: target.id
          })
          const current = useUi.getState().selected
          if (
            summaryRefreshes.current.get(key) !== refresh ||
            current?.accountId !== target.accountId ||
            current.id !== target.id ||
            fresh.accountId !== target.accountId ||
            fresh.id !== target.id
          )
            return
          queryClient.setQueryData<MessageDetail>(queryKey, (cached) => {
            if (!cached) return cached
            const { body: _body, ...summary } = fresh
            return {
              ...cached,
              ...summary,
              sentCopy: fresh.sentCopy,
              localOnly: fresh.localOnly,
              body: cached.body
            }
          })
        } while (refresh.dirty)
      })()
        .catch(() => {
          /* A background metadata check cannot discard an open cached body. */
        })
        .finally(() => {
          if (summaryRefreshes.current.get(key) === refresh) summaryRefreshes.current.delete(key)
        })
    },
    [queryClient]
  )

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 250)
    return () => clearTimeout(timer)
  }, [search])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 6000)
    return () => clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    if (!window.mail?.subscribe) return
    const unsubscribe = window.mail.subscribe((event) => {
      if (event.type === 'window.chrome.changed') return
      if (event.type === 'window.close.requested') {
        if (closingRequests.current.has(event.requestId)) return
        closingRequests.current.add(event.requestId)
        void runCloseGuards()
          .then((allow) => request('window.close.resolve', { requestId: event.requestId, allow }))
          .catch((error) => notify(errorMessage(error)))
          .finally(() => {
            closingRequests.current.delete(event.requestId)
          })
        return
      }
      if (event.type === 'operation.changed') operationsChanged()
      else if (event.type === 'account.changed')
        void queryClient.invalidateQueries({ queryKey: ['snapshot'] })
      else if (event.type === 'data.changed') {
        refreshSelectedSentSummary(event.accountId)
        void invalidateMessages(event.accountId)
        void queryClient.invalidateQueries({ queryKey: ['snapshot'] })
        draftsChanged()
      }
    })
    void request('window.close.ready', {}).catch((error) => notify(errorMessage(error)))
    return () => {
      unsubscribe()
      summaryRefreshes.current.clear()
    }
  }, [
    draftsChanged,
    invalidateMessages,
    operationsChanged,
    queryClient,
    refreshSelectedSentSummary,
    notify
  ])
  useEffect(() => {
    // Bodies are immutable cache entries. A metadata page can update flags and
    // Sent-copy state without fetching or replacing the cached body.
    for (const message of messages)
      queryClient.setQueryData<MessageDetail>(
        ['message', message.accountId, message.id],
        (cached) =>
          cached
            ? {
                ...cached,
                ...message,
                sentCopy: message.sentCopy,
                localOnly: message.localOnly,
                body: cached.body
              }
            : cached
      )
  }, [messages, queryClient])
  useEffect(() => {
    if (snapshotQuery.isSuccess && accountId && !knownAccountIds.has(accountId))
      switchAccount(undefined, folders)
    else if (snapshotQuery.isSuccess && !folderScopeExists) navigate(view, accountId)
    else if (snapshotQuery.isSuccess && selected && !knownAccountIds.has(selected.accountId))
      select(null)
  }, [
    accountId,
    knownAccountIds,
    folderScopeExists,
    navigate,
    switchAccount,
    folders,
    view,
    select,
    selected,
    snapshotQuery.isSuccess,
    navigationBlocked
  ])
  useEffect(() => {
    if (
      view === 'drafts' ||
      view === 'operations' ||
      view === 'settings' ||
      search !== debouncedSearch ||
      !messagesQuery.isSuccess
    )
      return
    // An explicit selection or newer navigation can arrive before this effect
    // runs. A passive candidate must leave that newer intent untouched.
    const current = useUi.getState()
    if (
      current.view !== view ||
      current.accountId !== accountId ||
      current.folderId !== folderId ||
      current.search !== search ||
      current.readFilter !== readFilter
    )
      return
    if (
      current.selected &&
      knownAccountIds.has(current.selected.accountId) &&
      (!accountId || current.selected.accountId === accountId)
    )
      return
    if (readingTarget) preview(readingTarget)
  }, [
    debouncedSearch,
    accountId,
    folderId,
    knownAccountIds,
    messagesQuery.isSuccess,
    readFilter,
    search,
    preview,
    validSelection,
    readingTarget?.id,
    readingTarget?.accountId,
    view
  ])

  const action: MessageAction = useCallback(
    async (message, kind, value) => {
      if (kind === 'trash' && message.folderIds.some((id) => trashFolderIds.includes(id))) return
      if (message.localOnly) {
        notify('服务器副本尚未确认，暂不能修改远端邮件状态。')
        return
      }
      const key = `${message.accountId}:${message.id}:${kind}`
      if (pendingActions.current.has(key)) return
      pendingActions.current.add(key)
      try {
        const operation = await request('messages.action', {
          requestId: crypto.randomUUID(),
          accountId: message.accountId,
          messageIds: [message.id],
          action: kind,
          value
        })
        if (operation.state === 'failed')
          notify(operation.error || '操作未完成，可在操作队列中重试。')
        if (operation.state !== 'failed' && kind !== 'trash')
          queryClient.setQueryData<MessageDetail>(
            ['message', message.accountId, message.id],
            (cached) =>
              cached
                ? {
                    ...cached,
                    ...(kind === 'markRead' ? { isRead: !!value } : { isStarred: !!value })
                  }
                : cached
          )
        await invalidateMessages(message.accountId)
        operationsChanged()
        if (kind === 'trash' && operation.state !== 'failed') {
          const current = useUi.getState().selected
          if (current?.id === message.id && current.accountId === message.accountId) select(null)
          notify('已移到垃圾箱')
        }
      } catch (caught) {
        notify(errorMessage(caught))
      } finally {
        pendingActions.current.delete(key)
      }
    },
    [invalidateMessages, notify, operationsChanged, queryClient, select, trashFolderIds]
  )
  useEffect(() => {
    autoRead.current = null
  }, [selected?.accountId, selected?.id, readRequested])
  useEffect(() => {
    const message = detailQuery.data
    if (
      !readRequested ||
      !selected ||
      !message ||
      message.localOnly ||
      message.id !== selected.id ||
      message.accountId !== selected.accountId ||
      !knownAccountIds.has(message.accountId)
    )
      return
    const key = `${message.accountId}:${message.id}`
    if (autoRead.current === key) return
    autoRead.current = key
    // A manual unread action stays in effect for this visit. Reopening the
    // message starts a new visit and can mark it read again.
    if (!message.isRead) void action(message, 'markRead', true)
  }, [action, detailQuery.data, knownAccountIds, readRequested, selected])

  const onSettingsBusyChange = useCallback(
    (busy: boolean) => {
      setNavigationBlocked(busy)
    },
    [setNavigationBlocked]
  )
  const addAccount = useCallback(() => {
    if (useUi.getState().navigationBlocked) return
    setAccountTab('add')
    setAccountEntryKey((key) => key + 1)
    setSettingsPage('accounts')
    navigate('settings')
  }, [navigate])
  const openSettings = useCallback(() => {
    if (useUi.getState().navigationBlocked || useUi.getState().view === 'settings') return
    setAccountTab('manage')
    setSettingsPage('general')
    navigate('settings')
  }, [navigate])
  const manageAccounts = useCallback(() => {
    if (useUi.getState().navigationBlocked) return
    setAccountTab('manage')
    setAccountEntryKey((key) => key + 1)
    setSettingsPage('accounts')
    navigate('settings')
  }, [navigate])
  const compose = useCallback(
    (seed?: DraftInput) => {
      if (useUi.getState().navigationBlocked) return
      if (!visibleAccounts.length || (seed && !knownAccountIds.has(seed.accountId))) {
        if (accounts.length) manageAccounts()
        else addAccount()
        return
      }
      setComposeSeed(
        seed || {
          accountId:
            (accountId && knownAccountIds.has(accountId) ? accountId : undefined) ||
            visibleAccounts[0]!.id,
          to: [],
          cc: [],
          bcc: [],
          subject: '',
          text: '',
          html: null,
          attachmentIds: []
        }
      )
      setComposeOpen(true)
    },
    [accountId, accounts, visibleAccounts, knownAccountIds, addAccount, manageAccounts]
  )
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (
        ['n', 'k'].includes(event.key.toLowerCase()) &&
        document.querySelector('[role="dialog"], [role="alertdialog"]')
      ) {
        event.preventDefault()
        return
      }
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault()
        if (!composeOpen && !navigationBlocked) compose()
      }
      if (event.key.toLowerCase() === 'k') {
        if (composeOpen || navigationBlocked) return
        event.preventDefault()
        document.querySelector<HTMLInputElement>('input[aria-label="搜索邮件"]')?.focus()
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [compose, composeOpen, navigationBlocked])
  async function demo() {
    setDemoBusy(true)
    try {
      await request('accounts.demo', {})
      navigate('inbox')
      accountsChanged()
      notify('演示邮箱已就绪，所有演示操作都只保存在本机。')
    } catch (caught) {
      notify(errorMessage(caught))
    } finally {
      setDemoBusy(false)
    }
  }
  async function sync() {
    const target = accountId || '*'
    setSyncTargets((current) => [...new Set([...current, target])])
    try {
      await request('accounts.sync', { accountId })
      const fresh = await request('app.snapshot', {})
      queryClient.setQueryData(['snapshot'], fresh)
      await invalidateMessages(accountId)
      const failed = fresh.accounts.filter(
        (account) =>
          (!accountId || account.id === accountId) &&
          (account.status === 'error' || account.status === 'reauth')
      )
      notify(
        failed.length ? `${failed.length} 个账号同步未完成，请在账号设置中查看原因。` : '同步已完成'
      )
    } catch (caught) {
      notify(errorMessage(caught))
      void queryClient.invalidateQueries({ queryKey: ['snapshot'] })
      void invalidateMessages(accountId)
    } finally {
      setSyncTargets((current) => current.filter((item) => item !== target))
    }
  }
  const loadMore = useCallback(() => {
    void messagesQuery.fetchNextPage()
  }, [messagesQuery.fetchNextPage])
  const syncing =
    syncTargets.some((target) => !accountId || target === '*' || target === accountId) ||
    accounts.some(
      (account) => account.status === 'syncing' && (!accountId || account.id === accountId)
    )
  return (
    <div className="app-shell">
      <TitleBar accounts={visibleAccounts} chrome={chrome} />
      <div className="workspace">
        <Sidebar
          snapshot={snapshot}
          onAdd={addAccount}
          onSettings={openSettings}
          draftCount={drafts.length}
          onCompose={() => compose()}
          platform={chrome.platform}
        />
        {view === 'settings' ? (
          <SettingsPage
            section={settingsPage}
            onSectionChange={setSettingsPage}
            chrome={chrome}
            onTheme={setTheme}
            onAccentColor={setAccentColor}
            themeBusy={themeBusy}
            accounts={accounts}
            onAccountsChanged={accountsChanged}
            onAccountUpdated={accountUpdated}
            onBusyChange={onSettingsBusyChange}
            initialAccountTab={accountTab}
            accountEntryKey={accountEntryKey}
          />
        ) : !accounts.length ? (
          <Welcome
            onAdd={addAccount}
            onDemo={() => void demo()}
            busy={demoBusy || snapshotQuery.isPending}
            error={snapshotQuery.error ? errorMessage(snapshotQuery.error) : undefined}
            onRetry={() => {
              void snapshotQuery.refetch()
            }}
          />
        ) : !visibleAccounts.length && view !== 'operations' ? (
          <main className="utility-view">
            <div className="small-empty">
              <EyeOff size={28} aria-hidden="true" />
              <strong>邮箱账号已全部隐藏</strong>
              <p>邮件仍会继续同步，在账号管理中恢复显示即可查看。</p>
              <Button unstyled type="button" className="button" onClick={manageAccounts}>
                管理邮箱账号
              </Button>
            </div>
          </main>
        ) : view === 'drafts' ? (
          <DraftsView
            drafts={drafts}
            accounts={visibleAccounts}
            loading={draftsQuery.isPending}
            error={draftsQuery.error ? errorMessage(draftsQuery.error) : undefined}
            onOpen={(draft) => compose(draft)}
            onCompose={() => compose()}
            onChanged={draftsChanged}
            notify={notify}
          />
        ) : view === 'operations' ? (
          <OperationsView
            operations={operationsQuery.data?.items || []}
            accounts={accounts}
            loading={operationsQuery.isPending}
            stats={operationsQuery.data}
            pagination={{
              page: operationPage.index + 1,
              hasPrevious: operationPage.index > 0,
              hasNext: Boolean(operationsQuery.data?.nextCursor),
              loading: operationsQuery.isPending || operationsQuery.isPlaceholderData,
              onPrevious: () => {
                setOperationNavigation({ ...operationPage, index: operationPage.index - 1 })
              },
              onNext: () => {
                const cursor = operationsQuery.data?.nextCursor
                if (!cursor || operationsQuery.isPlaceholderData) return
                setOperationNavigation({
                  accountId,
                  cursors: [...operationPage.cursors.slice(0, operationPage.index + 1), cursor],
                  index: operationPage.index + 1
                })
              }
            }}
            error={operationsQuery.error ? errorMessage(operationsQuery.error) : undefined}
            onChanged={operationsChanged}
            notify={notify}
          />
        ) : (
          <>
            <MailList
              trashFolderIds={trashFolderIds}
              accounts={visibleAccounts}
              messages={messages}
              loading={messagesQuery.isPending}
              error={
                messagesQuery.error
                  ? errorMessage(messagesQuery.error)
                  : snapshotQuery.error
                    ? errorMessage(snapshotQuery.error)
                    : undefined
              }
              loadingMore={messagesQuery.isFetchingNextPage}
              hasMore={Boolean(messagesQuery.hasNextPage)}
              loadMore={loadMore}
              onSync={() => void sync()}
              syncing={syncing}
              onAction={action}
              folderName={
                folderId ? visibleFolders.find((folder) => folder.id === folderId)?.name : undefined
              }
              unreadCount={
                folderId
                  ? visibleFolders.find((folder) => folder.id === folderId)?.unreadCount
                  : mailView === 'inbox'
                    ? visibleFolders
                        .filter(
                          (folder) =>
                            folder.role === 'inbox' &&
                            (!accountId || folder.accountId === accountId)
                        )
                        .reduce((sum, folder) => sum + folder.unreadCount, 0)
                    : undefined
              }
            />
            <MailReader
              trashFolderIds={trashFolderIds}
              isTrashView={view === 'trash'}
              theme={chrome.theme}
              message={readingTarget ? detailQuery.data : undefined}
              summary={readingSummary}
              account={visibleAccounts.find((account) => account.id === readingTarget?.accountId)}
              loading={
                readingTarget
                  ? detailQuery.isPending
                  : messagesQuery.isPending || search !== debouncedSearch || !folderScopeExists
              }
              error={
                readingTarget && detailQuery.error
                  ? errorMessage(detailQuery.error)
                  : !readingTarget && messagesQuery.error
                    ? errorMessage(messagesQuery.error)
                    : undefined
              }
              onAction={action}
              onCompose={(seed) => compose(seed)}
              notify={notify}
            />
          </>
        )}
      </div>
      {composeOpen && (
        <Suspense
          fallback={
            <Modal
              open
              onOpenChange={setComposeOpen}
              title="写一封新邮件"
              description="正在准备编辑器…"
              className="compose-loading-modal"
            >
              <div className="utility-loading">
                <Spinner size={24} />
              </div>
            </Modal>
          }
        >
          <ComposeDialog
            open={composeOpen}
            onOpenChange={setComposeOpen}
            accounts={visibleAccounts}
            seed={composeSeed}
            onChanged={compositionChanged}
            notify={notify}
          />
        </Suspense>
      )}
      {notice && (
        <div role="status" className="toast">
          <Info size={18} />
          <span>{notice}</span>
          <IconButton label="关闭提示" onClick={() => setNotice('')}>
            <X size={14} />
          </IconButton>
        </div>
      )}
    </div>
  )
}
