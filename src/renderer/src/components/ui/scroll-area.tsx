import * as React from 'react'
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area'
import { cn } from '../../lib/utils'
import './scroll-area.css'

type ScrollAreaProps = React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  viewportRef?: React.Ref<HTMLDivElement>
  viewportClassName?: string
  viewportProps?: Omit<
    React.ComponentProps<typeof ScrollAreaPrimitive.Viewport>,
    'children' | 'ref' | 'className' | 'disableImplicitContentElement'
  >
  contentClassName?: string
  horizontal?: boolean
}

function ScrollArea({
  className,
  children,
  viewportRef,
  viewportClassName,
  viewportProps,
  contentClassName,
  horizontal = false,
  type = 'scroll',
  scrollHideDelay = 800,
  ...props
}: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn('app-scroll-area', className)}
      type={type}
      scrollHideDelay={scrollHideDelay}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        role="region"
        tabIndex={0}
        {...viewportProps}
        ref={viewportRef}
        className={cn('app-scroll-area-viewport', viewportClassName)}
        disableImplicitContentElement
      >
        <ScrollAreaPrimitive.Content
          data-slot="scroll-area-content"
          className={cn('app-scroll-area-content', contentClassName)}
          style={{ display: 'block', minWidth: 0, width: '100%' }}
        >
          {children}
        </ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      {horizontal && <ScrollBar orientation="horizontal" />}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Scrollbar>) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn('app-scroll-area-scrollbar', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb data-slot="scroll-area-thumb" className="app-scroll-area-thumb" />
    </ScrollAreaPrimitive.Scrollbar>
  )
}

export { ScrollArea, ScrollBar }
export type { ScrollAreaProps }
