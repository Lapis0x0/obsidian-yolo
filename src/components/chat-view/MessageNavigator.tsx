import cx from 'clsx'
import type { RefObject } from 'react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'

const WAVE_RADIUS_PX = 42
const BAR_HEIGHT_PX = 12
const RAIL_PADDING_PX = 8
const WAVE_INDEX_RADIUS = Math.ceil(WAVE_RADIUS_PX / BAR_HEIGHT_PX)

// Pointer position in rail content coordinates, and the bar nearest to it
// (clamped to the ends, so a finger dragged past the rail picks the last bar).
function locatePointerOnRail(
  rail: HTMLElement,
  clientY: number,
  anchorCount: number,
) {
  const pointerContentY =
    clientY -
    rail.getBoundingClientRect().top +
    rail.scrollTop -
    RAIL_PADDING_PX
  const nearestIndex = Math.max(
    0,
    Math.min(
      anchorCount - 1,
      Math.round((pointerContentY - BAR_HEIGHT_PX / 2) / BAR_HEIGHT_PX),
    ),
  )
  return { pointerContentY, nearestIndex }
}

export type MessageNavigatorAnchor = {
  id: string
  index: number
  userPreview: string
  assistantPreview: string
}

type MessageNavigatorProps = {
  anchors: MessageNavigatorAnchor[]
  activeMessageId: string | null
  visibleMessageIds: string[]
  itemLabel: (index: number, label: string) => string
  onSelect: (messageId: string) => void
}

type MessageNavigatorRailProps = Omit<
  MessageNavigatorProps,
  'visibleMessageIds'
> & {
  railRef: RefObject<HTMLDivElement>
  visibleMessageIdSet: Set<string>
  onBarRef: (messageId: string, element: HTMLButtonElement | null) => void
  onBarFocus: (element: HTMLButtonElement) => void
  onRailScroll: () => void
}

const MessageNavigatorRail = memo(function MessageNavigatorRail({
  anchors,
  activeMessageId,
  visibleMessageIdSet,
  itemLabel,
  onSelect,
  railRef,
  onBarRef,
  onBarFocus,
  onRailScroll,
}: MessageNavigatorRailProps) {
  return (
    <div
      ref={railRef}
      className="yolo-message-navigator__rail"
      onScroll={onRailScroll}
    >
      {anchors.map((anchor) => (
        <button
          key={anchor.id}
          ref={(element) => onBarRef(anchor.id, element)}
          type="button"
          className={cx(
            'yolo-message-navigator__bar',
            visibleMessageIdSet.has(anchor.id) && 'is-visible',
            anchor.id === activeMessageId && 'is-current',
          )}
          data-message-id={anchor.id}
          aria-current={anchor.id === activeMessageId ? 'location' : false}
          onPointerDown={(event) => event.preventDefault()}
          // Pointer selection happens on release (see the navigator's
          // onPointerUp); a click with detail 0 is keyboard or assistive
          // activation, which never goes through pointer events.
          onClick={(event) => {
            if (event.detail === 0) onSelect(anchor.id)
          }}
          onFocus={(event) => onBarFocus(event.currentTarget)}
        >
          <span className="yolo-message-navigator__bar-line" />
          <span className="yolo-sr-only">
            {itemLabel(anchor.index, anchor.userPreview)}
          </span>
        </button>
      ))}
    </div>
  )
})

function MessageNavigator({
  anchors,
  activeMessageId,
  visibleMessageIds,
  itemLabel,
  onSelect,
}: MessageNavigatorProps) {
  const navigatorRef = useRef<HTMLElement | null>(null)
  const railRef = useRef<HTMLDivElement | null>(null)
  const barRefs = useRef(new Map<string, HTMLButtonElement>())
  const anchorsRef = useRef(anchors)
  anchorsRef.current = anchors
  const pointerFrameRef = useRef<number | null>(null)
  const lastPointerClientYRef = useRef<number | null>(null)
  // The pointer whose press started on a bar; only its release selects.
  const pressedPointerIdRef = useRef<number | null>(null)
  const wavedAnchorIdsRef = useRef<Set<string>>(new Set())
  const waveStrengthByAnchorIdRef = useRef(new Map<string, string>())
  const [hoveredAnchorId, setHoveredAnchorId] = useState<string | null>(null)
  const visibleMessageIdSet = useMemo(
    () => new Set(visibleMessageIds),
    [visibleMessageIds],
  )
  const hoveredAnchor = hoveredAnchorId
    ? (anchors.find((anchor) => anchor.id === hoveredAnchorId) ?? null)
    : null

  const resetWave = useCallback(() => {
    if (pointerFrameRef.current !== null) {
      window.cancelAnimationFrame(pointerFrameRef.current)
      pointerFrameRef.current = null
    }
    wavedAnchorIdsRef.current.forEach((anchorId) => {
      barRefs.current.get(anchorId)?.setCssProps({
        '--yolo-message-navigator-wave': '0',
      })
      waveStrengthByAnchorIdRef.current.set(anchorId, '0')
    })
    wavedAnchorIdsRef.current.clear()
    setHoveredAnchorId(null)
  }, [])

  const applyWaveAtClientY = useCallback((clientY: number) => {
    const navigator = navigatorRef.current
    const rail = railRef.current
    if (!navigator || !rail) {
      return
    }

    const currentAnchors = anchorsRef.current
    if (currentAnchors.length === 0) {
      setHoveredAnchorId(null)
      return
    }

    const railRect = rail.getBoundingClientRect()
    const navigatorRect = navigator.getBoundingClientRect()
    const { pointerContentY, nearestIndex } = locatePointerOnRail(
      rail,
      clientY,
      currentAnchors.length,
    )
    const startIndex = Math.max(0, nearestIndex - WAVE_INDEX_RADIUS)
    const endIndex = Math.min(
      currentAnchors.length - 1,
      nearestIndex + WAVE_INDEX_RADIUS,
    )
    const nextWavedAnchorIds = new Set<string>()

    for (let index = startIndex; index <= endIndex; index += 1) {
      const anchor = currentAnchors[index]
      const barCenterY = index * BAR_HEIGHT_PX + BAR_HEIGHT_PX / 2
      const distance = Math.abs(barCenterY - pointerContentY)
      const linearStrength = Math.max(0, 1 - distance / WAVE_RADIUS_PX)
      const waveStrength =
        linearStrength * linearStrength * (3 - 2 * linearStrength)
      const serializedStrength = waveStrength.toFixed(3)
      nextWavedAnchorIds.add(anchor.id)

      if (
        waveStrengthByAnchorIdRef.current.get(anchor.id) !== serializedStrength
      ) {
        barRefs.current.get(anchor.id)?.setCssProps({
          '--yolo-message-navigator-wave': serializedStrength,
        })
        waveStrengthByAnchorIdRef.current.set(anchor.id, serializedStrength)
      }
    }

    wavedAnchorIdsRef.current.forEach((anchorId) => {
      if (nextWavedAnchorIds.has(anchorId)) {
        return
      }
      barRefs.current.get(anchorId)?.setCssProps({
        '--yolo-message-navigator-wave': '0',
      })
      waveStrengthByAnchorIdRef.current.set(anchorId, '0')
    })
    wavedAnchorIdsRef.current = nextWavedAnchorIds

    const nearestAnchor = currentAnchors[nearestIndex]
    const nearestBarCenterClientY =
      railRect.top +
      RAIL_PADDING_PX +
      nearestIndex * BAR_HEIGHT_PX +
      BAR_HEIGHT_PX / 2 -
      rail.scrollTop
    navigator.setCssProps({
      '--yolo-message-navigator-preview-top': `${nearestBarCenterClientY - navigatorRect.top}px`,
    })
    setHoveredAnchorId((currentId) =>
      currentId === nearestAnchor.id ? currentId : nearestAnchor.id,
    )
  }, [])

  const scheduleWaveAtClientY = useCallback(
    (clientY: number) => {
      lastPointerClientYRef.current = clientY
      if (pointerFrameRef.current !== null) {
        return
      }

      pointerFrameRef.current = window.requestAnimationFrame(() => {
        pointerFrameRef.current = null
        const pendingClientY = lastPointerClientYRef.current
        if (pendingClientY !== null) {
          applyWaveAtClientY(pendingClientY)
        }
      })
    },
    [applyWaveAtClientY],
  )

  const handleBarRef = useCallback(
    (messageId: string, element: HTMLButtonElement | null) => {
      if (element) {
        barRefs.current.set(messageId, element)
        return
      }

      // A null here is usually just the inline ref callback being swapped on
      // re-render, with the same element re-attached right after, so the wave
      // bookkeeping stays: dropping it would leave those bars lit when the
      // wave resets. Entries for truly removed bars resolve to no element and
      // are skipped.
      barRefs.current.delete(messageId)
    },
    [],
  )
  const handleBarFocus = useCallback(
    (element: HTMLButtonElement) => {
      const barRect = element.getBoundingClientRect()
      applyWaveAtClientY(barRect.top + barRect.height / 2)
    },
    [applyWaveAtClientY],
  )
  const handleRailScroll = useCallback(() => {
    const clientY = lastPointerClientYRef.current
    if (clientY !== null) {
      scheduleWaveAtClientY(clientY)
    }
  }, [scheduleWaveAtClientY])

  useEffect(() => {
    if (!activeMessageId) {
      return
    }

    const rail = railRef.current
    const activeBar = barRefs.current.get(activeMessageId)
    if (!rail || !activeBar) {
      return
    }

    const targetScrollTop =
      activeBar.offsetTop - rail.clientHeight / 2 + activeBar.offsetHeight / 2
    rail.scrollTop = Math.max(0, targetScrollTop)
  }, [activeMessageId])

  useEffect(
    () => () => {
      if (pointerFrameRef.current !== null) {
        window.cancelAnimationFrame(pointerFrameRef.current)
      }
    },
    [],
  )

  if (anchors.length === 0) {
    return null
  }

  return (
    <nav
      ref={navigatorRef}
      className={cx(
        'yolo-message-navigator',
        hoveredAnchor && 'is-interacting',
      )}
      onPointerMove={(event) => scheduleWaveAtClientY(event.clientY)}
      // Release selects the bar nearest the pointer, so a finger can scrub
      // the rail and let go on a message. Touch capture routes the release
      // here even when the finger ended outside the rail; a mouse released
      // elsewhere never reaches the navigator and selects nothing.
      onPointerDown={(event) => {
        pressedPointerIdRef.current = event.pointerId
      }}
      onPointerUp={(event) => {
        const pressedHere = pressedPointerIdRef.current === event.pointerId
        pressedPointerIdRef.current = null
        const rail = railRef.current
        const currentAnchors = anchorsRef.current
        if (
          !pressedHere ||
          event.button !== 0 ||
          !rail ||
          currentAnchors.length === 0
        ) {
          return
        }
        const { nearestIndex } = locatePointerOnRail(
          rail,
          event.clientY,
          currentAnchors.length,
        )
        onSelect(currentAnchors[nearestIndex].id)
      }}
      onPointerCancel={() => {
        pressedPointerIdRef.current = null
        resetWave()
      }}
      onPointerLeave={() => {
        lastPointerClientYRef.current = null
        const navigator = navigatorRef.current
        const focusedElement = navigator?.ownerDocument.activeElement
        if (focusedElement && navigator?.contains(focusedElement)) {
          const focusedRect = focusedElement.getBoundingClientRect()
          applyWaveAtClientY(focusedRect.top + focusedRect.height / 2)
          return
        }
        resetWave()
      }}
      onBlurCapture={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        ) {
          return
        }
        resetWave()
      }}
    >
      <MessageNavigatorRail
        anchors={anchors}
        activeMessageId={activeMessageId}
        itemLabel={itemLabel}
        onSelect={onSelect}
        railRef={railRef}
        visibleMessageIdSet={visibleMessageIdSet}
        onBarRef={handleBarRef}
        onBarFocus={handleBarFocus}
        onRailScroll={handleRailScroll}
      />
      {hoveredAnchor ? (
        <div className="yolo-message-navigator__preview" aria-hidden="true">
          <div className="yolo-message-navigator__preview-user">
            {hoveredAnchor.userPreview}
          </div>
          {hoveredAnchor.assistantPreview ? (
            <div className="yolo-message-navigator__preview-assistant">
              {hoveredAnchor.assistantPreview}
            </div>
          ) : null}
        </div>
      ) : null}
    </nav>
  )
}

export default memo(MessageNavigator)
