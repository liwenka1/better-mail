import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle
} from './ui/alert-dialog'
import { Trash2 } from 'lucide-react'
import { errorMessage } from '../lib'
import { ErrorPanel, Spinner } from './primitives'
import { Button } from './ui/button'
import '../confirm-dialog.css'

export interface ConfirmDialogFrameProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  footer: ReactNode
  children?: ReactNode
  icon?: ReactNode
  busy?: boolean
  initialFocusRef?: RefObject<HTMLElement | null>
  returnFocusRef?: RefObject<HTMLElement | null>
}

/** One confirmation surface for destructive choices and guarded editor exits. */
export function ConfirmDialogFrame({
  open,
  onOpenChange,
  title,
  description,
  footer,
  children,
  icon = <Trash2 size={20} aria-hidden="true" />,
  busy = false,
  initialFocusRef,
  returnFocusRef
}: ConfirmDialogFrameProps) {
  const opener = useRef<HTMLElement | null>(null)
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!busy || next) onOpenChange(next)
      }}
    >
      <AlertDialogContent
        unstyled
        overlayClassName="confirm-dialog-overlay"
        className="confirm-dialog confirmation-content"
        aria-busy={busy || undefined}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
        }}
        onOpenAutoFocus={(event) => {
          opener.current =
            returnFocusRef?.current ||
            (document.activeElement instanceof HTMLElement ? document.activeElement : null)
          if (initialFocusRef?.current) {
            event.preventDefault()
            initialFocusRef.current.focus({ preventScroll: true })
          }
        }}
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef?.current || opener.current
          if (target?.isConnected) {
            event.preventDefault()
            target.focus({ preventScroll: true })
          }
        }}
      >
        <div className="confirm-dialog-icon" aria-hidden="true">
          {icon}
        </div>
        <AlertDialogTitle unstyled className="confirm-dialog-title">
          {title}
        </AlertDialogTitle>
        <AlertDialogDescription unstyled asChild>
          <div className="confirm-dialog-description">{description}</div>
        </AlertDialogDescription>
        {children}
        <div className="confirm-dialog-footer">{footer}</div>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export interface ConfirmDialogProps extends Omit<
  ConfirmDialogFrameProps,
  'footer' | 'children' | 'busy' | 'initialFocusRef'
> {
  onConfirm: () => void | Promise<void>
  onBusyChange?: (busy: boolean) => void
  confirmLabel?: string
  cancelLabel?: string
}

export function ConfirmDialog({
  onConfirm,
  onBusyChange,
  confirmLabel = '确认删除',
  cancelLabel = '取消',
  ...frame
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const running = useRef(false)
  const mounted = useRef(true)
  const cancel = useRef<HTMLButtonElement | null>(null)
  const busyListener = useRef(onBusyChange)
  busyListener.current = onBusyChange
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (running.current) busyListener.current?.(false)
    }
  }, [])
  useEffect(() => {
    if (frame.open) setError('')
  }, [frame.open])
  async function confirm() {
    if (running.current) return
    running.current = true
    setBusy(true)
    setError('')
    busyListener.current?.(true)
    try {
      await onConfirm()
      if (mounted.current) frame.onOpenChange(false)
    } catch (caught) {
      if (mounted.current) setError(errorMessage(caught))
    } finally {
      running.current = false
      if (mounted.current) {
        setBusy(false)
        busyListener.current?.(false)
      }
    }
  }
  return (
    <ConfirmDialogFrame
      {...frame}
      onOpenChange={(next) => {
        if (!running.current || next) frame.onOpenChange(next)
      }}
      busy={busy}
      initialFocusRef={cancel}
      footer={
        <>
          <AlertDialogCancel unstyled asChild>
            <Button unstyled type="button" className="button" ref={cancel} disabled={busy}>
              {cancelLabel}
            </Button>
          </AlertDialogCancel>
          <AlertDialogAction unstyled asChild>
            <Button
              unstyled
              type="button"
              className="button confirm-dialog-destructive"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault()
                void confirm()
              }}
            >
              {busy && <Spinner size={14} />}
              {confirmLabel}
            </Button>
          </AlertDialogAction>
        </>
      }
    >
      {error && <ErrorPanel message={error} />}
    </ConfirmDialogFrame>
  )
}
