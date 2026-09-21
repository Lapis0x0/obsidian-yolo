import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, ChevronUp, Search } from 'lucide-react'
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import {
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

export type ModelSelectOption = {
  id: string
  label: string
  group?: string
}

/**
 * Opt-in "default option" affordance: the default row carries a badge, and a
 * hovered/highlighted row shows an inline button that sets or removes it.
 * Picking a row stays a separate action — the button never selects its row.
 */
export type ModelSelectDefaultOption = {
  id: string | null
  onToggle: (optionId: string) => void
  badgeLabel: string
  setLabel: string
  removeLabel: string
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
    options?: ModelSelectOption[]
    defaultOption?: ModelSelectDefaultOption
    disabled?: boolean
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
      options: externalOptions,
      defaultOption,
      disabled = false,
    } = {},
    ref,
  ) => {
    const { settings, setSettings } = useSettings()
    const { t } = useLanguage()
    const [isOpen, setIsOpen] = useState(false)
    const [query, setQuery] = useState('')
    const triggerRef = useRef<HTMLButtonElement | null>(null)
    const searchRef = useRef<HTMLInputElement | null>(null)
    const contentRef = useRef<HTMLDivElement | null>(null)
    /**
     * The side the popover actually opened on, held for as long as it stays
     * open. Radix re-picks a side whenever the content's size changes, so a
     * list that only fitted above would jump below the trigger the moment a
     * search made it short enough to fit there.
     */
    const [openedSide, setOpenedSide] = useState<
      'top' | 'bottom' | 'left' | 'right' | null
    >(null)
    const itemRefs = useRef<Record<string, HTMLDivElement | null>>({})
    const selectedModelId = externalModelId ?? settings.chatModelId

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
    const modelOptions: ModelSelectOption[] =
      externalOptions ??
      orderedProviderIds.flatMap((providerId) =>
        enabledModels
          .filter((model) => model.providerId === providerId)
          .map((model) => ({
            id: model.id,
            label: model.name || model.model || getModelDisplayName(model.id),
            group: providerId,
          })),
      )
    // Matched against what the row shows, the id behind it, and the provider
    // group it sits under — typing a provider's name narrows to its models.
    const normalizedQuery = query.trim().toLocaleLowerCase()
    const visibleOptions =
      normalizedQuery.length === 0
        ? modelOptions
        : modelOptions.filter((model) =>
            [model.label, model.id, model.group ?? ''].some((text) =>
              text.toLocaleLowerCase().includes(normalizedQuery),
            ),
          )
    const orderedGroups = Array.from(
      new Set(visibleOptions.map((model) => model.group ?? '')),
    )
    const orderedModelIds = visibleOptions.map((model) => model.id)

    // 触发器上显示的当前模型文案
    const getCurrentModelDisplay = () => {
      if (externalOptions) {
        return (
          modelOptions.find((model) => model.id === selectedModelId)?.label ??
          selectedModelId
        )
      }
      const currentModel = settings.chatModels.find(
        (m) => m.id === selectedModelId,
      )
      if (currentModel) {
        // 优先显示「展示名称」，其次调用ID(model)，最后回退到内部 id。
        // 不附加 provider：下拉列表已按 provider 分组，触发器上重复它只会挤占模型名的宽度
        return currentModel.name || currentModel.model || currentModel.id
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

    // Opening puts the caret in the search field — a long list is searched
    // more often than stepped through — while the list still opens scrolled
    // to the current model.
    useEffect(() => {
      if (!isOpen) return
      const ownerWindow = getNodeWindow(triggerRef.current)
      const rafId = ownerWindow.requestAnimationFrame(() => {
        const opened = contentRef.current?.dataset.side
        if (
          opened === 'top' ||
          opened === 'bottom' ||
          opened === 'left' ||
          opened === 'right'
        ) {
          setOpenedSide(opened)
        }
        itemRefs.current[selectedModelId]?.scrollIntoView({
          block: 'center',
          inline: 'nearest',
        })
        searchRef.current?.focus({ preventScroll: true })
      })
      return () => ownerWindow.cancelAnimationFrame(rafId)
      // Only on opening: re-running while open would pull focus back to the
      // field from a row being navigated with the keyboard.
    }, [isOpen])

    const focusEdgeItem = (edge: 'first' | 'last') => {
      const id =
        edge === 'first'
          ? orderedModelIds[0]
          : orderedModelIds[orderedModelIds.length - 1]
      const target = id ? itemRefs.current[id] : null
      if (!target) return
      target.focus({ preventScroll: true })
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }

    const selectModel = (modelId: string) => {
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
    }

    /**
     * Keeps typing in the search field. A Radix menu reads every printable
     * key as typeahead and moves focus to the matching row, so keys are
     * stopped here, in the capture phase, before the menu sees them: in the
     * field, everything but the keys that navigate out of it; on a row (the
     * pointer moved focus there), a printable key or Backspace sends focus
     * back to the field, where the key then lands.
     */
    const handleContentKeyDownCapture = (event: React.KeyboardEvent) => {
      const search = searchRef.current
      if (!search) return
      if (event.target === search) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          event.stopPropagation()
          focusEdgeItem(event.key === 'ArrowDown' ? 'first' : 'last')
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          event.stopPropagation()
          const first = orderedModelIds[0]
          if (first === undefined) return
          selectModel(first)
          handleOpenChange(false)
          return
        }
        if (event.key === 'Escape' || event.key === 'Tab') return
        event.stopPropagation()
        return
      }
      const printable =
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      if (printable || event.key === 'Backspace') {
        search.focus({ preventScroll: true })
        event.stopPropagation()
      }
    }

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

    function handleOpenChange(open: boolean) {
      setIsOpen(open)
      if (!open) {
        setQuery('')
        setOpenedSide(null)
      }
      onMenuOpenChange?.(open)
    }

    return (
      <DropdownMenu.Root open={isOpen} onOpenChange={handleOpenChange}>
        <DropdownMenu.Trigger
          ref={setTriggerRef}
          className="yolo-chat-input-model-select"
          onKeyDown={handleTriggerKeyDown}
          disabled={disabled}
        >
          <div className="yolo-chat-input-model-select__label yolo-chat-input-model-select__model-name">
            {getCurrentModelDisplay()}
          </div>
          <div className="yolo-chat-input-model-select__icon">
            {isOpen ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          </div>
        </DropdownMenu.Trigger>

        <YoloDropdownContent
          ref={contentRef}
          container={container}
          anchorRef={triggerRef}
          variant={popover?.variant ?? 'default'}
          minWidth={popover?.minWidth}
          maxWidth={popover?.maxWidth}
          maxHeight={popover?.maxHeight}
          className={
            popover?.className
              ? `yolo-model-select-popover ${popover.className}`
              : 'yolo-model-select-popover'
          }
          side={openedSide ?? side}
          // Once the side is held, nothing may move it — collision avoidance
          // is what flips it. The list only ever shrinks while open.
          avoidCollisions={openedSide === null}
          sideOffset={sideOffset}
          align={align}
          alignOffset={alignOffset}
          collisionPadding={8}
          loop
          onKeyDownCapture={handleContentKeyDownCapture}
          onPointerDownOutside={(e) => {
            // 阻止事件冒泡，防止关闭父容器
            e.stopPropagation()
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            triggerRef.current?.focus({ preventScroll: true })
          }}
        >
          {/* First in the DOM; the stylesheet moves it to whichever edge
              faces the trigger (data-side), the edge that stays put while
              filtering shrinks the list. */}
          <div className="yolo-model-select-search">
            <Search size={12} strokeWidth={2} />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              // No aria-label: Obsidian turns it into a hover tooltip that
              // would repeat the placeholder (AGENTS.md).
              placeholder={t('chat.modelSelect.searchPlaceholder', '搜索模型')}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <DropdownMenu.RadioGroup
            className="yolo-model-select-list"
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
            onValueChange={selectModel}
          >
            {visibleOptions.length === 0 ? (
              <div className="yolo-model-select-empty">
                {t('chat.modelSelect.empty', '没有匹配的模型')}
              </div>
            ) : null}
            {(() => {
              let runningIndex = 0

              return orderedGroups.flatMap((group, groupIndex) => {
                const groupModels = visibleOptions.filter(
                  (model) => (model.group ?? '') === group,
                )
                if (groupModels.length === 0) return []

                const groupHeader = group ? (
                  <DropdownMenu.Label
                    key={`label-${group}`}
                    className="yolo-popover-group-label"
                  >
                    {group}
                  </DropdownMenu.Label>
                ) : null

                const items = groupModels.map((modelOption, index) => {
                  runningIndex += 1
                  return (
                    <DropdownMenu.RadioItem
                      key={modelOption.id}
                      className="yolo-popover-item"
                      value={modelOption.id}
                      ref={(element) => {
                        itemRefs.current[modelOption.id] = element
                      }}
                      data-model-id={modelOption.id}
                      data-first-item={
                        runningIndex === 1 && index === 0 ? 'true' : undefined
                      }
                    >
                      <span className="yolo-popover-item__label">
                        {modelOption.label}
                      </span>
                      {defaultOption?.id === modelOption.id ? (
                        <span className="yolo-model-select-default-badge">
                          {defaultOption.badgeLabel}
                        </span>
                      ) : null}
                      {defaultOption ? (
                        <button
                          type="button"
                          className="yolo-model-select-default-action"
                          tabIndex={-1}
                          // Radix selects the row on pointerup/click; stop
                          // both so the button only toggles the default.
                          onPointerDown={(event) => event.stopPropagation()}
                          onPointerUp={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            defaultOption.onToggle(modelOption.id)
                          }}
                        >
                          {defaultOption.id === modelOption.id
                            ? defaultOption.removeLabel
                            : defaultOption.setLabel}
                        </button>
                      ) : null}
                      <DropdownMenu.ItemIndicator className="yolo-popover-item__indicator">
                        <Check size={12} />
                      </DropdownMenu.ItemIndicator>
                    </DropdownMenu.RadioItem>
                  )
                })

                return [
                  ...(groupHeader ? [groupHeader] : []),
                  ...items,
                  ...(groupIndex < orderedGroups.length - 1
                    ? [
                        <DropdownMenu.Separator
                          key={`sep-${group || groupIndex}`}
                          className="yolo-popover-group-separator"
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
