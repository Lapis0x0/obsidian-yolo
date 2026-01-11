import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import { useMemo, useState } from 'react'

export type SimpleSelectOption = {
  value: string
  label: string
  description?: string
}

type SimpleSelectProps = {
  value: string
  options: SimpleSelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  placeholder?: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  alignOffset?: number
  collisionPadding?: number
  collisionBoundary?: Element | null
  contentClassName?: string
}

export function SimpleSelect({
  value,
  options,
  onChange,
  disabled = false,
  placeholder = 'Select',
  side = 'bottom',
  align = 'end',
  sideOffset = 6,
  alignOffset = 0,
  collisionPadding = 10,
  collisionBoundary,
  contentClassName,
}: SimpleSelectProps) {
  const [isOpen, setIsOpen] = useState(false)
  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value],
  )

  return (
    <DropdownMenu.Root
      open={isOpen}
      onOpenChange={(open) => setIsOpen(open)}
    >
      <DropdownMenu.Trigger
        className="smtcmp-simple-select__trigger"
        disabled={disabled}
      >
        <div className="smtcmp-simple-select__label">
          {selected?.label ?? placeholder}
        </div>
        <div className="smtcmp-simple-select__icon">
          {isOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </div>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={
            contentClassName
              ? `smtcmp-simple-select__content ${contentClassName}`
              : 'smtcmp-simple-select__content'
          }
          side={side}
          sideOffset={sideOffset}
          align={align}
          alignOffset={alignOffset}
          collisionPadding={collisionPadding}
          collisionBoundary={collisionBoundary ?? undefined}
          loop
          onCloseAutoFocus={(event) => {
            event.preventDefault()
          }}
        >
          <DropdownMenu.RadioGroup
            className="smtcmp-simple-select__list"
            value={value}
            onValueChange={(nextValue) => {
              if (nextValue === value) return
              onChange(nextValue)
            }}
          >
            {options.map((option) => (
              <DropdownMenu.RadioItem
                key={option.value}
                className="smtcmp-simple-select__item"
                value={option.value}
              >
                <div className="smtcmp-simple-select__item-text">
                  <div className="smtcmp-simple-select__item-label">
                    {option.label}
                  </div>
                  {option.description ? (
                    <div className="smtcmp-simple-select__item-desc">
                      {option.description}
                    </div>
                  ) : null}
                </div>
                <DropdownMenu.ItemIndicator className="smtcmp-simple-select__item-indicator">
                  <Check size={12} />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
