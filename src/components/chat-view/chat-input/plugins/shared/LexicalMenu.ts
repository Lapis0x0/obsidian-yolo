/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license.
 * Original source: https://github.com/facebook/lexical
 *
 * Modified from the original code
 * - Added custom positioning logic for menu placement
 */

import { autoUpdate } from '@floating-ui/dom'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { mergeRegister } from '@lexical/utils'
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  CommandListenerPriority,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  LexicalCommand,
  LexicalEditor,
  TextNode,
  createCommand,
} from 'lexical'
import {
  MutableRefObject,
  type ReactPortal,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { JSX as ReactJSX } from 'react/jsx-runtime'

import {
  clearDynamicStyleClass,
  updateDynamicStyleClass,
} from '../../../../../utils/dom/dynamicStyleManager'
import {
  getNodeBody,
  getNodeDocument,
  getNodeWindow,
} from '../../../../../utils/dom/window-context'

export type MenuTextMatch = {
  leadOffset: number
  matchingString: string
  replaceableString: string
}

export type MenuResolution = {
  match?: MenuTextMatch
  getRect: () => DOMRect
}

export const PUNCTUATION =
  '\\.,\\+\\*\\?\\$\\@\\|#{}\\(\\)\\^\\-\\[\\]\\\\/!%\'"~=<>_:;'

export class MenuOption {
  key: string
  ref?: MutableRefObject<HTMLElement | null>

  constructor(key: string) {
    this.key = key
    this.ref = { current: null }
    this.setRefElement = this.setRefElement.bind(this)
  }

  setRefElement(element: HTMLElement | null) {
    this.ref = { current: element }
  }
}

/**
 * 共享层（LexicalMenu/LexicalTypeaheadMenuPlugin）原本只暴露默认键盘行为；
 * MentionPlugin 需要在 ↑/↓/←/→/Enter 之前注入自己的逻辑（hover 预览子面板的
 * 跨面板焦点切换），又不能动 SkillSlashPlugin 的现有体验。这里以可选 prop 的
 * 形式给出唯一扩展点：handler 返回 true 即"已处理"，跳过默认逻辑；返回 false
 * 走原默认。SkillSlash 不传 = 完全等价旧行为。 */
export type CustomKeyHandlers = {
  onArrowUp?: (event: KeyboardEvent) => boolean
  onArrowDown?: (event: KeyboardEvent) => boolean
  onArrowLeft?: (event: KeyboardEvent) => boolean
  onArrowRight?: (event: KeyboardEvent) => boolean
  onEnter?: (event: KeyboardEvent | null) => boolean
}

export type MenuRenderFn<TOption extends MenuOption> = (
  anchorElementRef: MutableRefObject<HTMLElement | null>,
  itemProps: {
    selectedIndex: number | null
    selectOptionAndCleanUp: (option: TOption) => void
    setActiveDescendantId: (id: string | null) => void
    setHighlightedIndex: (index: number) => void
    options: TOption[]
  },
  matchingString: string | null,
) => ReactPortal | ReactJSX.Element | null

const scrollIntoViewIfNeeded = (target: HTMLElement) => {
  const ownerDocument = getNodeDocument(target)
  const ownerWindow = getNodeWindow(target)
  const typeaheadContainerNode = ownerDocument.getElementById('typeahead-menu')
  if (!typeaheadContainerNode) {
    return
  }

  const typeaheadRect = typeaheadContainerNode.getBoundingClientRect()

  if (typeaheadRect.top + typeaheadRect.height > ownerWindow.innerHeight) {
    typeaheadContainerNode.scrollIntoView({
      block: 'center',
    })
  }

  if (typeaheadRect.top < 0) {
    typeaheadContainerNode.scrollIntoView({
      block: 'center',
    })
  }

  target.scrollIntoView({ block: 'nearest' })
}

/**
 * Walk backwards along user input and forward through entity title to try
 * and replace more of the user's text with entity.
 */
function getFullMatchOffset(
  documentText: string,
  entryText: string,
  offset: number,
): number {
  let triggerOffset = offset
  for (let i = triggerOffset; i <= entryText.length; i++) {
    if (documentText.endsWith(entryText.slice(0, i))) {
      triggerOffset = i
    }
  }
  return triggerOffset
}

/**
 * Split Lexical TextNode and return a new TextNode only containing matched text.
 * Common use cases include: removing the node, replacing with a new node.
 */
function $splitNodeContainingQuery(match: MenuTextMatch): TextNode | null {
  const selection = $getSelection()
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return null
  }
  const anchor = selection.anchor
  if (anchor.type !== 'text') {
    return null
  }
  const anchorNode = anchor.getNode()
  if (!anchorNode.isSimpleText()) {
    return null
  }
  const selectionOffset = anchor.offset
  const textContent = anchorNode.getTextContent().slice(0, selectionOffset)
  const characterOffset = match.replaceableString.length
  const queryOffset = getFullMatchOffset(
    textContent,
    match.matchingString,
    characterOffset,
  )
  const startOffset = selectionOffset - queryOffset
  if (startOffset < 0) {
    return null
  }
  let newNode
  if (startOffset === 0) {
    ;[newNode] = anchorNode.splitText(selectionOffset)
  } else {
    ;[, newNode] = anchorNode.splitText(startOffset, selectionOffset)
  }

  return newNode
}

// Got from https://stackoverflow.com/a/42543908/2013580
export function getScrollParent(
  element: HTMLElement,
  includeHidden: boolean,
): HTMLElement | HTMLBodyElement {
  let style = getComputedStyle(element)
  const excludeStaticParent = style.position === 'absolute'
  const overflowRegex = includeHidden ? /(auto|scroll|hidden)/ : /(auto|scroll)/
  if (style.position === 'fixed') {
    return getNodeBody(element)
  }
  for (
    let parent: HTMLElement | null = element;
    (parent = parent.parentElement);

  ) {
    style = getComputedStyle(parent)
    if (excludeStaticParent && style.position === 'static') {
      continue
    }
    if (
      overflowRegex.test(style.overflow + style.overflowY + style.overflowX)
    ) {
      return parent
    }
  }
  return getNodeBody(element)
}

function isTriggerVisibleInNearestScrollContainer(
  targetElement: HTMLElement,
  containerElement: HTMLElement,
): boolean {
  const tRect = targetElement.getBoundingClientRect()
  const cRect = containerElement.getBoundingClientRect()
  return tRect.top > cRect.top && tRect.top < cRect.bottom
}

// Reposition the menu on scroll, window resize, and element resize.
export function useDynamicPositioning(
  resolution: MenuResolution | null,
  targetElement: HTMLElement | null,
  onReposition: () => void,
  onVisibilityChange?: (isInView: boolean) => void,
) {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    if (targetElement != null && resolution != null) {
      const ownerDocument = getNodeDocument(targetElement)
      const rootElement = editor.getRootElement()
      const rootScrollParent =
        rootElement != null
          ? getScrollParent(rootElement, false)
          : getNodeBody(targetElement)

      // Position tracking: 由 Floating UI 的 autoUpdate 统一处理 resize、
      // 祖先 scroll、ResizeObserver,以及 animationFrame 轮询
      // (后者是关键 —— Quick Ask 浮窗拖拽改的是内联 left/top,既不触发 resize
      // 也不触发 scroll,只能靠 rAF 比对 getBoundingClientRect 才能感知)。
      const cleanupAutoUpdate = autoUpdate(
        targetElement,
        targetElement,
        onReposition,
        { animationFrame: true },
      )

      // Visibility tracking: trigger 滚出最近 scroll container 时关闭菜单。
      // autoUpdate 不负责这个语义,所以单独保留一个轻量 scroll handler。
      let previousIsInView = isTriggerVisibleInNearestScrollContainer(
        targetElement,
        rootScrollParent,
      )
      const handleVisibilityScroll = () => {
        const isInView = isTriggerVisibleInNearestScrollContainer(
          targetElement,
          rootScrollParent,
        )
        if (isInView !== previousIsInView) {
          previousIsInView = isInView
          if (onVisibilityChange != null) {
            onVisibilityChange(isInView)
          }
        }
      }
      ownerDocument.addEventListener('scroll', handleVisibilityScroll, {
        capture: true,
        passive: true,
      })

      return () => {
        cleanupAutoUpdate()
        ownerDocument.removeEventListener(
          'scroll',
          handleVisibilityScroll,
          true,
        )
      }
    }
  }, [targetElement, editor, onVisibilityChange, onReposition, resolution])
}

export const SCROLL_TYPEAHEAD_OPTION_INTO_VIEW_COMMAND: LexicalCommand<{
  index: number
  option: MenuOption
}> = createCommand('SCROLL_TYPEAHEAD_OPTION_INTO_VIEW_COMMAND')

export function LexicalMenu<TOption extends MenuOption>({
  close,
  editor,
  anchorElementRef,
  resolution,
  options,
  menuRenderFn,
  onSelectOption,
  shouldSplitNodeWithQuery = false,
  commandPriority = COMMAND_PRIORITY_LOW,
  getDefaultHighlightedIndex,
  customKeyHandlers,
}: {
  close: () => void
  editor: LexicalEditor
  anchorElementRef: MutableRefObject<HTMLElement>
  resolution: MenuResolution
  options: TOption[]
  shouldSplitNodeWithQuery?: boolean
  menuRenderFn: MenuRenderFn<TOption>
  onSelectOption: (
    option: TOption,
    textNodeContainingQuery: TextNode | null,
    closeMenu: () => void,
    matchingString: string,
  ) => void
  commandPriority?: CommandListenerPriority
  getDefaultHighlightedIndex?: (options: TOption[]) => number
  customKeyHandlers?: CustomKeyHandlers
}): ReactJSX.Element | null {
  const [selectedIndex, setHighlightedIndex] = useState<null | number>(null)

  // 把最新的 customKeyHandlers 放进 ref，避免每次 props 变化都重新注册 lexical
  // command（注册成本不大但会改变命令优先级排序，徒增不确定性）。
  const customKeyHandlersRef = useRef<CustomKeyHandlers | undefined>(
    customKeyHandlers,
  )
  useLayoutEffect(() => {
    customKeyHandlersRef.current = customKeyHandlers
  }, [customKeyHandlers])

  const matchingString = resolution.match?.matchingString

  const resolveDefaultHighlightedIndex = useCallback(() => {
    if (!options.length) {
      return null
    }
    const rawIndex = getDefaultHighlightedIndex?.(options) ?? 0
    const normalizedIndex = Number.isFinite(rawIndex) ? Math.trunc(rawIndex) : 0
    return Math.min(options.length - 1, Math.max(0, normalizedIndex))
  }, [getDefaultHighlightedIndex, options])

  const setActiveDescendantId = useCallback(
    (id: string | null) => {
      const rootElement = editor.getRootElement()
      if (rootElement !== null) {
        if (id === null) {
          rootElement.removeAttribute('aria-activedescendant')
        } else {
          rootElement.setAttribute('aria-activedescendant', id)
        }
      }
    },
    [editor],
  )

  const updateSelectedIndex = useCallback(
    (index: number) => {
      if (editor.getRootElement() === null) return
      setActiveDescendantId(`typeahead-item-${index}`)
      setHighlightedIndex(index)
    },
    [editor, setActiveDescendantId],
  )

  useEffect(() => {
    void matchingString
    const nextIndex = resolveDefaultHighlightedIndex()
    if (nextIndex === null) {
      setHighlightedIndex(null)
      return
    }
    updateSelectedIndex(nextIndex)
  }, [matchingString, resolveDefaultHighlightedIndex, updateSelectedIndex])

  const selectOptionAndCleanUp = useCallback(
    (selectedEntry: TOption) => {
      editor.update(() => {
        const textNodeContainingQuery =
          resolution.match != null && shouldSplitNodeWithQuery
            ? $splitNodeContainingQuery(resolution.match)
            : null

        onSelectOption(
          selectedEntry,
          textNodeContainingQuery,
          close,
          resolution.match ? resolution.match.matchingString : '',
        )
      })
    },
    [editor, shouldSplitNodeWithQuery, resolution.match, onSelectOption, close],
  )

  useEffect(() => {
    return () => {
      const rootElem = editor.getRootElement()
      if (rootElem !== null) {
        rootElem.removeAttribute('aria-activedescendant')
      }
    }
  }, [editor])

  useLayoutEffect(() => {
    if (!options.length) {
      setHighlightedIndex(null)
    } else if (selectedIndex === null || selectedIndex >= options.length) {
      const nextIndex = resolveDefaultHighlightedIndex()
      if (nextIndex !== null) {
        updateSelectedIndex(nextIndex)
      }
    }
  }, [
    options,
    selectedIndex,
    resolveDefaultHighlightedIndex,
    updateSelectedIndex,
  ])

  useEffect(() => {
    return mergeRegister(
      editor.registerCommand(
        SCROLL_TYPEAHEAD_OPTION_INTO_VIEW_COMMAND,
        ({ option }) => {
          if (option.ref?.current != null) {
            scrollIntoViewIfNeeded(option.ref.current)
            return true
          }

          return false
        },
        commandPriority,
      ),
    )
  }, [editor, commandPriority])

  useEffect(() => {
    return mergeRegister(
      editor.registerCommand<KeyboardEvent>(
        KEY_ARROW_DOWN_COMMAND,
        (payload) => {
          const event = payload
          const customHandler = customKeyHandlersRef.current?.onArrowDown
          if (customHandler && customHandler(event)) {
            event.preventDefault()
            event.stopImmediatePropagation()
            return true
          }
          // IME 合成期放行 Lexical 默认行为，避免抢占中文候选词导航。
          if (event?.isComposing) return false
          if (options?.length && selectedIndex !== null) {
            const newSelectedIndex =
              selectedIndex !== options.length - 1 ? selectedIndex + 1 : 0
            updateSelectedIndex(newSelectedIndex)
            const option = options[newSelectedIndex]
            if (option.ref?.current != null) {
              editor.dispatchCommand(
                SCROLL_TYPEAHEAD_OPTION_INTO_VIEW_COMMAND,
                {
                  index: newSelectedIndex,
                  option,
                },
              )
            }
            event.preventDefault()
            event.stopImmediatePropagation()
          }
          return true
        },
        commandPriority,
      ),
      editor.registerCommand<KeyboardEvent>(
        KEY_ARROW_UP_COMMAND,
        (payload) => {
          const event = payload
          const customHandler = customKeyHandlersRef.current?.onArrowUp
          if (customHandler && customHandler(event)) {
            event.preventDefault()
            event.stopImmediatePropagation()
            return true
          }
          // IME 合成期放行 Lexical 默认行为，避免抢占中文候选词导航。
          if (event?.isComposing) return false
          if (options?.length && selectedIndex !== null) {
            const newSelectedIndex =
              selectedIndex !== 0 ? selectedIndex - 1 : options.length - 1
            updateSelectedIndex(newSelectedIndex)
            const option = options[newSelectedIndex]
            if (option.ref?.current != null) {
              scrollIntoViewIfNeeded(option.ref.current)
            }
            event.preventDefault()
            event.stopImmediatePropagation()
          }
          return true
        },
        commandPriority,
      ),
      editor.registerCommand<KeyboardEvent>(
        KEY_ARROW_LEFT_COMMAND,
        (payload) => {
          const event = payload
          const customHandler = customKeyHandlersRef.current?.onArrowLeft
          if (customHandler && customHandler(event)) {
            event.preventDefault()
            event.stopImmediatePropagation()
            return true
          }
          // 没有自定义 handler 处理 → 走 Lexical 默认（光标移动），不拦截。
          return false
        },
        commandPriority,
      ),
      editor.registerCommand<KeyboardEvent>(
        KEY_ARROW_RIGHT_COMMAND,
        (payload) => {
          const event = payload
          const customHandler = customKeyHandlersRef.current?.onArrowRight
          if (customHandler && customHandler(event)) {
            event.preventDefault()
            event.stopImmediatePropagation()
            return true
          }
          return false
        },
        commandPriority,
      ),
      editor.registerCommand<KeyboardEvent>(
        KEY_ESCAPE_COMMAND,
        (payload) => {
          const event = payload
          event.preventDefault()
          event.stopImmediatePropagation()

          if (shouldSplitNodeWithQuery && resolution.match != null) {
            const match = resolution.match
            editor.update(() => {
              const textNodeContainingQuery = $splitNodeContainingQuery(match)
              textNodeContainingQuery?.remove()
            })
          }

          close()
          return true
        },
        commandPriority,
      ),
      editor.registerCommand<KeyboardEvent>(
        KEY_TAB_COMMAND,
        (payload) => {
          const event = payload
          if (
            options === null ||
            selectedIndex === null ||
            options[selectedIndex] == null
          ) {
            return false
          }
          event.preventDefault()
          event.stopImmediatePropagation()
          selectOptionAndCleanUp(options[selectedIndex])
          return true
        },
        commandPriority,
      ),
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event: KeyboardEvent | null) => {
          const customHandler = customKeyHandlersRef.current?.onEnter
          if (customHandler && customHandler(event)) {
            if (event !== null) {
              event.preventDefault()
              event.stopImmediatePropagation()
            }
            return true
          }
          // IME 合成期放行 Lexical 默认行为，避免抢占中文候选词确认。
          if (event?.isComposing) return false
          if (
            options === null ||
            selectedIndex === null ||
            options[selectedIndex] == null
          ) {
            return false
          }
          if (event !== null) {
            event.preventDefault()
            event.stopImmediatePropagation()
          }
          selectOptionAndCleanUp(options[selectedIndex])
          return true
        },
        commandPriority,
      ),
    )
  }, [
    selectOptionAndCleanUp,
    close,
    editor,
    options,
    resolution.match,
    selectedIndex,
    shouldSplitNodeWithQuery,
    updateSelectedIndex,
    commandPriority,
  ])

  const listItemProps = useMemo(
    () => ({
      options,
      selectOptionAndCleanUp,
      selectedIndex,
      setActiveDescendantId,
      setHighlightedIndex: updateSelectedIndex,
    }),
    [
      options,
      selectOptionAndCleanUp,
      selectedIndex,
      setActiveDescendantId,
      updateSelectedIndex,
    ],
  )

  return menuRenderFn(
    anchorElementRef,
    listItemProps,
    resolution.match ? resolution.match.matchingString : '',
  )
}

export function useMenuAnchorRef(
  resolution: MenuResolution | null,
  setResolution: (r: MenuResolution | null) => void,
  className?: string,
  parent?: HTMLElement,
  _shouldIncludePageYOffset__EXPERIMENTAL = true,
): MutableRefObject<HTMLElement> {
  const [editor] = useLexicalComposerContext()
  const anchorElementRef = useRef<HTMLElement>(document.createElement('div'))
  // 缓存上一次写入 containerDiv 的位置,autoUpdate animationFrame 模式下每帧都会
  // 调用 positionMenu;若坐标未变则跳过 updateDynamicStyleClass,避免样式 churn。
  // 菜单关闭时(useEffect cleanup)必须重置为 null —— containerDiv 会被 remove,
  // 重新打开时若坐标恰好相同会被错误跳过,导致新 containerDiv 无内联样式。
  const lastWrittenPositionRef = useRef<{
    left: number
    top: number
    width: number
  } | null>(null)
  const positionMenu = useCallback(() => {
    const rootElement = editor.getRootElement()
    if (rootElement === null || resolution === null) {
      return
    }

    const ownerDocument = getNodeDocument(rootElement)
    const ownerWindow = getNodeWindow(rootElement)
    const portalParent = parent ?? getNodeBody(rootElement)
    let containerDiv = anchorElementRef.current

    if (containerDiv.ownerDocument !== ownerDocument) {
      if (containerDiv.isConnected) {
        clearDynamicStyleClass(containerDiv)
        containerDiv.remove()
      }
      containerDiv = ownerDocument.createElement('div')
      anchorElementRef.current = containerDiv
    }

    // 通过动态样式类固定定位弹窗容器
    containerDiv.classList.remove('yolo-menu-above', 'yolo-menu-right-align')

    const menuEle = containerDiv.firstChild as HTMLElement | null

    const rect = resolution.getRect()
    const { left, top } = rect

    if (!containerDiv.isConnected) {
      if (className != null) {
        containerDiv.className = className
      }
      containerDiv.classList.add('yolo-typeahead-menu')
      containerDiv.setAttribute('id', 'typeahead-menu')
      containerDiv.setAttribute('role', 'listbox')
      // defer append to reposition() so we can choose the correct parent
    }

    const reposition = () => {
      const offsetTop = 4
      const margin = 8
      const containerEl = rootElement.closest(
        '.yolo-chat-user-input-container, .yolo-quick-ask-input-row',
      )
      const centeredChatContainer = rootElement.closest(
        '.yolo-chat-container--centered',
      )
      const isCenteredChatContainer = Boolean(centeredChatContainer)
      const centeredChatTypeaheadMaxWidth = centeredChatContainer
        ? getComputedStyle(centeredChatContainer)
            .getPropertyValue('--yolo-chat-typeahead-max-width')
            .trim() || '560px'
        : '560px'

      if (containerEl) {
        // Position the menu in the current window body to avoid clipping by container bounds
        if (containerDiv.parentElement !== portalParent) {
          portalParent.appendChild(containerDiv)
        }

        const rect = containerEl.getBoundingClientRect()
        const boundaryRect =
          rootElement
            .closest('.yolo-chat-container')
            ?.getBoundingClientRect() ?? rect
        const cs = getComputedStyle(containerEl)

        // Calculate focus ring thickness from box-shadow
        const boxShadow = cs.boxShadow || ''
        let ring = 0
        const matches = boxShadow.match(/0px\s+0px\s+0px\s+([0-9.]+)px/g)
        if (matches) {
          for (const m of matches) {
            const match = m.match(/([0-9.]+)px$/)
            const value = match ? match[1] : '0'
            const n = parseFloat(value) || 0
            if (n > ring) ring = n
          }
        }

        // Position menu to align with the outermost edge of the focus ring
        const menuLeft = Math.round(rect.left - ring)
        const menuWidth = Math.round(rect.width + ring * 2)
        const menuTop = Math.round(rect.top - offsetTop)

        // 与上次写入的坐标相同则跳过,避免 animationFrame 模式下每帧重写样式。
        // menuEle 也要复检 —— 它的 absolute 定位完全依赖 containerDiv,
        // 但 menuEle 的内容/可见性可能变,所以这里只跳过 containerDiv 的写。
        const last = lastWrittenPositionRef.current
        const positionUnchanged =
          last !== null &&
          last.left === menuLeft &&
          last.top === menuTop &&
          last.width === menuWidth
        if (!positionUnchanged) {
          lastWrittenPositionRef.current = {
            left: menuLeft,
            top: menuTop,
            width: menuWidth,
          }
          updateDynamicStyleClass(containerDiv, 'yolo-typeahead-menu-pos', {
            position: 'fixed',
            left: menuLeft,
            top: menuTop,
            width: menuWidth,
            zIndex: '1000',
          })
        }

        if (menuEle) {
          const available = Math.max(margin, Math.floor(rect.top - margin))
          const isMentionPopover = menuEle.classList.contains(
            'yolo-smart-space-mention-popover',
          )
          if (isMentionPopover) {
            const mentionPopoverWidth = isCenteredChatContainer
              ? `min(100%, ${centeredChatTypeaheadMaxWidth})`
              : '100%'
            updateDynamicStyleClass(menuEle, 'yolo-typeahead-pop', {
              position: 'absolute',
              left: 0,
              right: isCenteredChatContainer ? 'auto' : 0,
              bottom: 0,
              width: mentionPopoverWidth,
              maxWidth: mentionPopoverWidth,
              boxSizing: 'border-box',
              overflow: 'visible',
              '--yolo-typeahead-available-height': `${available}px`,
              '--yolo-typeahead-boundary-left': `${Math.round(
                boundaryRect.left,
              )}px`,
              '--yolo-typeahead-boundary-right': `${Math.round(
                boundaryRect.right,
              )}px`,
            })
          } else {
            updateDynamicStyleClass(menuEle, 'yolo-typeahead-pop', {
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              width: '100%',
              maxWidth: 'none',
              boxSizing: 'border-box',
              overflowY: 'auto',
              maxHeight: available,
            })
          }
          // Limit height to available space above the input
          // Top cleared automatically by omission
        }
        return
      }

      // Fallback: position fixed above the caret rect
      const estimatedH = 260
      const leftPos = Math.max(
        margin,
        Math.min(left, ownerWindow.innerWidth - margin),
      )
      const topPos = Math.max(margin, top - offsetTop - estimatedH)
      if (!containerDiv.isConnected) {
        portalParent.append(containerDiv)
      }
      updateDynamicStyleClass(containerDiv, 'yolo-typeahead-menu-pos', {
        position: 'fixed',
        left: Math.round(leftPos),
        top: Math.round(topPos),
        width: 360,
        zIndex: '1000',
      })
      // Avoid adding yolo-menu-above here; topPos is already computed above the caret
      if (menuEle) {
        updateDynamicStyleClass(menuEle, 'yolo-typeahead-pop', {
          width: '100%',
        })
        ownerWindow.requestAnimationFrame(() => {
          const finalH = menuEle.getBoundingClientRect().height || estimatedH
          const t2 = Math.max(margin, top - offsetTop - finalH)
          updateDynamicStyleClass(containerDiv, 'yolo-typeahead-menu-pos', {
            position: 'fixed',
            left: Math.round(leftPos),
            top: Math.round(t2),
            width: 360,
            zIndex: '1000',
          })
        })
      }
    }

    reposition()
    anchorElementRef.current = containerDiv
    rootElement.setAttribute('aria-controls', 'typeahead-menu')
  }, [editor, resolution, className, parent])

  const cleanupMenu = useCallback(() => {
    const rootElement = editor.getRootElement()
    if (rootElement !== null) {
      rootElement.removeAttribute('aria-controls')
    }

    const containerDiv = anchorElementRef.current
    if (containerDiv?.isConnected) {
      clearDynamicStyleClass(containerDiv)
      containerDiv.remove()
    }
    if (containerDiv?.firstChild instanceof HTMLElement) {
      clearDynamicStyleClass(containerDiv.firstChild)
    }
    // 重置位置缓存:containerDiv 已被 remove,下次打开必须重新写样式。
    lastWrittenPositionRef.current = null
  }, [editor])

  useLayoutEffect(() => {
    if (resolution !== null) {
      positionMenu()
    } else {
      cleanupMenu()
    }
  }, [cleanupMenu, positionMenu, resolution])

  useEffect(() => {
    return cleanupMenu
  }, [cleanupMenu])

  const onVisibilityChange = useCallback(
    (isInView: boolean) => {
      if (resolution !== null) {
        if (!isInView) {
          setResolution(null)
        }
      }
    },
    [resolution, setResolution],
  )

  useDynamicPositioning(
    resolution,
    anchorElementRef.current,
    positionMenu,
    onVisibilityChange,
  )

  return anchorElementRef
}

export type TriggerFn = (
  text: string,
  editor: LexicalEditor,
) => MenuTextMatch | null
