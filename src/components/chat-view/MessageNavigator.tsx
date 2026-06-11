import cx from 'clsx'
import { memo, useCallback, useEffect, useRef } from 'react'

export type MessageNavigatorAnchor = {
  id: string
  index: number
  label: string
}

type MessageNavigatorProps = {
  anchors: MessageNavigatorAnchor[]
  activeMessageId: string | null
  itemLabel: (index: number, label: string) => string
  onSelect: (messageId: string) => void
}

function MessageNavigator({
  anchors,
  activeMessageId,
  itemLabel,
  onSelect,
}: MessageNavigatorProps) {
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  const scrollActiveItemIntoView = useCallback(() => {
    if (!activeMessageId) {
      return
    }

    const activeItem = itemRefs.current[activeMessageId]
    if (!activeItem) {
      return
    }

    requestAnimationFrame(() => {
      activeItem.scrollIntoView({
        block: 'center',
        inline: 'nearest',
      })
    })
  }, [activeMessageId])

  useEffect(() => {
    scrollActiveItemIntoView()
  }, [scrollActiveItemIntoView])

  if (anchors.length === 0) {
    return null
  }

  return (
    <nav
      className="yolo-message-navigator"
      onMouseEnter={scrollActiveItemIntoView}
    >
      <div className="yolo-message-navigator__rail">
        {anchors.map((anchor) => (
          <button
            key={anchor.id}
            type="button"
            className={cx(
              'yolo-message-navigator__bar',
              anchor.id === activeMessageId && 'is-active',
            )}
            onPointerDown={(event) => {
              event.preventDefault()
              onSelect(anchor.id)
            }}
          >
            <span className="yolo-sr-only">
              {itemLabel(anchor.index, anchor.label)}
            </span>
          </button>
        ))}
      </div>
      <div className="yolo-message-navigator__panel">
        <div className="yolo-message-navigator__items">
          {anchors.map((anchor) => (
            <button
              key={anchor.id}
              ref={(element) => {
                itemRefs.current[anchor.id] = element
              }}
              type="button"
              className={cx(
                'yolo-message-navigator__item',
                anchor.id === activeMessageId && 'is-active',
              )}
              onPointerDown={(event) => {
                event.preventDefault()
                onSelect(anchor.id)
              }}
              aria-current={anchor.id === activeMessageId ? 'location' : false}
            >
              <span className="yolo-message-navigator__item-label">
                {anchor.label}
              </span>
            </button>
          ))}
        </div>
      </div>
    </nav>
  )
}

export default memo(MessageNavigator)
