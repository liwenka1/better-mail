'use client'

import * as React from 'react'
import { cn } from '../../lib/utils'
import { CheckIcon } from 'lucide-react'
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'

type Unstyled = { unstyled?: boolean }
function uiClass(unstyled: boolean, ...classes: Parameters<typeof cn>) {
  return unstyled ? cn(classes.at(-1)) : cn(...classes)
}

function Checkbox({
  className,
  unstyled = false,
  indicatorClassName,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root> &
  Unstyled & { indicatorClassName?: string }) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={uiClass(
        unstyled,
        'peer size-4 shrink-0 rounded-[4px] border border-input shadow-xs transition-shadow outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:bg-input/30 dark:aria-invalid:ring-destructive/40 dark:data-[state=checked]:bg-primary',
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className={cn(
          !unstyled && 'grid place-content-center text-current transition-none',
          indicatorClassName
        )}
      >
        <CheckIcon
          className={unstyled ? undefined : 'size-3.5'}
          size={unstyled ? 12 : undefined}
          strokeWidth={unstyled ? 2.5 : undefined}
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
