import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown } from 'lucide-react'
import type { CSSProperties } from 'react'
import React, { ReactNode, useEffect, useMemo, useRef, useState } from 'react'

import { getNodeBody, getNodeWindow } from '../../utils/dom/window-context'

import { YoloDropdownContent, YoloPopoverVariant } from './popover'

export type RollerOption = {
  value: string
  label: string
  description?: string
  icon?: ReactNode
}

export type RollerSelectPopoverProps = {
  variant?: YoloPopoverVariant
  minWidth?: number | string
  maxWidth?: number | string
  maxHeight?: number | string
  /** Extra class for consumer-specific concerns. */
  className?: string
}

type RollerSelectProps = {
  value: string
  options: RollerOption[]
  onChange: (value: string) => void
  onActivate?: () => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
  disabled?: boolean
  triggerClassName?: string
  /** Popover surface variant + sizing. */
  popover?: RollerSelectPopoverProps
  /** Inline style override for the popover content (e.g. runtime-computed width). */
  contentStyle?: CSSProperties
  ariaLabel?: string
  sideOffset?: number
  onTriggerMouseEnter?: () => void
  onTriggerMouseLeave?: () => void
  onContentMouseEnter?: () => void
  onContentMouseLeave?: () => void
}

const ROLL_DURATION_MS = 260

const RollerSelect: React.FC<RollerSelectProps> = ({
  value,
  options,
  onChange,
  onActivate,
  open,
  onOpenChange,
  disabled = false,
  triggerClassName,
  popover,
  contentStyle,
  ariaLabel,
  sideOffset = 8,
  onTriggerMouseEnter,
  onTriggerMouseLeave,
  onContentMouseEnter,
  onContentMouseLeave,
}) => {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const isOpen = open ?? uncontrolledOpen
  const currentOption = useMemo(() => {
    return options.find((option) => option.value === value) ?? options[0]
  }, [options, value])

  const [visibleValue, setVisibleValue] = useState<string | undefined>(
    currentOption?.value,
  )
  const [incomingValue, setIncomingValue] = useState<string | null>(null)
  const timeoutRef = useRef<number | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const ownerWindow = getNodeWindow(triggerRef.current)
    return () => {
      if (timeoutRef.current !== null) {
        ownerWindow.clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!currentOption) return
    if (!visibleValue || visibleValue === currentOption.value) {
      setVisibleValue(currentOption.value)
      return
    }

    setIncomingValue(currentOption.value)
    const ownerWindow = getNodeWindow(triggerRef.current)
    if (timeoutRef.current !== null) {
      ownerWindow.clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    timeoutRef.current = ownerWindow.setTimeout(() => {
      setVisibleValue(currentOption.value)
      setIncomingValue(null)
      timeoutRef.current = null
    }, ROLL_DURATION_MS)
  }, [currentOption, visibleValue])

  if (!currentOption) return null

  const visibleOption =
    options.find((option) => option.value === visibleValue) ?? currentOption
  const incomingOption = incomingValue
    ? (options.find((option) => option.value === incomingValue) ?? null)
    : null
  const isRolling = incomingOption !== null

  const handleOpenChange = (nextOpen: boolean) => {
    if (open === undefined) {
      setUncontrolledOpen(nextOpen)
    }
    onOpenChange?.(nextOpen)
  }

  return (
    <DropdownMenu.Root
      modal={false}
      open={isOpen}
      onOpenChange={handleOpenChange}
    >
      <DropdownMenu.Trigger
        ref={triggerRef}
        className={
          triggerClassName
            ? `smtcmp-roller-select-trigger ${triggerClassName}${isOpen ? ' is-open' : ''}`
            : `smtcmp-roller-select-trigger${isOpen ? ' is-open' : ''}`
        }
        aria-label={ariaLabel}
        onClick={() => {
          onActivate?.()
        }}
        onMouseEnter={onTriggerMouseEnter}
        onMouseLeave={onTriggerMouseLeave}
        disabled={disabled}
      >
        <div className="smtcmp-roller-select-window" aria-hidden="true">
          <div
            className={`smtcmp-roller-select-track ${isRolling ? 'is-rolling' : ''}`}
          >
            <div className="smtcmp-roller-select-item">
              {visibleOption?.icon ? (
                <span className="smtcmp-view-toggle-button-icon">
                  {visibleOption.icon}
                </span>
              ) : null}
              <span className="smtcmp-view-toggle-button-label smtcmp-roller-select-item-label">
                {visibleOption?.label}
              </span>
            </div>
            {incomingOption ? (
              <div className="smtcmp-roller-select-item">
                {incomingOption.icon ? (
                  <span className="smtcmp-view-toggle-button-icon">
                    {incomingOption.icon}
                  </span>
                ) : null}
                <span className="smtcmp-view-toggle-button-label smtcmp-roller-select-item-label">
                  {incomingOption.label}
                </span>
              </div>
            ) : null}
          </div>
        </div>
        <span className="smtcmp-roller-select-caret" aria-hidden="true">
          <ChevronDown size={14} strokeWidth={2.4} />
        </span>
      </DropdownMenu.Trigger>

      <YoloDropdownContent
        container={getNodeBody(triggerRef.current)}
        variant={popover?.variant ?? 'default'}
        minWidth={popover?.minWidth}
        maxWidth={popover?.maxWidth}
        maxHeight={popover?.maxHeight}
        className={popover?.className}
        style={contentStyle}
        side="bottom"
        sideOffset={sideOffset}
        align="start"
        collisionPadding={8}
        onMouseEnter={onContentMouseEnter}
        onMouseLeave={onContentMouseLeave}
      >
        <DropdownMenu.RadioGroup
          className="smtcmp-model-select-list smtcmp-roller-select-list"
          value={value}
          onValueChange={(nextValue) => {
            if (!options.some((option) => option.value === nextValue)) {
              return
            }
            onChange(nextValue)
          }}
        >
          {options.map((option) => (
            <DropdownMenu.RadioItem
              key={option.value}
              value={option.value}
              className="smtcmp-popover-item smtcmp-roller-select-list-item"
            >
              {option.icon ? (
                <span className="smtcmp-roller-select-list-item-icon">
                  {option.icon}
                </span>
              ) : null}
              <span className="smtcmp-roller-select-list-item-content">
                <span className="smtcmp-roller-select-list-item-label">
                  {option.label}
                </span>
                {option.description ? (
                  <span className="smtcmp-roller-select-list-item-desc">
                    {option.description}
                  </span>
                ) : null}
              </span>
              <span
                className="smtcmp-roller-select-list-item-check"
                aria-hidden="true"
              >
                {value === option.value ? <Check size={12} /> : null}
              </span>
            </DropdownMenu.RadioItem>
          ))}
        </DropdownMenu.RadioGroup>
      </YoloDropdownContent>
    </DropdownMenu.Root>
  )
}

export default RollerSelect
