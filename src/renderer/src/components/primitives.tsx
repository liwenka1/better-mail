import type { ComponentProps, ReactNode, RefObject } from 'react'
import { LoaderCircle, X } from 'lucide-react'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { Checkbox } from './ui/checkbox'
import { Button } from './ui/button'
import { Label } from './ui/label'
import { TooltipHint } from './Tooltip'

export function IconButton({
  label,
  children,
  className = '',
  ...props
}: ComponentProps<'button'> & { label: string; children: ReactNode }) {
  return (
    <TooltipHint content={label}>
      <Button
        unstyled
        type="button"
        className={`icon-button ${className}`}
        aria-label={label}
        disabled={props.disabled}
        {...props}
      >
        {children}
      </Button>
    </TooltipHint>
  )
}
export function Spinner({ size = 16 }: { size?: number }) {
  return <LoaderCircle size={size} className="spin" aria-label="加载中" />
}
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  className = '',
  closeDisabled = false,
  initialFocusRef,
  returnFocusRef
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: ReactNode
  className?: string
  closeDisabled?: boolean
  initialFocusRef?: RefObject<HTMLElement | null>
  returnFocusRef?: RefObject<HTMLElement | null>
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!closeDisabled || nextOpen) onOpenChange(nextOpen)
      }}
    >
      <DialogContent
        unstyled
        showCloseButton={false}
        overlayClassName="modal-overlay"
        className={`modal-content ${className}`}
        aria-busy={closeDisabled || undefined}
        onEscapeKeyDown={(event) => {
          if (closeDisabled) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (closeDisabled) event.preventDefault()
        }}
        onOpenAutoFocus={(event) => {
          if (initialFocusRef?.current) {
            event.preventDefault()
            initialFocusRef.current.focus({ preventScroll: true })
          } else if (className.includes('compose')) event.preventDefault()
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocusRef?.current?.isConnected) {
            event.preventDefault()
            returnFocusRef.current.focus({ preventScroll: true })
          }
        }}
      >
        <div className="modal-title-row">
          <div>
            <DialogTitle unstyled>{title}</DialogTitle>
            <DialogDescription unstyled className={description ? 'modal-description' : 'sr-only'}>
              {description || title}
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <IconButton label="关闭窗口" disabled={closeDisabled}>
              <X size={19} />
            </IconButton>
          </DialogClose>
        </div>
        {children}
      </DialogContent>
    </Dialog>
  )
}
export function CheckboxField({
  id,
  checked,
  onCheckedChange,
  disabled = false,
  children
}: {
  id?: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <Label unstyled className="checkbox-field" data-disabled={disabled || undefined}>
      <Checkbox
        unstyled
        id={id}
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        disabled={disabled}
        className="checkbox-control"
        indicatorClassName="checkbox-indicator"
      />
      <span>{children}</span>
    </Label>
  )
}
export function ErrorPanel({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div role="alert" className="error-panel">
      <span>{message}</span>
      {retry && (
        <Button unstyled className="text-button" onClick={retry}>
          重试
        </Button>
      )}
    </div>
  )
}
