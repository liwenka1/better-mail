'use client'

import * as React from 'react'
import { cn } from '../../lib/utils'
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog'

import { Button } from './button'

type Unstyled = { unstyled?: boolean }
function uiClass(unstyled: boolean, ...classes: Parameters<typeof cn>) {
  return unstyled ? cn(classes.at(-1)) : cn(...classes)
}

function AlertDialog({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
}

function AlertDialogTrigger({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
}

function AlertDialogPortal({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
}

function AlertDialogOverlay({
  className,
  unstyled = false,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay> & Unstyled) {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={uiClass(
        unstyled,
        'fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0',
        className
      )}
      {...props}
    />
  )
}

function AlertDialogContent({
  className,
  unstyled = false,
  size = 'default',
  overlayClassName,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content> &
  Unstyled & {
    size?: 'default' | 'sm'
    overlayClassName?: string
  }) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay unstyled={unstyled} className={overlayClassName} />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        data-size={size}
        className={uiClass(
          unstyled,
          'group/alert-dialog-content fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border bg-background p-6 shadow-lg duration-200 data-[size=sm]:max-w-xs data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[size=default]:sm:max-w-lg',
          className
        )}
        {...props}
      />
    </AlertDialogPortal>
  )
}

function AlertDialogHeader({
  className,
  unstyled = false,
  ...props
}: React.ComponentProps<'div'> & Unstyled) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={uiClass(
        unstyled,
        'grid grid-rows-[auto_1fr] place-items-center gap-1.5 text-center has-data-[slot=alert-dialog-media]:grid-rows-[auto_auto_1fr] has-data-[slot=alert-dialog-media]:gap-x-6 sm:group-data-[size=default]/alert-dialog-content:place-items-start sm:group-data-[size=default]/alert-dialog-content:text-left sm:group-data-[size=default]/alert-dialog-content:has-data-[slot=alert-dialog-media]:grid-rows-[auto_1fr]',
        className
      )}
      {...props}
    />
  )
}

function AlertDialogFooter({
  className,
  unstyled = false,
  ...props
}: React.ComponentProps<'div'> & Unstyled) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={uiClass(
        unstyled,
        'flex flex-col-reverse gap-2 group-data-[size=sm]/alert-dialog-content:grid group-data-[size=sm]/alert-dialog-content:grid-cols-2 sm:flex-row sm:justify-end',
        className
      )}
      {...props}
    />
  )
}

function AlertDialogTitle({
  className,
  unstyled = false,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title> & Unstyled) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={uiClass(
        unstyled,
        'text-lg font-semibold sm:group-data-[size=default]/alert-dialog-content:group-has-data-[slot=alert-dialog-media]/alert-dialog-content:col-start-2',
        className
      )}
      {...props}
    />
  )
}

function AlertDialogDescription({
  className,
  unstyled = false,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description> & Unstyled) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={uiClass(unstyled, 'text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

function AlertDialogMedia({
  className,
  unstyled = false,
  ...props
}: React.ComponentProps<'div'> & Unstyled) {
  return (
    <div
      data-slot="alert-dialog-media"
      className={uiClass(
        unstyled,
        "mb-2 inline-flex size-16 items-center justify-center rounded-md bg-muted sm:group-data-[size=default]/alert-dialog-content:row-span-2 *:[svg:not([class*='size-'])]:size-8",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogAction({
  className,
  unstyled = false,
  variant = 'default',
  size = 'default',
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action> &
  Unstyled &
  Pick<React.ComponentProps<typeof Button>, 'variant' | 'size'>) {
  if (unstyled)
    return (
      <AlertDialogPrimitive.Action
        data-slot="alert-dialog-action"
        className={className}
        {...props}
      />
    )
  return (
    <Button variant={variant} size={size} asChild>
      <AlertDialogPrimitive.Action
        data-slot="alert-dialog-action"
        className={uiClass(unstyled, className)}
        {...props}
      />
    </Button>
  )
}

function AlertDialogCancel({
  className,
  unstyled = false,
  variant = 'outline',
  size = 'default',
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel> &
  Unstyled &
  Pick<React.ComponentProps<typeof Button>, 'variant' | 'size'>) {
  if (unstyled)
    return (
      <AlertDialogPrimitive.Cancel
        data-slot="alert-dialog-cancel"
        className={className}
        {...props}
      />
    )
  return (
    <Button variant={variant} size={size} asChild>
      <AlertDialogPrimitive.Cancel
        data-slot="alert-dialog-cancel"
        className={uiClass(unstyled, className)}
        {...props}
      />
    </Button>
  )
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger
}
