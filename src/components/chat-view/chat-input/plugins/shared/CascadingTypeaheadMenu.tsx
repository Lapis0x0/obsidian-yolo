import {
  type MutableRefObject,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

import {
  type CustomKeyHandlers,
  type MenuOption,
  type MenuRenderFn,
} from './LexicalMenu'

const HOVER_OPEN_MS = 100
const HOVER_CLOSE_MS = 150
const SUBMENU_GAP_PX = 6
const SUBMENU_VIEWPORT_MARGIN_PX = 12
const DEFAULT_SUBMENU_MAX_WIDTH_PX = 480

type SubmenuSide = 'right' | 'left' | 'hidden'
type FocusSide = 'main' | 'sub'

export type CascadingTypeaheadItemProps<TOption extends MenuOption> = {
  id: string
  index: number
  isSelected: boolean
  onClick: () => void
  onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => void
  option: TOption
}

type RenderMenuProps<TOption extends MenuOption> = {
  anchorElementRef: MutableRefObject<HTMLElement | null>
  itemProps: Parameters<MenuRenderFn<TOption>>[1]
  mainListKey?: string
  mainListTransition?: string
  menuContainer?: HTMLElement | null
  onMainListAnimationEnd?: () => void
  renderItem: (props: CascadingTypeaheadItemProps<TOption>) => ReactNode
}

type CascadingTypeaheadConfig<
  TOption extends MenuOption,
  TEntry extends string,
> = {
  enabled: boolean
  getEntryKey: (option: TOption) => TEntry | null
  getSubOptions: (entry: TEntry) => TOption[]
  options: TOption[]
  placement: 'top' | 'bottom'
}

function SelectedIndexSync({
  selectedIndex,
  setSelectedIndex,
}: {
  selectedIndex: number | null
  setSelectedIndex: (index: number | null) => void
}): null {
  useLayoutEffect(() => {
    setSelectedIndex(selectedIndex)
  }, [selectedIndex, setSelectedIndex])
  return null
}

export function useCascadingTypeaheadMenu<
  TOption extends MenuOption,
  TEntry extends string,
>({
  enabled,
  getEntryKey,
  getSubOptions,
  options,
  placement,
}: CascadingTypeaheadConfig<TOption, TEntry>): {
  customKeyHandlers: CustomKeyHandlers
  renderMenu: (
    props: RenderMenuProps<TOption>,
  ) => ReturnType<MenuRenderFn<TOption>>
  reset: () => void
} {
  const [hoveredEntry, setHoveredEntry] = useState<TEntry | null>(null)
  const [focusSide, setFocusSide] = useState<FocusSide>('main')
  const [subHighlightedIndex, setSubHighlightedIndex] = useState(0)
  const [mainSelectedIndex, setMainSelectedIndex] = useState<number | null>(
    null,
  )
  const [subSide, setSubSide] = useState<SubmenuSide>('right')
  const [safeActive, setSafeActive] = useState(false)

  const closeTimerRef = useRef<number | null>(null)
  const openTimerRef = useRef<number | null>(null)
  const subPanelRef = useRef<HTMLDivElement | null>(null)
  const mainPanelRef = useRef<HTMLDivElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const anchorCursorPosRef = useRef<{ x: number; y: number } | null>(null)
  const lastCursorPosRef = useRef<{ x: number; y: number } | null>(null)
  const selectOptionRef = useRef<((option: TOption) => void) | null>(null)
  const setHighlightedIndexRef = useRef<((index: number) => void) | null>(null)
  const setActiveDescendantIdRef = useRef<((id: string | null) => void) | null>(
    null,
  )

  const getOwnerWindow = useCallback(
    () => mainPanelRef.current?.ownerDocument.defaultView ?? window,
    [],
  )

  const clearHoverTimers = useCallback(() => {
    const ownerWindow = getOwnerWindow()
    if (closeTimerRef.current !== null) {
      ownerWindow.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    if (openTimerRef.current !== null) {
      ownerWindow.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
  }, [getOwnerWindow])

  const reset = useCallback(() => {
    clearHoverTimers()
    setHoveredEntry(null)
    setFocusSide('main')
    setSubHighlightedIndex(0)
    setMainSelectedIndex(null)
    setSafeActive(false)
    anchorCursorPosRef.current = null
    lastCursorPosRef.current = null
    selectOptionRef.current = null
    setHighlightedIndexRef.current = null
    setActiveDescendantIdRef.current = null
  }, [clearHoverTimers])

  useEffect(() => {
    if (!enabled) reset()
  }, [enabled, reset])

  useEffect(() => reset, [reset])

  const previewEntry = useMemo(() => {
    if (!enabled) return null
    if (hoveredEntry !== null) return hoveredEntry
    if (mainSelectedIndex === null) return null
    const option = options[mainSelectedIndex]
    return option ? getEntryKey(option) : null
  }, [enabled, getEntryKey, hoveredEntry, mainSelectedIndex, options])

  const subOptions = useMemo(
    () => (previewEntry === null ? [] : getSubOptions(previewEntry)),
    [getSubOptions, previewEntry],
  )

  const subPanelActive =
    enabled &&
    previewEntry !== null &&
    subOptions.length > 0 &&
    subSide !== 'hidden'

  useEffect(() => {
    if (!subPanelActive && focusSide === 'sub') {
      setFocusSide('main')
    }
    if (subOptions.length === 0) {
      if (subHighlightedIndex !== 0) setSubHighlightedIndex(0)
    } else if (subHighlightedIndex >= subOptions.length) {
      setSubHighlightedIndex(0)
    }
  }, [focusSide, subHighlightedIndex, subOptions.length, subPanelActive])

  useEffect(() => {
    if (focusSide !== 'sub' || !subPanelActive) return
    const option = subOptions[subHighlightedIndex]
    const element = option?.ref?.current
    if (element && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'nearest' })
    }
  }, [focusSide, subHighlightedIndex, subOptions, subPanelActive])

  useEffect(() => {
    if (subPanelRef.current) subPanelRef.current.scrollTop = 0
  }, [previewEntry])

  useLayoutEffect(() => {
    if (!enabled || previewEntry === null || subOptions.length === 0) return
    const mainPanel = mainPanelRef.current
    if (!mainPanel) return
    const ownerWindow = mainPanel.ownerDocument.defaultView ?? window

    const parseMaxWidth = (raw: string): number => {
      const match = /^(-?\d+(?:\.\d+)?)px$/.exec(raw.trim())
      if (!match) return DEFAULT_SUBMENU_MAX_WIDTH_PX
      const value = Number.parseFloat(match[1])
      return Number.isFinite(value) && value > 0
        ? value
        : DEFAULT_SUBMENU_MAX_WIDTH_PX
    }
    const parseOptionalPx = (raw: string): number | null => {
      const match = /^(-?\d+(?:\.\d+)?)px$/.exec(raw.trim())
      if (!match) return null
      const value = Number.parseFloat(match[1])
      return Number.isFinite(value) ? value : null
    }
    const measure = () => {
      const mainRect = mainPanel.getBoundingClientRect()
      const viewportWidth = ownerWindow.innerWidth
      const style = ownerWindow.getComputedStyle(mainPanel)
      const maxWidth = parseMaxWidth(
        style.getPropertyValue('--yolo-chat-typeahead-max-width'),
      )
      const requiredWidth = Math.min(
        maxWidth,
        Math.max(0, viewportWidth - SUBMENU_VIEWPORT_MARGIN_PX * 2),
      )
      const boundaryLeft =
        parseOptionalPx(
          style.getPropertyValue('--yolo-typeahead-boundary-left'),
        ) ?? 0
      const boundaryRight =
        parseOptionalPx(
          style.getPropertyValue('--yolo-typeahead-boundary-right'),
        ) ?? viewportWidth
      const effectiveLeft = Math.max(0, boundaryLeft)
      const effectiveRight = Math.min(viewportWidth, boundaryRight)
      const spaceRight = effectiveRight - mainRect.right - SUBMENU_GAP_PX
      const spaceLeft = mainRect.left - effectiveLeft - SUBMENU_GAP_PX

      if (spaceRight >= requiredWidth) {
        setSubSide('right')
      } else if (spaceLeft >= requiredWidth) {
        setSubSide('left')
      } else {
        setSubSide('hidden')
      }
    }

    measure()
    ownerWindow.addEventListener('resize', measure)
    return () => ownerWindow.removeEventListener('resize', measure)
  }, [enabled, previewEntry, subOptions.length])

  const previewAnchorIndex = useMemo(() => {
    if (previewEntry === null) return -1
    return options.findIndex((option) => getEntryKey(option) === previewEntry)
  }, [getEntryKey, options, previewEntry])

  useLayoutEffect(() => {
    const popover = popoverRef.current
    const mainPanel = mainPanelRef.current
    if (
      !popover ||
      !mainPanel ||
      previewAnchorIndex < 0 ||
      subOptions.length === 0 ||
      subSide === 'hidden'
    ) {
      return
    }
    const items = mainPanel.querySelectorAll<HTMLElement>('[role="option"]')
    const item = items[previewAnchorIndex]
    if (!item) return
    const popoverRect = popover.getBoundingClientRect()
    const itemRect = item.getBoundingClientRect()
    popover.setCssProps({
      '--yolo-sub-anchor-top': `${Math.round(itemRect.top - popoverRect.top)}px`,
      '--yolo-sub-anchor-bottom': `${Math.round(itemRect.bottom - popoverRect.top)}px`,
    })
  }, [placement, previewAnchorIndex, subOptions.length, subSide])

  const cancelHoverOpen = useCallback(() => {
    if (openTimerRef.current === null) return
    getOwnerWindow().clearTimeout(openTimerRef.current)
    openTimerRef.current = null
  }, [getOwnerWindow])

  const cancelHoverClose = useCallback(() => {
    if (closeTimerRef.current === null) return
    getOwnerWindow().clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }, [getOwnerWindow])

  const scheduleHoverOpen = useCallback(
    (entry: TEntry) => {
      cancelHoverClose()
      cancelHoverOpen()
      openTimerRef.current = getOwnerWindow().setTimeout(() => {
        openTimerRef.current = null
        setHoveredEntry(entry)
      }, HOVER_OPEN_MS)
    },
    [cancelHoverClose, cancelHoverOpen, getOwnerWindow],
  )

  const scheduleHoverClose = useCallback(() => {
    cancelHoverOpen()
    cancelHoverClose()
    closeTimerRef.current = getOwnerWindow().setTimeout(() => {
      closeTimerRef.current = null
      setHoveredEntry(null)
      setFocusSide('main')
    }, HOVER_CLOSE_MS)
  }, [cancelHoverClose, cancelHoverOpen, getOwnerWindow])

  useLayoutEffect(() => {
    if (hoveredEntry !== null && lastCursorPosRef.current) {
      anchorCursorPosRef.current = { ...lastCursorPosRef.current }
    } else if (hoveredEntry === null) {
      anchorCursorPosRef.current = null
      setSafeActive(false)
    }
    if (hoveredEntry === null) return
    const index = options.findIndex(
      (option) => getEntryKey(option) === hoveredEntry,
    )
    if (index >= 0) setHighlightedIndexRef.current?.(index)
  }, [getEntryKey, hoveredEntry, options])

  const updateSafeTriangle = useCallback(
    (pointerX: number, pointerY: number): boolean => {
      const anchor = anchorCursorPosRef.current
      const subPanel = subPanelRef.current
      if (!subPanelActive || !anchor || !subPanel) return false

      const subRect = subPanel.getBoundingClientRect()
      const edgeX = subSide === 'right' ? subRect.left : subRect.right
      const sign = (
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        x3: number,
        y3: number,
      ) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3)
      const d1 = sign(
        pointerX,
        pointerY,
        anchor.x,
        anchor.y,
        edgeX,
        subRect.top,
      )
      const d2 = sign(
        pointerX,
        pointerY,
        edgeX,
        subRect.top,
        edgeX,
        subRect.bottom,
      )
      const d3 = sign(
        pointerX,
        pointerY,
        edgeX,
        subRect.bottom,
        anchor.x,
        anchor.y,
      )
      const hasNegative = d1 < 0 || d2 < 0 || d3 < 0
      const hasPositive = d1 > 0 || d2 > 0 || d3 > 0
      return !(hasNegative && hasPositive)
    },
    [subPanelActive, subSide],
  )

  const handlePopoverMouseMove = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      lastCursorPosRef.current = { x: event.clientX, y: event.clientY }
      const isSafe = updateSafeTriangle(event.clientX, event.clientY)
      if (isSafe) cancelHoverOpen()
      setSafeActive(isSafe)
    },
    [cancelHoverOpen, updateSafeTriangle],
  )

  useLayoutEffect(() => {
    if (focusSide === 'sub' && subPanelActive) {
      setActiveDescendantIdRef.current?.(
        `typeahead-subitem-${subHighlightedIndex}`,
      )
    } else if (mainSelectedIndex !== null) {
      setActiveDescendantIdRef.current?.(`typeahead-item-${mainSelectedIndex}`)
    }
  }, [focusSide, mainSelectedIndex, subHighlightedIndex, subPanelActive])

  const customKeyHandlers = useMemo<CustomKeyHandlers>(
    () => ({
      onArrowRight: (event) => {
        if (event.isComposing || focusSide !== 'main' || !subPanelActive) {
          return false
        }
        setFocusSide('sub')
        setSubHighlightedIndex(0)
        return true
      },
      onArrowLeft: (event) => {
        if (event.isComposing || focusSide !== 'sub' || !subPanelActive) {
          return false
        }
        setFocusSide('main')
        return true
      },
      onArrowDown: (event) => {
        if (
          event.isComposing ||
          focusSide !== 'sub' ||
          !subPanelActive ||
          subOptions.length === 0
        ) {
          return false
        }
        setSubHighlightedIndex((current) =>
          current === subOptions.length - 1 ? 0 : current + 1,
        )
        return true
      },
      onArrowUp: (event) => {
        if (
          event.isComposing ||
          focusSide !== 'sub' ||
          !subPanelActive ||
          subOptions.length === 0
        ) {
          return false
        }
        setSubHighlightedIndex((current) =>
          current === 0 ? subOptions.length - 1 : current - 1,
        )
        return true
      },
      onEnter: (event) => {
        if (
          event?.isComposing ||
          focusSide !== 'sub' ||
          !subPanelActive ||
          subOptions.length === 0
        ) {
          return false
        }
        const option = subOptions[subHighlightedIndex]
        const selectOption = selectOptionRef.current
        if (!option || !selectOption) return false
        selectOption(option)
        return true
      },
    }),
    [focusSide, subHighlightedIndex, subOptions, subPanelActive],
  )

  const renderMenu = ({
    anchorElementRef,
    itemProps,
    mainListKey,
    mainListTransition,
    menuContainer,
    onMainListAnimationEnd,
    renderItem,
  }: RenderMenuProps<TOption>): ReturnType<MenuRenderFn<TOption>> => {
    const portalTarget = menuContainer ?? anchorElementRef.current
    if (!portalTarget || options.length === 0) return null

    const {
      selectedIndex,
      selectOptionAndCleanUp,
      setActiveDescendantId,
      setHighlightedIndex,
    } = itemProps
    selectOptionRef.current = selectOptionAndCleanUp
    setHighlightedIndexRef.current = setHighlightedIndex
    setActiveDescendantIdRef.current = setActiveDescendantId

    return createPortal(
      <div
        ref={popoverRef}
        className="yolo-smart-space-mention-popover"
        data-placement={placement}
        data-safe-active={safeActive ? 'true' : undefined}
        onPointerLeave={scheduleHoverClose}
        onPointerEnter={cancelHoverClose}
        onMouseMove={handlePopoverMouseMove}
      >
        <SelectedIndexSync
          selectedIndex={selectedIndex}
          setSelectedIndex={setMainSelectedIndex}
        />
        <div
          ref={mainPanelRef}
          className="yolo-popover-surface yolo-popover-surface--smart-space yolo-smart-space-mention-dropdown"
        >
          <div
            key={mainListKey}
            className="yolo-smart-space-mention-list"
            role="listbox"
            data-transition={mainListTransition}
            onAnimationEnd={onMainListAnimationEnd}
          >
            {options.map((option, index) => {
              const entry = getEntryKey(option)
              return renderItem({
                id: `typeahead-item-${index}`,
                index,
                isSelected: focusSide === 'main' && selectedIndex === index,
                onClick: () => {
                  setHighlightedIndex(index)
                  if (
                    entry !== null &&
                    subSide !== 'hidden' &&
                    getSubOptions(entry).length > 0
                  ) {
                    cancelHoverOpen()
                    cancelHoverClose()
                    setFocusSide('main')
                    setSubHighlightedIndex(0)
                    setHoveredEntry(entry)
                    return
                  }
                  selectOptionAndCleanUp(option)
                },
                onMouseEnter: (event) => {
                  lastCursorPosRef.current = {
                    x: event.clientX,
                    y: event.clientY,
                  }
                  const isSafe = updateSafeTriangle(
                    event.clientX,
                    event.clientY,
                  )
                  setSafeActive(isSafe)
                  if (focusSide === 'sub') setFocusSide('main')
                  if (!isSafe) setHighlightedIndex(index)
                  if (entry !== null && getSubOptions(entry).length > 0) {
                    if (isSafe) cancelHoverOpen()
                    else scheduleHoverOpen(entry)
                  } else {
                    scheduleHoverClose()
                  }
                },
                option,
              })
            })}
          </div>
        </div>
        {subPanelActive && (
          <div
            key={`sub:${previewEntry}:${subSide}`}
            ref={subPanelRef}
            className="yolo-popover-surface yolo-popover-surface--smart-space yolo-smart-space-mention-dropdown yolo-smart-space-mention-subpanel"
            data-side={subSide}
            role="listbox"
            onPointerEnter={cancelHoverClose}
            onPointerLeave={scheduleHoverClose}
          >
            <div className="yolo-smart-space-mention-list">
              {subOptions.map((option, index) =>
                renderItem({
                  id: `typeahead-subitem-${index}`,
                  index,
                  isSelected:
                    focusSide === 'sub' && subHighlightedIndex === index,
                  onClick: () => selectOptionAndCleanUp(option),
                  onMouseEnter: () => {
                    setFocusSide('sub')
                    setSubHighlightedIndex(index)
                    cancelHoverClose()
                  },
                  option,
                }),
              )}
            </div>
          </div>
        )}
      </div>,
      portalTarget,
    )
  }

  return { customKeyHandlers, renderMenu, reset }
}
