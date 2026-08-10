import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

export type SimpleSelectOption = {
  value: string
  label: string
  description?: string
}

export type SimpleSelectOptionGroup = {
  label: string
  options: SimpleSelectOption[]
}

type SimpleSelectProps = {
  value: string
  options?: SimpleSelectOption[]
  /** Pinned options rendered above grouped/flat options, as regular items. */
  leadingOptions?: SimpleSelectOption[]
  groupedOptions?: SimpleSelectOptionGroup[]
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
  options = [],
  leadingOptions = [],
  groupedOptions,
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
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const flattenedOptions = useMemo(() => {
    const baseOptions =
      groupedOptions && groupedOptions.length > 0
        ? groupedOptions.flatMap((group) => group.options)
        : options
    return [...leadingOptions, ...baseOptions]
  }, [groupedOptions, leadingOptions, options])
  const selected = useMemo(
    () => flattenedOptions.find((option) => option.value === value) ?? null,
    [flattenedOptions, value],
  )

  const renderOptionItem = (
    option: SimpleSelectOption,
    variant?: 'leading',
  ) => (
    <DropdownMenu.RadioItem
      key={option.value}
      className={
        variant === 'leading'
          ? 'yolo-simple-select__item yolo-simple-select__item--leading'
          : 'yolo-simple-select__item'
      }
      value={option.value}
    >
      <div className="yolo-simple-select__item-text">
        <div className="yolo-simple-select__item-label">{option.label}</div>
        {option.description ? (
          <div className="yolo-simple-select__item-desc">
            {option.description}
          </div>
        ) : null}
      </div>
      <DropdownMenu.ItemIndicator className="yolo-simple-select__item-indicator">
        <Check size={12} />
      </DropdownMenu.ItemIndicator>
    </DropdownMenu.RadioItem>
  )

  return (
    <DropdownMenu.Root open={isOpen} onOpenChange={(open) => setIsOpen(open)}>
      <DropdownMenu.Trigger
        ref={triggerRef}
        type="button"
        className="yolo-simple-select__trigger"
        disabled={disabled}
      >
        <div className="yolo-simple-select__label">
          {selected?.label ?? placeholder}
        </div>
        <div className="yolo-simple-select__icon">
          {isOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </div>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal
        container={triggerRef.current?.ownerDocument?.body ?? undefined}
      >
        <DropdownMenu.Content
          className={
            contentClassName
              ? `yolo-simple-select__content ${contentClassName}`
              : 'yolo-simple-select__content'
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
            className="yolo-simple-select__list"
            value={value}
            onValueChange={(nextValue) => {
              if (nextValue === value) return
              onChange(nextValue)
            }}
          >
            {leadingOptions.map((option) =>
              renderOptionItem(option, 'leading'),
            )}
            {(groupedOptions && groupedOptions.length > 0
              ? groupedOptions
              : [{ label: '', options }]
            ).flatMap((group, groupIndex) => {
              const items = group.options.map((option) =>
                renderOptionItem(option),
              )

              const label = group.label ? (
                <DropdownMenu.Label
                  key={`group-${groupIndex}`}
                  className="yolo-simple-select__group-label"
                >
                  {group.label}
                </DropdownMenu.Label>
              ) : null

              const totalGroups =
                groupedOptions && groupedOptions.length > 0
                  ? groupedOptions.length
                  : 1
              const separator =
                groupIndex < totalGroups - 1 ? (
                  <DropdownMenu.Separator
                    key={`sep-${groupIndex}`}
                    className="yolo-simple-select__group-separator"
                  />
                ) : null

              return [label, ...items, separator].filter(
                (node) => node !== null,
              )
            })}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
