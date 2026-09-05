import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import {
  CLI_RUNTIME_SELECTOR_ROWS,
  type CliRuntimeDescriptor,
  type CliRuntimeId,
  type CliRuntimeSelectorRow,
  getCliRuntimeDescriptor,
  isCliRuntimeAvailable,
} from '../../core/cli-runtime'
import { getNodeWindow } from '../../utils/dom/window-context'
import { YoloDropdownContent } from '../common/popover'

/**
 * The picker's rows — variants fold into the row of the runtime they fork
 * (see `CLI_RUNTIME_SELECTOR_ROWS`). Folding is presentation only: every
 * runtime, variants included, stays independently selectable.
 */
export const getRuntimeSelectorRows = (
  cliRuntimeAvailable: boolean,
): readonly CliRuntimeSelectorRow[] =>
  cliRuntimeAvailable ? CLI_RUNTIME_SELECTOR_ROWS : NO_ROWS

export type RuntimeSelectorRowState = Readonly<{
  /** Checked while *any* member of the family is the current runtime. */
  isSelected: boolean
  /** What clicking the row body selects — the member its switches show. */
  rowTargetId: CliRuntimeId
  variants: readonly Readonly<{
    descriptor: CliRuntimeDescriptor
    /** The switch is on only while this exact variant is the current runtime. */
    isActive: boolean
    /** What flipping the switch selects: on → the variant, off → the family base. */
    toggleTargetId: CliRuntimeId
  }>[]
}>

/**
 * How one collapsed row reads against the current runtime. A variant is never
 * remembered: when the current runtime is outside this family every switch is
 * off, so the row body falls back to the base runtime.
 */
export const resolveRuntimeSelectorRowState = (
  row: CliRuntimeSelectorRow,
  currentRuntimeId: CliRuntimeId,
): RuntimeSelectorRowState => {
  const variants = row.variants.map((descriptor) => {
    const isActive = descriptor.id === currentRuntimeId
    return {
      descriptor,
      isActive,
      toggleTargetId: isActive ? row.primary.id : descriptor.id,
    }
  })
  const activeVariant = variants.find((variant) => variant.isActive)
  return {
    isSelected:
      row.primary.id === currentRuntimeId || activeVariant !== undefined,
    rowTargetId: activeVariant?.descriptor.id ?? row.primary.id,
    variants,
  }
}

/**
 * Arrow-key navigation addresses every focusable element in the list: one key
 * per row, plus one per variant switch, so a row and its switches never
 * collide.
 */
type NavKey = CliRuntimeId | `variant:${CliRuntimeId}`
const variantNavKey = (id: CliRuntimeId): NavKey => `variant:${id}`

const NO_ROWS: readonly CliRuntimeSelectorRow[] = []

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
  const itemRefs = useRef<Partial<Record<NavKey, HTMLElement | null>>>({})

  const rows = getRuntimeSelectorRows(cliRuntimeAvailable)
  const navOrder = useMemo(() => {
    const keys: NavKey[] = []
    for (const row of rows) {
      keys.push(row.primary.id)
      for (const variant of row.variants) {
        keys.push(variantNavKey(variant.id))
      }
    }
    return keys
  }, [rows])

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

  const currentOption = getCliRuntimeDescriptor(currentRuntimeId)
  const selectedRow = rows.find(
    (row) =>
      row.primary.id === currentRuntimeId ||
      row.variants.some((variant) => variant.id === currentRuntimeId),
  )
  const currentLabel = t(currentOption.labelKey, currentOption.defaultLabel)
  const accessibleLabel = t('sidebar.runtimeSelector.accessibleLabel').replace(
    '{runtime}',
    currentLabel,
  )

  const selectRuntime = (runtimeId: CliRuntimeId) => {
    setIsOpen(false)
    if (runtimeId !== currentRuntimeId) {
      onRuntimeChange(runtimeId)
    }
  }

  /**
   * A variant switch changes the runtime like any other pick, but leaves the
   * menu open so its own state — and the check moving onto this row — is
   * visible right where it was flipped. Same contract as the mode picker's
   * YOLO switches (`ChatModeSelect`).
   */
  const switchVariant = (runtimeId: CliRuntimeId) => {
    if (runtimeId !== currentRuntimeId) {
      onRuntimeChange(runtimeId)
    }
  }

  const focusNavItem = (key: NavKey | undefined) => {
    const target = key ? itemRefs.current[key] : null
    if (!target) return
    target.focus({ preventScroll: true })
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  // The rows are plain elements rather than Radix items (a Radix item swallows
  // Enter/Space and blocks Tab, so a switch nested in one is unreachable by
  // keyboard), so arrow-key movement is ours to drive.
  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    event.stopPropagation()
    const ownerWindow = getNodeWindow(triggerRef.current)
    const activeElement = ownerWindow.document.activeElement
    const currentIndex = navOrder.findIndex(
      (key) => itemRefs.current[key] === activeElement,
    )
    if (currentIndex < 0) {
      // Entering the list: land on the row that owns the current runtime —
      // for a variant that is the row it folded into, not a row of its own.
      focusNavItem(selectedRow?.primary.id ?? navOrder[0])
      return
    }
    const delta = event.key === 'ArrowDown' ? 1 : -1
    focusNavItem(
      navOrder[(currentIndex + delta + navOrder.length) % navOrder.length],
    )
  }

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
        onKeyDown={handleMenuKeyDown}
        onMouseEnter={clearHoverCloseTimeout}
        onMouseLeave={closeMenuWithDelay}
        onFocusOutside={(event) => {
          // Switching runtime rebuilds the conversation, and the fresh chat
          // input autofocuses — a focus move the dismissable layer would
          // otherwise read as "the user left" and close on, taking the menu
          // down the instant a variant switch is flipped inside it. Pointer
          // outside, Escape, and mouse-leave still close it.
          event.preventDefault()
        }}
      >
        <DropdownMenu.Label id={menuLabelId} className="yolo-sr-only">
          {t('sidebar.runtimeSelector.menuLabel')}
        </DropdownMenu.Label>
        <div
          className="yolo-model-select-list yolo-runtime-selector__list"
          role="group"
          aria-labelledby={menuLabelId}
        >
          {rows.map((row) => {
            // A row stands for a runtime family. Its switches say which member
            // is in play, and the row body follows them.
            const { isSelected, rowTargetId, variants } =
              resolveRuntimeSelectorRowState(row, currentRuntimeId)
            return (
              <div
                key={row.primary.id}
                role="menuitemradio"
                tabIndex={0}
                aria-checked={isSelected}
                className="yolo-popover-item yolo-runtime-selector__option"
                data-runtime-id={rowTargetId}
                data-state={isSelected ? 'checked' : 'unchecked'}
                ref={(element) => {
                  itemRefs.current[row.primary.id] = element
                }}
                onClick={() => selectRuntime(rowTargetId)}
                onKeyDown={(event) => {
                  // Enter/Space on a nested switch bubbles up here; a switch
                  // must not double as "pick this row".
                  if (event.target !== event.currentTarget) return
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    selectRuntime(rowTargetId)
                  }
                }}
              >
                <span
                  className="yolo-runtime-selector__option-icon"
                  aria-hidden="true"
                >
                  <RuntimeIcon runtimeId={row.primary.id} />
                </span>
                <span className="yolo-runtime-selector__option-copy">
                  <span className="yolo-runtime-selector__option-title-row">
                    <span className="yolo-runtime-selector__option-label">
                      {t(row.primary.labelKey, row.primary.defaultLabel)}
                    </span>
                    {variants.map(
                      ({ descriptor, isActive, toggleTargetId }) => {
                        const variantLabel = t(
                          descriptor.labelKey,
                          descriptor.defaultLabel,
                        )
                        const toggleHint = t(
                          'sidebar.runtimeSelector.variantToggleHint',
                        )
                          .replace(
                            '{base}',
                            t(row.primary.labelKey, row.primary.defaultLabel),
                          )
                          .replace('{variant}', variantLabel)
                        return (
                          <button
                            key={descriptor.id}
                            type="button"
                            role="switch"
                            aria-checked={isActive}
                            data-active={isActive}
                            data-runtime-id={descriptor.id}
                            title={toggleHint}
                            className="yolo-runtime-selector__variant-toggle"
                            ref={(element) => {
                              itemRefs.current[variantNavKey(descriptor.id)] =
                                element
                            }}
                            onClick={(event) => {
                              event.stopPropagation()
                              switchVariant(toggleTargetId)
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== 'Enter' && event.key !== ' ')
                                return
                              event.preventDefault()
                              event.stopPropagation()
                              switchVariant(toggleTargetId)
                            }}
                          >
                            <span className="yolo-runtime-selector__variant-toggle-label">
                              {variantLabel}
                            </span>
                            <span
                              className="yolo-runtime-selector__variant-toggle-switch"
                              aria-hidden="true"
                            >
                              <span className="yolo-runtime-selector__variant-toggle-thumb" />
                            </span>
                          </button>
                        )
                      },
                    )}
                  </span>
                  {/* The check rides the description line rather than the row,
                      so it sits directly under the variant switches instead of
                      pushing them in off the row's right edge. */}
                  <span className="yolo-runtime-selector__option-description-row">
                    <span className="yolo-runtime-selector__option-description">
                      {t(row.primary.descriptionKey)}
                    </span>
                    <span className="yolo-popover-item__indicator">
                      <Check size={12} aria-hidden="true" />
                    </span>
                  </span>
                </span>
              </div>
            )
          })}
        </div>
      </YoloDropdownContent>
    </DropdownMenu.Root>
  )
}
