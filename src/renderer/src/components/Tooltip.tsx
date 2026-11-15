import {
  cloneElement,
  type ComponentProps,
  type CSSProperties,
  type ReactElement,
  type ReactNode
} from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import '../tooltip.css'

export interface TooltipHintProps {
  content: ReactNode
  children: ReactElement
  side?: ComponentProps<typeof TooltipContent>['side']
  contentClassName?: string
  disabledWrapperStyle?: CSSProperties
}

function DisabledControlTrigger({
  children,
  'aria-describedby': description,
  ...props
}: Omit<ComponentProps<'span'>, 'children'> & { children: ReactElement }) {
  const child = children as ReactElement<{ 'aria-describedby'?: string }>
  const descriptions = [child.props['aria-describedby'], description].filter(Boolean).join(' ')
  return (
    <span {...props} aria-describedby={description}>
      {cloneElement(child, { 'aria-describedby': descriptions || undefined })}
    </span>
  )
}

/** The child keeps its accessible name and native interaction behavior. */
export function TooltipHint({
  content,
  children,
  side = 'top',
  contentClassName,
  disabledWrapperStyle
}: TooltipHintProps) {
  const props = children.props as { disabled?: boolean }
  const disabled = Boolean(props.disabled)
  // Keep the control mounted when a busy state toggles so captured focus refs stay valid.
  const canDisable = 'disabled' in props
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {canDisable ? (
          <DisabledControlTrigger
            className="tooltip-disabled-trigger"
            aria-disabled={disabled || undefined}
            style={disabledWrapperStyle}
          >
            {children}
          </DisabledControlTrigger>
        ) : (
          children
        )}
      </TooltipTrigger>
      <TooltipContent side={side} className={contentClassName}>
        {content}
      </TooltipContent>
    </Tooltip>
  )
}
