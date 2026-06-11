import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Brain, ChevronDown, ChevronUp } from 'lucide-react'
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { ChatModel } from '../../../types/chat-model.types'
import {
  REASONING_LEVELS,
  ReasoningLevel,
  getDefaultReasoningLevel,
  modelSupportsReasoning,
} from '../../../types/reasoning'
import { getNodeWindow } from '../../../utils/dom/window-context'
import { YoloDropdownContent } from '../../common/popover'
import { ReasoningPanel } from '../../common/ReasoningPanel'
import { REASONING_OPTIONS } from '../../common/ReasoningSegmented'

export type { ReasoningLevel } from '../../../types/reasoning'

export function supportsReasoning(model: ChatModel | null): boolean {
  return model !== null && modelSupportsReasoning(model)
}

export const ReasoningSelect = forwardRef<
  HTMLButtonElement,
  {
    model: ChatModel | null
    value: ReasoningLevel
    onChange: (level: ReasoningLevel) => void
    onMenuOpenChange?: (isOpen: boolean) => void
    container?: HTMLElement
    side?: 'top' | 'bottom' | 'left' | 'right'
    sideOffset?: number
    align?: 'start' | 'center' | 'end'
    alignOffset?: number
  }
>(
  (
    {
      model,
      value,
      onChange,
      onMenuOpenChange,
      container,
      side = 'top',
      sideOffset = 4,
      align = 'center',
      alignOffset = 0,
    },
    ref,
  ) => {
    const { t } = useLanguage()
    const [isOpen, setIsOpen] = useState(false)
    const triggerRef = useRef<HTMLButtonElement | null>(null)
    const shouldFocusSegmentOnOpenRef = useRef(false)
    const segmentRefs = useRef<
      Record<ReasoningLevel, HTMLButtonElement | null>
    >(
      Object.fromEntries(
        REASONING_LEVELS.map((level) => [level, null]),
      ) as Record<ReasoningLevel, HTMLButtonElement | null>,
    )

    const setTriggerRef = useCallback(
      (node: HTMLButtonElement | null) => {
        triggerRef.current = node
        if (typeof ref === 'function') {
          ref(node)
        } else if (ref) {
          ref.current = node
        }
      },
      [ref],
    )

    const fallbackValue = getDefaultReasoningLevel(model)
    const safeValue = REASONING_OPTIONS.some((opt) => opt.value === value)
      ? value
      : fallbackValue
    const currentOption =
      REASONING_OPTIONS.find((opt) => opt.value === safeValue) ??
      REASONING_OPTIONS[0]

    const focusSelectedSegment = useCallback(() => {
      const target = segmentRefs.current[safeValue]
      if (!target) return
      target.focus({ preventScroll: true })
    }, [safeValue])

    useEffect(() => {
      if (!isOpen || !shouldFocusSegmentOnOpenRef.current) return
      const ownerWindow = getNodeWindow(triggerRef.current)
      const rafId = ownerWindow.requestAnimationFrame(() => {
        shouldFocusSegmentOnOpenRef.current = false
        focusSelectedSegment()
      })
      return () => ownerWindow.cancelAnimationFrame(rafId)
    }, [isOpen, focusSelectedSegment])

    const handleOpenChange = (open: boolean) => {
      if (!open) shouldFocusSegmentOnOpenRef.current = false
      setIsOpen(open)
      onMenuOpenChange?.(open)
    }

    if (!supportsReasoning(model)) {
      return null
    }

    const handleTriggerKeyDown = (
      event: React.KeyboardEvent<HTMLButtonElement>,
    ) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!isOpen) {
          event.preventDefault()
          shouldFocusSegmentOnOpenRef.current = true
          setIsOpen(true)
          return
        }
        event.preventDefault()
        focusSelectedSegment()
        return
      }

      if (isOpen && event.key === 'Escape') {
        event.preventDefault()
        handleOpenChange(false)
      }

      if (event.key === 'Enter' || event.key === ' ') {
        shouldFocusSegmentOnOpenRef.current = true
      }
    }

    const currentLabel = t(currentOption.labelKey, currentOption.labelFallback)

    return (
      <DropdownMenu.Root open={isOpen} onOpenChange={handleOpenChange}>
        <DropdownMenu.Trigger
          ref={setTriggerRef}
          className="yolo-chat-input-model-select yolo-reasoning-select"
          onKeyDown={handleTriggerKeyDown}
          onPointerDown={() => {
            shouldFocusSegmentOnOpenRef.current = false
          }}
        >
          <div className="yolo-reasoning-select__icon">
            <Brain size={14} />
          </div>
          <div className="yolo-chat-input-model-select__label yolo-chat-input-model-select__model-name">
            {currentLabel}
          </div>
          <div className="yolo-chat-input-model-select__icon">
            {isOpen ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          </div>
        </DropdownMenu.Trigger>

        <YoloDropdownContent
          container={container}
          anchorRef={triggerRef}
          variant="default"
          minWidth={280}
          maxWidth={280}
          maxHeight={220}
          className="yolo-reasoning-popover"
          side={side}
          sideOffset={sideOffset}
          align={align}
          alignOffset={alignOffset}
          collisionPadding={8}
          loop
          onPointerDownOutside={(e) => {
            e.stopPropagation()
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            triggerRef.current?.focus({ preventScroll: true })
          }}
        >
          <ReasoningPanel
            model={model}
            value={safeValue}
            onChange={onChange}
            segmentRefs={segmentRefs}
          />
        </YoloDropdownContent>
      </DropdownMenu.Root>
    )
  },
)

ReasoningSelect.displayName = 'ReasoningSelect'
