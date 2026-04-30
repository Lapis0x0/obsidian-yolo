import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'

import { useSettings } from '../../../contexts/settings-context'
import {
  getNodeBody,
  getNodeDocument,
  getNodeWindow,
} from '../../../utils/dom/window-context'
import { getModelDisplayName } from '../../../utils/model-id-utils'
import { YoloDropdownContent, YoloPopoverVariant } from '../../common/popover'

export type ModelSelectPopoverProps = {
  variant?: YoloPopoverVariant
  minWidth?: number | string
  maxWidth?: number | string
  maxHeight?: number | string
  /** Extra class for consumer-specific concerns (rare; use sparingly). */
  className?: string
}

export const ModelSelect = forwardRef<
  HTMLButtonElement,
  {
    modelId?: string
    onModelSelected?: (modelId: string) => void
    onChange?: (modelId: string) => void
    onMenuOpenChange?: (isOpen: boolean) => void
    side?: 'top' | 'bottom' | 'left' | 'right'
    sideOffset?: number
    align?: 'start' | 'center' | 'end'
    alignOffset?: number
    container?: HTMLElement
    /** Popover surface variant + sizing. Each caller declares its own. */
    popover?: ModelSelectPopoverProps
    onKeyDown?: (
      event: React.KeyboardEvent<HTMLButtonElement>,
      isMenuOpen: boolean,
    ) => void
  }
>(
  (
    {
      modelId: externalModelId,
      onModelSelected,
      onChange,
      onMenuOpenChange,
      side = 'bottom',
      sideOffset = 4,
      align = 'end',
      alignOffset = 0,
      container,
      popover,
      onKeyDown,
    } = {},
    ref,
  ) => {
    const { settings, setSettings } = useSettings()
    const [isOpen, setIsOpen] = useState(false)
    const triggerRef = useRef<HTMLButtonElement | null>(null)
    const itemRefs = useRef<Record<string, HTMLDivElement | null>>({})
    const selectedModelId = externalModelId ?? settings.chatModelId
    const resolvedContainer = container ?? getNodeBody(triggerRef.current)

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

    const enabledModels = settings.chatModels.filter(
      ({ enable }) => enable ?? true,
    )
    const providerOrder = settings.providers.map((p) => p.id)
    const providerIdsInModels = Array.from(
      new Set(enabledModels.map((m) => m.providerId)),
    )
    const orderedProviderIds = [
      ...providerOrder.filter((id) => providerIdsInModels.includes(id)),
      ...providerIdsInModels.filter((id) => !providerOrder.includes(id)),
    ]
    const orderedModelIds = orderedProviderIds.flatMap((pid) =>
      enabledModels.filter((m) => m.providerId === pid).map((m) => m.id),
    )

    // Get provider name for current model
    const getCurrentModelDisplay = () => {
      const currentModel = settings.chatModels.find(
        (m) => m.id === selectedModelId,
      )
      if (currentModel) {
        // 优先显示「展示名称」，其次调用ID(model)，最后回退到内部 id
        const provider = settings.providers.find(
          (p) => p.id === currentModel.providerId,
        )
        const display =
          currentModel.name || currentModel.model || currentModel.id
        // 使用 provider 展示后缀
        const suffix = provider?.id ? ` (${provider.id})` : ''
        return `${display}${suffix}`
      }
      return selectedModelId
    }

    const focusSelectedItem = useCallback(() => {
      const target = itemRefs.current[selectedModelId]
      if (!target) return
      target.focus({ preventScroll: true })

      // 打开时把选中项滚动到列表中部，避免贴边
      target.scrollIntoView({
        block: 'center',
        inline: 'nearest',
      })
    }, [selectedModelId])

    const focusByDelta = useCallback(
      (delta: number) => {
        if (orderedModelIds.length === 0) return
        const activeElement = getNodeDocument(triggerRef.current)
          .activeElement as HTMLElement | null
        const activeId =
          activeElement?.dataset?.modelId &&
          orderedModelIds.includes(activeElement.dataset.modelId)
            ? activeElement.dataset.modelId
            : selectedModelId
        const currentIndex = orderedModelIds.indexOf(activeId)
        const nextIndex =
          currentIndex === -1
            ? 0
            : (currentIndex + delta + orderedModelIds.length) %
              orderedModelIds.length
        const nextId = orderedModelIds[nextIndex]
        const target = itemRefs.current[nextId]
        if (target) {
          target.focus({ preventScroll: true })
          target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }
      },
      [orderedModelIds, selectedModelId],
    )

    useEffect(() => {
      if (!isOpen) return
      const ownerWindow = getNodeWindow(triggerRef.current)
      const rafId = ownerWindow.requestAnimationFrame(() => {
        focusSelectedItem()
      })
      return () => ownerWindow.cancelAnimationFrame(rafId)
    }, [isOpen, focusSelectedItem])

    const handleTriggerKeyDown = (
      event: React.KeyboardEvent<HTMLButtonElement>,
    ) => {
      // 处理键盘导航
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        // 先让外部有机会消费（例如切回输入框）
        if (onKeyDown) {
          onKeyDown(event, isOpen)
        }
        if (event.defaultPrevented) {
          return
        }

        // 如果下拉菜单未打开，按上下方向键时打开它
        if (!isOpen) {
          event.preventDefault()
          setIsOpen(true)
          return
        }
        // 菜单已打开时，确保焦点移入列表，让 Radix 接管
        event.preventDefault()
        focusSelectedItem()
        return
      }

      if (isOpen && event.key === 'Escape') {
        event.preventDefault()
        handleOpenChange(false)
        return
      }

      // 调用传入的 onKeyDown 处理器来处理其他导航键
      if (onKeyDown) {
        onKeyDown(event, isOpen)
      }
    }

    const handleOpenChange = (open: boolean) => {
      setIsOpen(open)
      onMenuOpenChange?.(open)
    }

    return (
      <DropdownMenu.Root open={isOpen} onOpenChange={handleOpenChange}>
        <DropdownMenu.Trigger
          ref={setTriggerRef}
          className="smtcmp-chat-input-model-select"
          onKeyDown={handleTriggerKeyDown}
        >
          <div className="smtcmp-chat-input-model-select__label smtcmp-chat-input-model-select__model-name">
            {getCurrentModelDisplay()}
          </div>
          <div className="smtcmp-chat-input-model-select__icon">
            {isOpen ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          </div>
        </DropdownMenu.Trigger>

        <YoloDropdownContent
          container={resolvedContainer}
          variant={popover?.variant ?? 'default'}
          minWidth={popover?.minWidth}
          maxWidth={popover?.maxWidth}
          maxHeight={popover?.maxHeight}
          className={popover?.className}
          side={side}
          sideOffset={sideOffset}
          align={align}
          alignOffset={alignOffset}
          collisionPadding={8}
          loop
          onPointerDownOutside={(e) => {
            // 阻止事件冒泡，防止关闭父容器
            e.stopPropagation()
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            triggerRef.current?.focus({ preventScroll: true })
          }}
        >
          <DropdownMenu.RadioGroup
            className="smtcmp-model-select-list"
            value={selectedModelId}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                focusByDelta(1)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                focusByDelta(-1)
              }
            }}
            onValueChange={(modelId: string) => {
              if (onChange) {
                onChange(modelId)
              } else {
                void (async () => {
                  try {
                    await setSettings({
                      ...settings,
                      chatModelId: modelId,
                    })
                  } catch (error: unknown) {
                    console.error('Failed to update chat model setting', error)
                  }
                })()
              }
              onModelSelected?.(modelId)
            }}
          >
            {(() => {
              let runningIndex = 0

              return orderedProviderIds.flatMap((pid, groupIndex) => {
                const groupModels = enabledModels.filter(
                  (m) => m.providerId === pid,
                )
                if (groupModels.length === 0) return []

                const groupHeader = (
                  <DropdownMenu.Label
                    key={`label-${pid}`}
                    className="smtcmp-popover-group-label"
                  >
                    {pid}
                  </DropdownMenu.Label>
                )

                const items = groupModels.map((chatModelOption, index) => {
                  // 列表项名称：优先显示「展示名称」，其次调用ID(model)，最后回退到内部 id
                  const displayName =
                    chatModelOption.name ||
                    chatModelOption.model ||
                    getModelDisplayName(chatModelOption.id)
                  runningIndex += 1
                  return (
                    <DropdownMenu.RadioItem
                      key={chatModelOption.id}
                      className="smtcmp-popover-item"
                      value={chatModelOption.id}
                      ref={(element) => {
                        itemRefs.current[chatModelOption.id] = element
                      }}
                      data-model-id={chatModelOption.id}
                      data-first-item={
                        runningIndex === 1 && index === 0 ? 'true' : undefined
                      }
                    >
                      <span className="smtcmp-popover-item__label">
                        {displayName}
                      </span>
                      <DropdownMenu.ItemIndicator className="smtcmp-popover-item__indicator">
                        <Check size={12} />
                      </DropdownMenu.ItemIndicator>
                    </DropdownMenu.RadioItem>
                  )
                })

                return [
                  groupHeader,
                  ...items,
                  ...(groupIndex < orderedProviderIds.length - 1
                    ? [
                        <DropdownMenu.Separator
                          key={`sep-${pid}`}
                          className="smtcmp-popover-group-separator"
                        />,
                      ]
                    : []),
                ]
              })
            })()}
          </DropdownMenu.RadioGroup>
        </YoloDropdownContent>
      </DropdownMenu.Root>
    )
  },
)

ModelSelect.displayName = 'ModelSelect'
