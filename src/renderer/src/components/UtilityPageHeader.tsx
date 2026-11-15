import type { ReactNode } from 'react'
import { cn } from '../lib/utils'
import '../utility-page.css'

export function UtilityPageHeader({
  title,
  description,
  count,
  actions,
  headingId,
  className
}: {
  title: string
  description?: string
  count?: number
  actions?: ReactNode
  headingId?: string
  className?: string
}) {
  return (
    <div className={cn('utility-page-header', className)}>
      <div>
        <h1 id={headingId}>
          {title}
          {count !== undefined && <small>{count}</small>}
        </h1>
        {description && <p>{description}</p>}
      </div>
      {actions}
    </div>
  )
}
