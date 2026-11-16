import { Button } from './ui/button'
import { ScrollArea } from './ui/scroll-area'
import { Input } from './ui/input'
import { Label } from './ui/label'
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode
} from 'react'
import {
  ArrowUpRight,
  Check,
  Eye,
  EyeOff,
  Globe2,
  Mail,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2
} from 'lucide-react'
import type { Account } from '../../../shared/model'
import { errorMessage, request } from '../lib'
import { CheckboxField, ErrorPanel, IconButton, Modal, Spinner } from './primitives'
import { Select } from './Select'
import { ConfirmDialog } from './ConfirmDialog'
import '../account-profile.css'

type Provider = 'qq' | '163' | 'imap' | 'gmail' | 'graph'
export type AccountUpdateHandler = (
  account: Account,
  change: 'profile' | 'visibility'
) => void | Promise<void>
const providers: { id: Provider; label: string; mark: string }[] = [
  { id: 'qq', label: 'QQ 邮箱', mark: 'Q' },
  { id: '163', label: '网易邮箱', mark: '163' },
  { id: 'gmail', label: 'Gmail', mark: 'G' },
  { id: 'graph', label: 'Outlook', mark: 'O' },
  { id: 'imap', label: '其他邮箱', mark: '@' }
]
const accountColors = [
  { value: '#d66a49', label: '珊瑚色' },
  { value: '#6f8d75', label: '鼠尾草绿' },
  { value: '#5d83b2', label: '湖蓝色' },
  { value: '#a17fa9', label: '浅紫色' },
  { value: '#c3a15d', label: '沙金色' }
]
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <Label unstyled className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </Label>
  )
}
/** Account content shares the settings window's navigation and focus scope. */
export function AccountPanel({
  accounts,
  onChanged,
  onUpdated,
  onBusyChange,
  initialTab = 'add'
}: {
  accounts: Account[]
  onChanged: () => void
  onUpdated?: AccountUpdateHandler
  onBusyChange?: (busy: boolean) => void
  initialTab?: 'add' | 'manage'
}) {
  const [tab, setTab] = useState(initialTab)
  const [provider, setProvider] = useState<Provider>('qq')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('我的邮箱')
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [imapHost, setImapHost] = useState('imap.qq.com')
  const [smtpHost, setSmtpHost] = useState('smtp.qq.com')
  const [imapPort, setImapPort] = useState(993)
  const [smtpPort, setSmtpPort] = useState(465)
  const [imapSecure, setImapSecure] = useState(true)
  const [smtpSecure, setSmtpSecure] = useState(true)
  const [sentCopy, setSentCopy] = useState<'auto' | 'server' | 'append'>('auto')
  const [color, setColor] = useState('#d66a49')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [tenant, setTenant] = useState('common')
  const [busy, setBusy] = useState(false)
  const [visibilityPending, setVisibilityPending] = useState<string[]>([])
  const [visibilityErrors, setVisibilityErrors] = useState<Record<string, string>>({})
  const visibilityInFlight = useRef(new Set<string>())
  const confirmedVisibility = useRef(new Map<string, boolean>())
  useEffect(() => {
    for (const [id, hidden] of confirmedVisibility.current) {
      const account = accounts.find((item) => item.id === id)
      if (!account || (!visibilityInFlight.current.has(id) && Boolean(account.hidden) === hidden))
        confirmedVisibility.current.delete(id)
    }
  }, [accounts, visibilityPending])
  const [error, setError] = useState('')
  const [removing, setRemoving] = useState<Account | null>(null)
  const removeTrigger = useRef<HTMLButtonElement | null>(null)
  const [editing, setEditing] = useState<Account | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('')
  const editTrigger = useRef<HTMLButtonElement | null>(null)
  const editNameInput = useRef<HTMLInputElement | null>(null)
  const oauth = provider === 'gmail' || provider === 'graph'
  function setWorking(value: boolean) {
    setBusy(value)
    onBusyChange?.(value)
  }
  function chooseProvider(next: Provider) {
    setProvider(next)
    setError('')
    if (next === 'qq' || next === '163') {
      setImapHost(`imap.${next}.com`)
      setSmtpHost(`smtp.${next}.com`)
      setImapPort(993)
      setSmtpPort(465)
      setImapSecure(true)
      setSmtpSecure(true)
      setSentCopy('auto')
    }
    if (next === 'imap') {
      setSentCopy('server')
      setImapHost('')
      setSmtpHost('')
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setWorking(true)
    setError('')
    try {
      if (oauth)
        await request('accounts.oauth', {
          provider,
          clientId: clientId.trim(),
          clientSecret: provider === 'gmail' ? clientSecret || undefined : undefined,
          tenant: provider === 'graph' ? tenant || 'common' : undefined,
          name: name.trim(),
          color
        })
      else
        await request('accounts.addImap', {
          email: email.trim(),
          name: name.trim(),
          color,
          password,
          config: {
            kind: 'imap',
            username: username.trim() || email.trim(),
            imap: { host: imapHost.trim(), port: imapPort, secure: imapSecure },
            smtp: { host: smtpHost.trim(), port: smtpPort, secure: smtpSecure },
            sentCopy
          }
        })
      setPassword('')
      setClientSecret('')
      onChanged()
      setTab('manage')
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setWorking(false)
    }
  }
  async function remove(account: Account) {
    await request('accounts.remove', { accountId: account.id })
    onChanged()
  }
  function edit(account: Account, trigger: HTMLButtonElement) {
    editTrigger.current = trigger
    setRemoving(null)
    setError('')
    setEditName(account.name)
    setEditColor(account.color)
    setEditing(account)
  }
  async function saveProfile(event: FormEvent) {
    event.preventDefault()
    if (busy || !editing) return
    if (!editName.trim()) {
      setError('请输入账号名称。')
      return
    }
    setWorking(true)
    setError('')
    try {
      const updated = await request('accounts.update', {
        accountId: editing.id,
        name: editName.trim(),
        color: editColor
      })
      if (onUpdated) await onUpdated(updated, 'profile')
      else onChanged()
      setEditing(null)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setWorking(false)
    }
  }
  async function toggleVisibility(account: Account) {
    if (busy || visibilityInFlight.current.has(account.id)) return
    visibilityInFlight.current.add(account.id)
    setVisibilityPending((current) => [...current, account.id])
    setVisibilityErrors((current) => {
      const next = { ...current }
      delete next[account.id]
      return next
    })
    setRemoving(null)
    try {
      const hidden = !(confirmedVisibility.current.get(account.id) ?? Boolean(account.hidden))
      const updated = await request('accounts.update', { accountId: account.id, hidden })
      confirmedVisibility.current.set(account.id, Boolean(updated.hidden))
      if (onUpdated) await onUpdated(updated, 'visibility')
      else onChanged()
    } catch (caught) {
      setVisibilityErrors((current) => ({ ...current, [account.id]: errorMessage(caught) }))
    } finally {
      visibilityInFlight.current.delete(account.id)
      setVisibilityPending((current) => current.filter((id) => id !== account.id))
    }
  }
  return (
    <div className="account-panel" aria-busy={busy || undefined}>
      <div className="dialog-tabs" role="group" aria-label="账号设置页签">
        <Button
          unstyled
          type="button"
          className={tab === 'add' ? 'active' : ''}
          aria-pressed={tab === 'add'}
          disabled={busy}
          onClick={() => {
            setTab('add')
            setError('')
          }}
        >
          <Plus size={15} />
          添加邮箱
        </Button>
        <Button
          unstyled
          type="button"
          className={tab === 'manage' ? 'active' : ''}
          aria-pressed={tab === 'manage'}
          disabled={busy}
          onClick={() => {
            setTab('manage')
            setError('')
          }}
        >
          <Mail size={15} />
          已连接账号 <span>{accounts.length}</span>
        </Button>
      </div>
      <ScrollArea
        className="account-panel-scroll-area"
        viewportClassName="dialog-scroll"
        viewportProps={{ 'aria-label': '邮箱账号设置内容', tabIndex: 0 }}
      >
        {tab === 'manage' ? (
          <div className="managed-accounts">
            {accounts.length === 0 && (
              <div className="small-empty">
                <Mail size={28} />
                <strong>还没有连接邮箱</strong>
                <p>添加第一个账号，开启更轻松的邮件日常。</p>
                <Button unstyled className="button primary" onClick={() => setTab('add')}>
                  添加邮箱
                </Button>
              </div>
            )}
            {accounts.map((storedAccount) => {
              const account = confirmedVisibility.current.has(storedAccount.id)
                ? { ...storedAccount, hidden: confirmedVisibility.current.get(storedAccount.id)! }
                : storedAccount
              const updatingVisibility = visibilityPending.includes(account.id)
              return (
                <div className="managed-account" key={account.id}>
                  <div className="managed-account-row">
                    <span
                      className="account-avatar"
                      style={{ '--account-color': account.color } as CSSProperties}
                    >
                      {account.name.slice(0, 1)}
                    </span>
                    <div className="managed-account-copy">
                      <strong>
                        <span>{account.name}</span>
                        {account.provider === 'demo' && <span className="demo-tag">演示</span>}
                        {account.hidden && <span className="account-hidden-tag">已隐藏</span>}
                      </strong>
                      <p>{account.email}</p>
                      {account.error && <small className="danger-text">{account.error}</small>}
                      {visibilityErrors[account.id] && (
                        <small className="danger-text" role="alert">
                          {visibilityErrors[account.id]}
                        </small>
                      )}
                    </div>
                    <div className="managed-account-actions">
                      <IconButton
                        label={`修改 ${account.email}`}
                        disabled={busy || editing !== null || updatingVisibility}
                        onClick={(event) => edit(account, event.currentTarget)}
                      >
                        <Pencil size={16} aria-hidden="true" />
                      </IconButton>
                      <IconButton
                        label={`${account.hidden ? '显示' : '隐藏'} ${account.email}`}
                        disabled={busy || editing !== null || updatingVisibility}
                        aria-busy={updatingVisibility || undefined}
                        onClick={() => void toggleVisibility(account)}
                      >
                        {account.hidden ? (
                          <Eye size={17} aria-hidden="true" />
                        ) : (
                          <EyeOff size={17} aria-hidden="true" />
                        )}
                      </IconButton>
                      <IconButton
                        label={`移除 ${account.email}`}
                        className="account-remove-action"
                        disabled={busy || editing !== null || updatingVisibility}
                        onClick={(event) => {
                          removeTrigger.current = event.currentTarget
                          setError('')
                          setRemoving(account)
                        }}
                      >
                        <Trash2 size={17} aria-hidden="true" />
                      </IconButton>
                    </div>
                  </div>
                </div>
              )
            })}
            <div className="privacy-note">
              <ShieldCheck size={18} />
              <span>
                隐藏账号后，不再显示在侧栏和邮件视图中。邮件继续同步，可随时在这里恢复显示。
              </span>
            </div>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)}>
            <fieldset className="account-form-fields" disabled={busy}>
              <div className="provider-grid">
                {providers.map((item) => (
                  <Button
                    unstyled
                    type="button"
                    key={item.id}
                    className={`provider-option ${provider === item.id ? 'selected' : ''}`}
                    onClick={() => chooseProvider(item.id)}
                    disabled={busy}
                  >
                    <span className={`provider-mark provider-mark-${item.id}`}>{item.mark}</span>
                    {item.label}
                    {provider === item.id && <Check className="provider-check" size={12} />}
                  </Button>
                ))}
              </div>
              <div className="form-grid">
                <Field label="账号名称">
                  <Input
                    unstyled
                    required
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="例如：工作邮箱"
                    maxLength={100}
                  />
                </Field>
                <Field label="账号颜色">
                  <div className="color-options">
                    {accountColors.map(({ value, label }) => (
                      <Button
                        unstyled
                        type="button"
                        key={value}
                        aria-label={`选择${label}`}
                        aria-pressed={color === value}
                        className={color === value ? 'selected' : ''}
                        style={{ '--account-color': value } as CSSProperties}
                        onClick={() => setColor(value)}
                      >
                        {color === value && <Check size={13} />}
                      </Button>
                    ))}
                  </div>
                </Field>
              </div>
              {oauth ? (
                <>
                  <div className="oauth-note">
                    <Globe2 size={19} />
                    <div>
                      <strong>通过系统浏览器安全授权</strong>
                      <p>
                        当前开发版本需要填写你在{' '}
                        {provider === 'gmail' ? 'Google Cloud' : 'Microsoft Entra'} 创建的应用
                        Client ID。无需在这里输入邮箱密码。
                      </p>
                    </div>
                  </div>
                  <Field label="应用 Client ID">
                    <Input
                      unstyled
                      required
                      value={clientId}
                      onChange={(event) => setClientId(event.target.value)}
                      placeholder={
                        provider === 'gmail'
                          ? '…apps.googleusercontent.com'
                          : '应用程序（客户端）ID'
                      }
                    />
                  </Field>
                  {provider === 'gmail' ? (
                    <Field
                      label="桌面应用 Client Secret（如已分配）"
                      hint="使用 Google 的“桌面应用”OAuth 客户端，回调由桌面应用处理。"
                    >
                      <Input
                        unstyled
                        type="password"
                        value={clientSecret}
                        onChange={(event) => setClientSecret(event.target.value)}
                        autoComplete="off"
                        placeholder="Google OAuth 客户端密钥"
                      />
                    </Field>
                  ) : (
                    <>
                      <Field
                        label="租户"
                        hint="个人与工作账号通常使用 common；企业策略可能要求管理员同意。"
                      >
                        <Input
                          unstyled
                          required
                          value={tenant}
                          onChange={(event) => setTenant(event.target.value)}
                          placeholder="common"
                        />
                      </Field>
                      <p className="oauth-setup-hint">
                        请在 Microsoft Entra 为应用添加“移动和桌面应用”平台，登记{' '}
                        <code>http://localhost</code> 重定向
                        URI。连接个人邮箱时，应用注册还需允许个人 Microsoft 账号。
                      </p>
                    </>
                  )}
                </>
              ) : (
                <>
                  <Field label="邮箱地址">
                    <Input
                      unstyled
                      required
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder={
                        provider === 'qq'
                          ? 'you@qq.com'
                          : provider === '163'
                            ? 'you@163.com'
                            : 'you@example.com'
                      }
                      autoComplete="username"
                    />
                  </Field>
                  <Field
                    label={provider === 'imap' ? '密码 / 客户端授权码' : '客户端授权码'}
                    hint={
                      provider === 'imap'
                        ? '按邮箱服务商要求填写授权码或专用密码。'
                        : '请先在邮箱网页版开启 IMAP/SMTP 服务，并生成客户端授权码。'
                    }
                  >
                    <Input
                      unstyled
                      required
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="凭据仅保存在这台电脑"
                      autoComplete="new-password"
                    />
                  </Field>
                  <details className="server-details" open={provider === 'imap'}>
                    <summary>服务器与发送设置</summary>
                    <Field label="登录用户名（留空使用邮箱地址）">
                      <Input
                        unstyled
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        placeholder={email || '邮箱地址'}
                      />
                    </Field>
                    <div className="form-grid">
                      <Field label="IMAP 服务器">
                        <Input
                          unstyled
                          required
                          value={imapHost}
                          onChange={(event) => setImapHost(event.target.value)}
                          placeholder="imap.example.com"
                        />
                      </Field>
                      <Field label="端口">
                        <Input
                          unstyled
                          type="number"
                          required
                          min={1}
                          max={65535}
                          value={imapPort}
                          onChange={(event) => setImapPort(Number(event.target.value))}
                        />
                      </Field>
                    </div>
                    <CheckboxField
                      id="imap-secure"
                      checked={imapSecure}
                      onCheckedChange={setImapSecure}
                      disabled={busy}
                    >
                      IMAP 使用隐式 TLS（通常为 993 端口）
                    </CheckboxField>
                    <div className="form-grid">
                      <Field label="SMTP 服务器">
                        <Input
                          unstyled
                          required
                          value={smtpHost}
                          onChange={(event) => setSmtpHost(event.target.value)}
                          placeholder="smtp.example.com"
                        />
                      </Field>
                      <Field label="端口">
                        <Input
                          unstyled
                          type="number"
                          required
                          min={1}
                          max={65535}
                          value={smtpPort}
                          onChange={(event) => setSmtpPort(Number(event.target.value))}
                        />
                      </Field>
                    </div>
                    <CheckboxField
                      id="smtp-secure"
                      checked={smtpSecure}
                      onCheckedChange={setSmtpSecure}
                      disabled={busy}
                    >
                      SMTP 使用隐式 TLS（通常为 465 端口）
                    </CheckboxField>
                    <Field label="已发送邮件副本">
                      <Select<'auto' | 'server' | 'append'>
                        ariaLabel="已发送邮件副本"
                        value={sentCopy}
                        onValueChange={setSentCopy}
                        disabled={busy}
                        options={[
                          { value: 'auto', label: '自动核验并补存缺失副本' },
                          { value: 'server', label: '仅核验服务器保存（不自动补存）' },
                          { value: 'append', label: '客户端保存到已发送文件夹' }
                        ]}
                      />
                    </Field>
                    <small className="muted">
                      未选择隐式 TLS 时，连接必须成功升级至 STARTTLS。
                    </small>
                  </details>
                </>
              )}
              {error && <ErrorPanel message={error} />}
              <div className="dialog-footer">
                <span>
                  <ShieldCheck size={14} />
                  本机存储 · 直接连接
                </span>
                <Button unstyled className="button primary" type="submit" disabled={busy}>
                  {busy ? <Spinner /> : oauth ? <ArrowUpRight size={16} /> : <Plus size={16} />}
                  {busy
                    ? oauth
                      ? '正在等待浏览器授权…'
                      : '正在连接邮箱…'
                    : oauth
                      ? '打开浏览器并授权'
                      : '连接邮箱'}
                </Button>
              </div>
            </fieldset>
          </form>
        )}
        {tab === 'manage' && error && !editing && <ErrorPanel message={error} />}
      </ScrollArea>
      <Modal
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setEditing(null)
            setError('')
          }
        }}
        title="编辑邮箱账号"
        description={editing?.email}
        className="account-profile-modal"
        closeDisabled={busy}
        initialFocusRef={editNameInput}
        returnFocusRef={editTrigger}
      >
        {editing && (
          <form className="account-profile-form" onSubmit={(event) => void saveProfile(event)}>
            <fieldset className="account-form-fields" disabled={busy}>
              <Field label="账号名称">
                <Input
                  unstyled
                  ref={editNameInput}
                  required
                  maxLength={100}
                  value={editName}
                  onChange={(event) => setEditName(event.target.value)}
                  placeholder="例如：工作邮箱"
                />
              </Field>
              <div className="field">
                <span id="profile-account-color">账号颜色</span>
                <div className="color-options" role="group" aria-labelledby="profile-account-color">
                  {[
                    ...(!accountColors.some(({ value }) => value === editing.color)
                      ? [{ value: editing.color, label: '当前颜色' }]
                      : []),
                    ...accountColors
                  ].map(({ value, label }) => (
                    <Button
                      unstyled
                      type="button"
                      key={value}
                      aria-label={`选择${label}`}
                      aria-pressed={editColor === value}
                      className={editColor === value ? 'selected' : ''}
                      style={{ '--account-color': value } as CSSProperties}
                      onClick={() => setEditColor(value)}
                    >
                      {editColor === value && <Check size={13} aria-hidden="true" />}
                    </Button>
                  ))}
                </div>
              </div>
              <p className="account-profile-hint">
                修改账号名称和标识颜色，邮箱地址与连接信息保持不变。
              </p>
              {error && <ErrorPanel message={error} />}
              <div className="button-row">
                <Button
                  unstyled
                  type="button"
                  className="button"
                  onClick={() => {
                    setEditing(null)
                    setError('')
                  }}
                >
                  取消
                </Button>
                <Button unstyled type="submit" className="button primary">
                  {busy && <Spinner />}保存修改
                </Button>
              </div>
            </fieldset>
          </form>
        )}
      </Modal>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null)
        }}
        title={`移除 ${removing?.email || '邮箱账号'}？`}
        description="将清除此账号的本地邮件、草稿、待处理任务与凭据，邮箱服务器上的邮件不会被删除。"
        confirmLabel="确认移除"
        returnFocusRef={removeTrigger}
        onBusyChange={setWorking}
        onConfirm={async () => {
          if (removing) await remove(removing)
        }}
      />
    </div>
  )
}
