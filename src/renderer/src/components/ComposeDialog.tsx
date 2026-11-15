import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Bold, FileText, Italic, List, Paperclip, Quote, Redo2, Send, Undo2, X } from 'lucide-react'
import type { Account, DraftAttachment, DraftInput } from '../../../shared/model'
import { addresses, errorMessage, escapeHtml, fileSize, request } from '../lib'
import { registerCloseGuard } from '../close-guards'
import { MAX_DRAFT_ATTACHMENTS, mergeDraftAttachments } from '../compose-attachments'
import { ErrorPanel, IconButton, Modal, Spinner } from './primitives'
import { Select } from './Select'
import { ConfirmDialogFrame } from './ConfirmDialog'

function AccountOption({ account }: { account: Account }) {
  return (
    <span className="account-option">
      <span
        aria-hidden="true"
        className="account-option-dot"
        style={{ '--account-color': account.color } as CSSProperties}
      />
      <span className="account-option-copy">
        <span className="account-option-name">{account.name}</span>
        <span className="account-option-email">{account.email}</span>
      </span>
      {account.provider === 'demo' && <span className="account-option-badge">演示</span>}
    </span>
  )
}

export function ComposeDialog({
  open,
  onOpenChange,
  accounts,
  seed,
  onChanged,
  notify
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  accounts: Account[]
  seed: DraftInput | null
  onChanged: (accountId: string, change: 'draft' | 'send') => void
  notify: (message: string) => void
}) {
  const [accountId, setAccountId] = useState('')
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [bcc, setBcc] = useState('')
  const [showCc, setShowCc] = useState(false)
  const [subject, setSubject] = useState('')
  const [attachments, setAttachments] = useState<DraftAttachment[]>([])
  const [busy, setBusy] = useState<'save' | 'send' | 'pick' | null>(null)
  const [error, setError] = useState('')
  const [closeRequested, setCloseRequested] = useState(false)
  const continueButton = useRef<HTMLButtonElement | null>(null)
  const baseline = useRef('')
  const submission = useRef<{ signature: string; requestId: string } | null>(null)
  const pendingClose = useRef<{
    promise: Promise<boolean>
    resolve: (allow: boolean) => void
  } | null>(null)
  const closeGuard = useRef<() => Promise<boolean>>(async () => false)
  const [, render] = useState(0)
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: false, codeBlock: false, horizontalRule: false })],
    content: '',
    immediatelyRender: false,
    editorProps: {
      attributes: { 'aria-label': '邮件正文', class: 'compose-editor', spellcheck: 'false' }
    },
    onTransaction: () => render((value) => value + 1)
  })
  useEffect(() => {
    if (!open) return
    setAccountId(seed?.accountId || accounts[0]?.id || '')
    setTo(seed?.to.join(', ') || '')
    setCc(seed?.cc.join(', ') || '')
    setBcc(seed?.bcc.join(', ') || '')
    setShowCc(Boolean(seed?.cc.length || seed?.bcc.length))
    setSubject(seed?.subject || '')
    setError('')
    setBusy(null)
    setCloseRequested(false)
    submission.current = null
    setAttachments(
      (seed?.attachmentIds || []).map(
        (id, index) =>
          seed?.attachments?.find((attachment) => attachment.id === id) || {
            id,
            filename: `已保存的附件 ${index + 1}`,
            size: 0
          }
      )
    )
    editor?.commands.setContent(
      seed?.html || (seed?.text ? `<p>${escapeHtml(seed.text).replace(/\n/g, '<br>')}</p>` : '')
    )
    baseline.current = JSON.stringify({
      accountId: seed?.accountId || accounts[0]?.id || '',
      to: seed?.to || [],
      cc: seed?.cc || [],
      bcc: seed?.bcc || [],
      subject: seed?.subject || '',
      html: editor?.getHTML() || '',
      attachmentIds: seed?.attachmentIds || []
    })
    // Opening a draft is the only event that should reset an in-progress composition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seed, editor])
  const account = accounts.find((item) => item.id === accountId)
  useEffect(() => {
    editor?.setEditable(!busy)
  }, [busy, editor])
  closeGuard.current = async () => {
    if (busy) return false
    if (!isDirty()) return true
    if (pendingClose.current) return pendingClose.current.promise
    let resolve!: (allow: boolean) => void
    const promise = new Promise<boolean>((done) => {
      resolve = done
    })
    pendingClose.current = { promise, resolve }
    setCloseRequested(true)
    return promise
  }
  useEffect(() => {
    if (!open) return
    const unregister = registerCloseGuard(() => closeGuard.current())
    return () => {
      unregister()
      resolvePendingClose(false)
    }
  }, [open])
  function data(): DraftInput {
    return {
      id: seed?.accountId === accountId ? seed.id : undefined,
      accountId,
      to: addresses(to),
      cc: addresses(cc),
      bcc: addresses(bcc),
      subject: subject.trim(),
      text: editor?.getText({ blockSeparator: '\n' }) || '',
      html: editor?.getHTML() || null,
      attachmentIds: attachments.map((item) => item.id)
    }
  }
  function isDirty() {
    const current = JSON.stringify({
      accountId,
      to: addresses(to),
      cc: addresses(cc),
      bcc: addresses(bcc),
      subject,
      html: editor?.getHTML() || '',
      attachmentIds: attachments.map((item) => item.id)
    })
    return current !== baseline.current
  }
  function resolvePendingClose(allow: boolean) {
    const pending = pendingClose.current
    pendingClose.current = null
    pending?.resolve(allow)
  }
  function requestClose(value: boolean) {
    if (busy) return
    if (value) {
      onOpenChange(true)
      return
    }
    if (isDirty()) setCloseRequested(true)
    else {
      resolvePendingClose(true)
      onOpenChange(false)
    }
  }
  function continueEditing() {
    resolvePendingClose(false)
    setCloseRequested(false)
    if (editor && !editor.isDestroyed) editor.view.focus()
  }
  function applyEditorAction(action: (activeEditor: NonNullable<typeof editor>) => void) {
    if (!editor || editor.isDestroyed || busy) return
    editor.view.focus()
    action(editor)
  }
  function discard() {
    resolvePendingClose(true)
    onOpenChange(false)
  }
  async function save() {
    if (!account || busy) return
    setBusy('save')
    setError('')
    try {
      await request('drafts.save', data())
      onChanged(accountId, 'draft')
      notify('草稿已保存在本机')
      resolvePendingClose(true)
      onOpenChange(false)
    } catch (caught) {
      resolvePendingClose(false)
      setError(errorMessage(caught))
    } finally {
      setBusy(null)
    }
  }
  async function send() {
    if (!account || busy) return
    setBusy('send')
    setError('')
    try {
      const payload = data()
      const signature = JSON.stringify(payload)
      if (!submission.current || submission.current.signature !== signature)
        submission.current = { signature, requestId: crypto.randomUUID() }
      const operation = await request('mail.send', {
        ...payload,
        requestId: submission.current.requestId
      })
      onChanged(accountId, 'send')
      if (operation.state === 'uncertain') {
        notify('发送结果待确认，请在操作队列中查看，避免重复发送。')
      } else if (operation.state === 'failed') {
        resolvePendingClose(false)
        setError(operation.error || '发送未完成，请在操作队列中查看。')
        return
      } else
        notify(
          account?.provider === 'demo'
            ? '演示邮件已提交，不会真实发送'
            : operation.state === 'succeeded'
              ? operation.sentCopy &&
                ['failed', 'missing', 'uncertain'].includes(operation.sentCopy.state)
                ? '邮件已发送，服务器副本需要处理。请在操作队列中补存或核验。'
                : operation.sentCopy && ['pending', 'saving'].includes(operation.sentCopy.state)
                  ? '邮件已发送，正在核验或保存服务器副本。'
                  : '邮件已发送'
              : '邮件已加入发送队列'
        )
      resolvePendingClose(true)
      onOpenChange(false)
    } catch (caught) {
      resolvePendingClose(false)
      setError(errorMessage(caught))
    } finally {
      setBusy(null)
    }
  }
  async function pick() {
    if (busy) return
    setBusy('pick')
    setError('')
    try {
      const selected = await request('attachments.pick', {})
      setAttachments(mergeDraftAttachments(attachments, selected))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(null)
    }
  }
  return (
    <Modal
      open={open}
      onOpenChange={requestClose}
      title={seed?.id ? '继续写信' : '写一封新邮件'}
      className="compose-modal"
      closeDisabled={Boolean(busy)}
    >
      <div className="compose-fields">
        <div className="compose-field">
          <Label unstyled htmlFor="compose-account">
            发件人
          </Label>
          <Select
            id="compose-account"
            ariaLabel="发件人"
            placeholder="选择发件账号"
            label="选择发件账号"
            value={accountId}
            onValueChange={setAccountId}
            disabled={Boolean(busy)}
            triggerClassName="compose-account-select"
            contentClassName="account-select-content"
            options={accounts.map((item) => ({
              value: item.id,
              label: `${item.name} <${item.email}>${item.provider === 'demo' ? ' · 演示账号' : ''}`,
              content: <AccountOption account={item} />
            }))}
          />
        </div>
        {seed?.id && accountId && seed.accountId !== accountId && (
          <p className="muted py-2 text-xs leading-relaxed">
            切换发件账号后将创建新草稿，原草稿会保留。
          </p>
        )}
        <div className="compose-field">
          <Label unstyled htmlFor="compose-to">
            收件人
          </Label>
          <Input
            unstyled
            id="compose-to"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            placeholder="邮箱地址，多个地址用逗号分隔"
            disabled={Boolean(busy)}
            autoFocus
          />
          <Button
            unstyled
            className="text-button"
            type="button"
            disabled={Boolean(busy)}
            onClick={() => setShowCc((value) => !value)}
          >
            {showCc ? '收起' : '抄送 / 密送'}
          </Button>
        </div>
        {showCc && (
          <>
            <div className="compose-field">
              <Label unstyled htmlFor="compose-cc">
                抄送
              </Label>
              <Input
                unstyled
                id="compose-cc"
                value={cc}
                onChange={(event) => setCc(event.target.value)}
                placeholder="抄送地址"
                disabled={Boolean(busy)}
              />
            </div>
            <div className="compose-field">
              <Label unstyled htmlFor="compose-bcc">
                密送
              </Label>
              <Input
                unstyled
                id="compose-bcc"
                value={bcc}
                onChange={(event) => setBcc(event.target.value)}
                placeholder="密送地址（其他收件人不可见）"
                disabled={Boolean(busy)}
              />
            </div>
          </>
        )}
        <div className="compose-field">
          <Label unstyled htmlFor="compose-subject">
            主题
          </Label>
          <Input
            unstyled
            id="compose-subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="给这封邮件起个标题"
            maxLength={998}
            disabled={Boolean(busy)}
          />
        </div>
      </div>
      {account?.provider === 'demo' && (
        <div className="compose-demo">
          <span className="status-dot" />
          当前使用演示账号，发送操作不会产生真实邮件。
        </div>
      )}
      <div className="compose-body">
        <div
          className={`editor-container ${editor?.isEmpty ? 'is-empty' : ''}`}
          data-placeholder="你好，"
        >
          <EditorContent editor={editor} />
        </div>
        {attachments.length > 0 && (
          <div className="compose-attachments">
            {attachments.map((attachment) => (
              <div className="attachment-chip" key={attachment.id}>
                <Paperclip size={13} />
                <span>{attachment.filename}</span>
                {attachment.size > 0 && <small>{fileSize(attachment.size)}</small>}
                <IconButton
                  label={`移除附件 ${attachment.filename}`}
                  onClick={() =>
                    setAttachments((items) => items.filter((item) => item.id !== attachment.id))
                  }
                  disabled={Boolean(busy)}
                >
                  <X size={13} />
                </IconButton>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="editor-toolbar">
        <IconButton
          label="加粗"
          className={editor?.isActive('bold') ? 'active' : ''}
          aria-pressed={editor?.isActive('bold') || false}
          disabled={!editor || Boolean(busy)}
          onClick={() =>
            applyEditorAction((activeEditor) => activeEditor.chain().toggleBold().run())
          }
        >
          <Bold size={16} />
        </IconButton>
        <IconButton
          label="斜体"
          className={editor?.isActive('italic') ? 'active' : ''}
          aria-pressed={editor?.isActive('italic') || false}
          disabled={!editor || Boolean(busy)}
          onClick={() =>
            applyEditorAction((activeEditor) => activeEditor.chain().toggleItalic().run())
          }
        >
          <Italic size={16} />
        </IconButton>
        <IconButton
          label="项目列表"
          className={editor?.isActive('bulletList') ? 'active' : ''}
          aria-pressed={editor?.isActive('bulletList') || false}
          disabled={!editor || Boolean(busy)}
          onClick={() =>
            applyEditorAction((activeEditor) => activeEditor.chain().toggleBulletList().run())
          }
        >
          <List size={17} />
        </IconButton>
        <IconButton
          label="引用"
          className={editor?.isActive('blockquote') ? 'active' : ''}
          aria-pressed={editor?.isActive('blockquote') || false}
          disabled={!editor || Boolean(busy)}
          onClick={() =>
            applyEditorAction((activeEditor) => activeEditor.chain().toggleBlockquote().run())
          }
        >
          <Quote size={16} />
        </IconButton>
        <span className="toolbar-separator" />
        <IconButton
          label="撤销"
          onClick={() => applyEditorAction((activeEditor) => activeEditor.chain().undo().run())}
          disabled={Boolean(busy) || !editor?.can().undo()}
        >
          <Undo2 size={16} />
        </IconButton>
        <IconButton
          label="重做"
          onClick={() => applyEditorAction((activeEditor) => activeEditor.chain().redo().run())}
          disabled={Boolean(busy) || !editor?.can().redo()}
        >
          <Redo2 size={16} />
        </IconButton>
      </div>
      {error && !closeRequested && (
        <div className="compose-error">
          <ErrorPanel message={error} />
        </div>
      )}
      <ConfirmDialogFrame
        open={closeRequested}
        onOpenChange={(next) => {
          if (!next) continueEditing()
        }}
        title="还有未保存的内容"
        description="保存为草稿后可以继续编辑，放弃会丢失这次未保存的修改。"
        icon={<FileText size={20} aria-hidden="true" />}
        busy={Boolean(busy)}
        initialFocusRef={continueButton}
        footer={
          <>
            <Button
              unstyled
              type="button"
              ref={continueButton}
              className="button"
              disabled={Boolean(busy)}
              onClick={continueEditing}
            >
              继续编辑
            </Button>
            <Button
              unstyled
              type="button"
              className="button confirm-dialog-destructive"
              disabled={Boolean(busy)}
              onClick={discard}
            >
              放弃
            </Button>
            <Button
              unstyled
              type="button"
              className="button primary"
              disabled={Boolean(busy) || !account}
              onClick={() => void save()}
            >
              {busy === 'save' && <Spinner size={12} />}保存并关闭
            </Button>
          </>
        }
      >
        {error && <ErrorPanel message={error} />}
      </ConfirmDialogFrame>
      <div className="compose-footer">
        <div className="button-row">
          <Button
            unstyled
            className="button primary"
            disabled={Boolean(busy) || !account || ![to, cc, bcc].some((value) => value.trim())}
            onClick={() => void send()}
          >
            {busy === 'send' ? <Spinner /> : <Send size={15} />}发送邮件
          </Button>
          <Button
            unstyled
            className="button attachment-button"
            disabled={Boolean(busy) || attachments.length >= MAX_DRAFT_ATTACHMENTS}
            onClick={() => void pick()}
          >
            {busy === 'pick' ? <Spinner /> : <Paperclip size={16} />}附件
          </Button>
        </div>
        <Button
          unstyled
          className="text-button save-draft"
          disabled={Boolean(busy) || !account}
          onClick={() => void save()}
        >
          {busy === 'save' ? <Spinner /> : <FileText size={15} />}保存草稿
        </Button>
      </div>
    </Modal>
  )
}
