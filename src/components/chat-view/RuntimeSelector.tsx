import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import {
  CLI_RUNTIME_DESCRIPTORS,
  type CliRuntimeDescriptor,
  type CliRuntimeId,
  getCliRuntimeDescriptor,
  isCliRuntimeAvailable,
} from '../../core/cli-runtime'
import { YoloDropdownContent } from '../common/popover'

export type RuntimeSelectorOption = CliRuntimeDescriptor

export const getRuntimeSelectorOptions = (
  cliRuntimeAvailable: boolean,
): readonly RuntimeSelectorOption[] =>
  cliRuntimeAvailable ? CLI_RUNTIME_DESCRIPTORS : []

export const resolveAvailableRuntimeId = (
  value: string,
  cliRuntimeAvailable: boolean,
): CliRuntimeId | undefined =>
  getRuntimeSelectorOptions(cliRuntimeAvailable).find(
    (option) => option.id === value,
  )?.id

export type RuntimeSelectorProps = {
  currentRuntimeId: CliRuntimeId
  onRuntimeChange: (runtimeId: CliRuntimeId) => void
  disabled?: boolean
  className?: string
}

const RuntimeIcon = ({ runtimeId }: { runtimeId: CliRuntimeId }) => {
  const logo = getCliRuntimeDescriptor(runtimeId).icon
  return (
    <img
      className="yolo-runtime-selector__provider-logo"
      src={logo.src}
      alt=""
      draggable={false}
      data-provider={logo.provider}
    />
  )
}

export function RuntimeSelector({
  currentRuntimeId,
  onRuntimeChange,
  disabled = false,
  className,
}: RuntimeSelectorProps) {
  const { t } = useLanguage()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const expandedWidthRef = useRef(0)
  const [isCompact, setIsCompact] = useState(false)
  const [isOpen, setIsOpen] = useState(false)
  const menuLabelId = useId()
  const cliRuntimeAvailable = isCliRuntimeAvailable()
  const hoverCloseTimeoutRef = useRef<number | null>(null)

  const clearHoverCloseTimeout = () => {
    if (hoverCloseTimeoutRef.current !== null) {
      window.clearTimeout(hoverCloseTimeoutRef.current)
      hoverCloseTimeoutRef.current = null
    }
  }

  const closeMenuWithDelay = () => {
    clearHoverCloseTimeout()
    hoverCloseTimeoutRef.current = window.setTimeout(() => {
      setIsOpen(false)
      hoverCloseTimeoutRef.current = null
    }, 150)
  }

  useEffect(() => {
    return () => {
      if (hoverCloseTimeoutRef.current !== null) {
        window.clearTimeout(hoverCloseTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    setIsCompact(false)
  }, [currentRuntimeId])

  useEffect(() => {
    const trigger = triggerRef.current
    if (!trigger || isCompact || typeof ResizeObserver === 'undefined') return

    const updateCompactState = () => {
      const label = trigger.querySelector<HTMLElement>(
        '.yolo-runtime-selector__label',
      )
      const icon = trigger.querySelector<HTMLElement>(
        '.yolo-runtime-selector__icon',
      )
      const chevron = trigger.querySelector<HTMLElement>(
        '.yolo-runtime-selector__chevron',
      )
      if (!label || !icon || !chevron) return

      const style = getComputedStyle(trigger)
      const gap = Number.parseFloat(style.gap) || 0
      const requiredContentWidth =
        icon.getBoundingClientRect().width +
        label.scrollWidth +
        chevron.getBoundingClientRect().width +
        gap * 2 +
        (Number.parseFloat(style.paddingInlineStart) || 0) +
        (Number.parseFloat(style.paddingInlineEnd) || 0)
      expandedWidthRef.current =
        requiredContentWidth +
        (Number.parseFloat(style.borderInlineStartWidth) || 0) +
        (Number.parseFloat(style.borderInlineEndWidth) || 0)

      if (trigger.clientWidth < requiredContentWidth) {
        setIsCompact(true)
      }
    }

    updateCompactState()
    const resizeObserver = new ResizeObserver(updateCompactState)
    resizeObserver.observe(trigger)
    return () => resizeObserver.disconnect()
  }, [isCompact])

  useEffect(() => {
    const trigger = triggerRef.current
    const header = trigger?.closest('.yolo-chat-header')
    const headerLeft = trigger?.closest('.yolo-chat-header-left')
    const headerRight = header?.querySelector<HTMLElement>(
      '.yolo-chat-header-right',
    )
    if (
      !header ||
      !headerLeft ||
      !isCompact ||
      typeof ResizeObserver === 'undefined'
    )
      return

    const runtimeTrigger = trigger!
    const resizeObserver = new ResizeObserver(() => {
      const headerStyle = getComputedStyle(header)
      const headerGap = Number.parseFloat(headerStyle.gap) || 0
      const availableLeftWidth =
        header.clientWidth -
        (headerRight?.getBoundingClientRect().width ?? 0) -
        headerGap
      const requiredLeftWidth =
        headerLeft.getBoundingClientRect().width -
        runtimeTrigger.getBoundingClientRect().width +
        expandedWidthRef.current

      if (requiredLeftWidth <= availableLeftWidth) {
        setIsCompact(false)
      }
    })
    resizeObserver.observe(header)
    return () => resizeObserver.disconnect()
  }, [isCompact])

  if (!cliRuntimeAvailable) {
    return null
  }

  const availableOptions = getRuntimeSelectorOptions(cliRuntimeAvailable)
  const currentOption = getCliRuntimeDescriptor(currentRuntimeId)
  const currentLabel = t(currentOption.labelKey)
  const accessibleLabel = t('sidebar.runtimeSelector.accessibleLabel').replace(
    '{runtime}',
    currentLabel,
  )

  return (
    <DropdownMenu.Root
      modal={false}
      open={isOpen}
      onOpenChange={(open) => {
        clearHoverCloseTimeout()
        setIsOpen(open)
      }}
    >
      <DropdownMenu.Trigger
        ref={triggerRef}
        type="button"
        className={`yolo-runtime-selector${className ? ` ${className}` : ''}`}
        disabled={disabled}
        aria-label={accessibleLabel}
        data-runtime-id={currentRuntimeId}
        data-compact={isCompact || undefined}
        onMouseEnter={() => {
          if (disabled) return
          clearHoverCloseTimeout()
          setIsOpen(true)
        }}
        onMouseLeave={closeMenuWithDelay}
      >
        <span className="yolo-runtime-selector__icon" aria-hidden="true">
          <RuntimeIcon runtimeId={currentOption.id} />
        </span>
        <span className="yolo-runtime-selector__label">{currentLabel}</span>
        <ChevronDown
          className="yolo-runtime-selector__chevron"
          size={13}
          strokeWidth={2.2}
          aria-hidden="true"
        />
      </DropdownMenu.Trigger>

      <YoloDropdownContent
        anchorRef={triggerRef}
        variant="default"
        minWidth={224}
        maxWidth={280}
        maxHeight={320}
        className="yolo-runtime-selector__content"
        side="bottom"
        sideOffset={6}
        align="start"
        collisionPadding={8}
        loop
        onMouseEnter={clearHoverCloseTimeout}
        onMouseLeave={closeMenuWithDelay}
      >
        <DropdownMenu.Label id={menuLabelId} className="yolo-sr-only">
          {t('sidebar.runtimeSelector.menuLabel')}
        </DropdownMenu.Label>
        <DropdownMenu.RadioGroup
          className="yolo-model-select-list yolo-runtime-selector__list"
          value={currentRuntimeId}
          aria-labelledby={menuLabelId}
          onValueChange={(value) => {
            const runtimeId = resolveAvailableRuntimeId(
              value,
              cliRuntimeAvailable,
            )
            if (runtimeId && runtimeId !== currentRuntimeId) {
              onRuntimeChange(runtimeId)
            }
          }}
        >
          {availableOptions.map((option) => {
            return (
              <DropdownMenu.RadioItem
                key={option.id}
                value={option.id}
                className="yolo-popover-item yolo-runtime-selector__option"
                data-runtime-id={option.id}
              >
                <span
                  className="yolo-runtime-selector__option-icon"
                  aria-hidden="true"
                >
                  <RuntimeIcon runtimeId={option.id} />
                </span>
                <span className="yolo-runtime-selector__option-copy">
                  <span className="yolo-runtime-selector__option-label">
                    {t(option.labelKey)}
                  </span>
                  <span className="yolo-runtime-selector__option-description">
                    {t(option.descriptionKey)}
                  </span>
                </span>
                <DropdownMenu.ItemIndicator className="yolo-popover-item__indicator">
                  <Check size={12} aria-hidden="true" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            )
          })}
        </DropdownMenu.RadioGroup>
      </YoloDropdownContent>
    </DropdownMenu.Root>
  )
}
