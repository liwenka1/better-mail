import type { ReactNode } from 'react'
import {
  Select as SelectRoot,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from './ui/select'

export interface SelectOption<Value extends string = string> {
  value: Value
  label: string
  content?: ReactNode
  disabled?: boolean
}

export interface SelectProps<Value extends string = string> {
  id?: string
  value: Value | ''
  onValueChange: (value: Value) => void
  options: readonly SelectOption<Value>[]
  ariaLabel: string
  placeholder?: string
  disabled?: boolean
  required?: boolean
  name?: string
  label?: string
  triggerClassName?: string
  contentClassName?: string
  renderValue?: (option: SelectOption<Value>) => ReactNode
}

/** A shared themed picker; Radix owns its keyboard, focus and dismissal behavior. */
export function Select<Value extends string = string>({
  id,
  value,
  onValueChange,
  options,
  ariaLabel,
  placeholder = '请选择',
  disabled = false,
  required = false,
  name,
  label,
  triggerClassName = '',
  contentClassName = '',
  renderValue
}: SelectProps<Value>) {
  const selected = options.find((option) => option.value === value)
  return (
    <SelectRoot
      value={selected?.value || ''}
      onValueChange={(nextValue) => {
        const option = options.find((item) => item.value === nextValue)
        if (option && !option.disabled) onValueChange(option.value)
      }}
      disabled={disabled || options.length === 0}
      required={required}
      name={name}
    >
      <SelectTrigger
        unstyled
        iconClassName="select-icon"
        id={id}
        aria-label={ariaLabel}
        className={`select-trigger ${triggerClassName}`.trim()}
      >
        <SelectValue className="select-value" placeholder={placeholder}>
          {selected ? renderValue?.(selected) || selected.content || selected.label : undefined}
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        unstyled
        viewportClassName="select-viewport"
        scrollButtonClassName="select-scroll-button"
        className={`select-content ${contentClassName}`.trim()}
        position="popper"
        sideOffset={6}
        align="start"
        collisionPadding={12}
        onEscapeKeyDown={(event) => event.stopPropagation()}
        style={{
          minWidth: 'var(--radix-select-trigger-width)',
          maxHeight: 'var(--radix-select-content-available-height)'
        }}
      >
        <SelectGroup>
          {label && (
            <SelectLabel unstyled className="select-label">
              {label}
            </SelectLabel>
          )}
          {options.map((option) => (
            <SelectItem
              unstyled
              key={option.value}
              value={option.value}
              disabled={option.disabled}
              textValue={option.label}
              className="select-item"
              indicatorClassName="select-item-indicator"
              textClassName="select-item-label"
            >
              {option.content || option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </SelectRoot>
  )
}
