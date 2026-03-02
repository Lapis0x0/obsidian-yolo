/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license.
 * Original source: https://github.com/facebook/lexical
 *
 * Modified from the original code
 * - Added custom positioning logic for menu placement
 */

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { mergeRegister } from '@lexical/utils'
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  CommandListenerPriority,
  KEY_ARROW_DOWN_COMMAND,
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

export type MenuRenderFn<TOption extends MenuOption> = (
  anchorElementRef: MutableRefObject<HTMLElement | null>,
  itemProps: {
    selectedIndex: number | null
    selectOptionAndCleanUp: (option: TOption) => void
    setHighlightedIndex: (index: number) => void
    options: TOption[]
  },
  matchingString: string | null,
) => ReactPortal | ReactJSX.Element | null

const scrollIntoViewIfNeeded = (target: HTMLElement) => {
  const typeaheadContainerNode = document.getElementById('typeahead-menu')
  if (!typeaheadContainerNode) {
    return
  }

  const typeaheadRect = typeaheadContainerNode.getBoundingClientRect()

  if (typeaheadRect.top + typeaheadRect.height > window.innerHeight) {
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
    return document.body
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
  return document.body
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
      const rootElement = editor.getRootElement()
      const rootScrollParent =
        rootElement != null
          ? getScrollParent(rootElement, false)
          : document.body
      let ticking = false
      let previousIsInView = isTriggerVisibleInNearestScrollContainer(
        targetElement,
        rootScrollParent,
      )
      const handleScroll = function () {
        if (!ticking) {
          window.requestAnimationFrame(function () {
            onReposition()
            ticking = false
          })
          ticking = true
        }
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
      const resizeObserver = new ResizeObserver(onReposition)
      window.addEventListener('resize', onReposition)
      document.addEventListener('scroll', handleScroll, {
        capture: true,
        passive: true,
      })
      resizeObserver.observe(targetElement)
      return () => {
        resizeObserver.unobserve(targetElement)
        window.removeEventListener('resize', onReposition)
        document.removeEventListener('scroll', handleScroll, true)
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
}): ReactJSX.Element | null {
  const [selectedIndex, setHighlightedIndex] = useState<null | number>(null)

  const matchingString = resolution.match?.matchingString

  const resolveDefaultHighlightedIndex = useCallback(() => {
    if (!options.length) {
      return null
    }
    const rawIndex = getDefaultHighlightedIndex?.(options) ?? 0
    const normalizedIndex = Number.isFinite(rawIndex) ? Math.trunc(rawIndex) : 0
    return Math.min(options.length - 1, Math.max(0, normalizedIndex))
  }, [getDefaultHighlightedIndex, options])

  const updateSelectedIndex = useCallback(
    (index: number) => {
      const rootElem = editor.getRootElement()
      if (rootElem !== null) {
        rootElem.setAttribute(
          'aria-activedescendant',
          `typeahead-item-${index}`,
        )
        setHighlightedIndex(index)
      }
    },
    [editor],
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
        KEY_ESCAPE_COMMAND,
        (payload) => {
          const event = payload
          event.preventDefault()
          event.stopImmediatePropagation()
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
    selectedIndex,
    updateSelectedIndex,
    commandPriority,
  ])

  const listItemProps = useMemo(
    () => ({
      options,
      selectOptionAndCleanUp,
      selectedIndex,
      setHighlightedIndex,
    }),
    [selectOptionAndCleanUp, selectedIndex, options],
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
  parent: HTMLElement = document.body,
  _shouldIncludePageYOffset__EXPERIMENTAL = true,
): MutableRefObject<HTMLElement> {
  const [editor] = useLexicalComposerContext()
  const anchorElementRef = useRef<HTMLElement>(document.createElement('div'))
  const positionMenu = useCallback(() => {
    // 通过动态样式类固定定位弹窗容器
    const containerDiv = anchorElementRef.current
    containerDiv.classList.remove(
      'smtcmp-menu-above',
      'smtcmp-menu-right-align',
    )

    const rootElement = editor.getRootElement()
    const menuEle = containerDiv.firstChild as HTMLElement | null

    if (rootElement !== null && resolution !== null) {
      const rect = resolution.getRect()
      const { left, top } = rect

      if (!containerDiv.isConnected) {
        if (className != null) {
          containerDiv.className = className
        }
        containerDiv.classList.add('smtcmp-typeahead-menu')
        containerDiv.setAttribute('aria-label', 'Typeahead menu')
        containerDiv.setAttribute('id', 'typeahead-menu')
        containerDiv.setAttribute('role', 'listbox')
        // defer append to reposition() so we can choose the correct parent
      }

      const reposition = () => {
        const offsetTop = 4
        const margin = 8
        const containerEl = rootElement.closest(
          '.smtcmp-chat-user-input-container, .smtcmp-quick-ask-panel',
        )

        if (containerEl) {
          // Position the menu in document.body with fixed positioning to avoid clipping by container bounds
          if (containerDiv.parentElement !== parent) {
            parent.appendChild(containerDiv)
          }

          const rect = containerEl.getBoundingClientRect()
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
          const menuLeft = rect.left - ring
          const menuWidth = rect.width + ring * 2
          const menuTop = rect.top - offsetTop

          updateDynamicStyleClass(containerDiv, 'smtcmp-typeahead-menu-pos', {
            position: 'fixed',
            left: Math.round(menuLeft),
            top: Math.round(menuTop),
            width: Math.round(menuWidth),
            zIndex: '1000',
          })

          if (menuEle) {
            const available = Math.max(margin, Math.floor(rect.top - margin))
            const isMentionPopover = menuEle.classList.contains(
              'smtcmp-smart-space-mention-popover',
            )
            if (isMentionPopover) {
              updateDynamicStyleClass(menuEle, 'smtcmp-typeahead-pop', {
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                width: '100%',
                maxWidth: 'none',
                boxSizing: 'border-box',
                overflow: 'visible',
                '--smtcmp-typeahead-available-height': `${available}px`,
              })
            } else {
              updateDynamicStyleClass(menuEle, 'smtcmp-typeahead-pop', {
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
          Math.min(left, window.innerWidth - margin),
        )
        const topPos = Math.max(margin, top - offsetTop - estimatedH)
        if (!containerDiv.isConnected) parent.append(containerDiv)
        updateDynamicStyleClass(containerDiv, 'smtcmp-typeahead-menu-pos', {
          position: 'fixed',
          left: Math.round(leftPos),
          top: Math.round(topPos),
          width: 360,
          zIndex: '1000',
        })
        // Avoid adding smtcmp-menu-above here; topPos is already computed above the caret
        if (menuEle) {
          updateDynamicStyleClass(menuEle, 'smtcmp-typeahead-pop', {
            width: '100%',
          })
          requestAnimationFrame(() => {
            const finalH = menuEle.getBoundingClientRect().height || estimatedH
            const t2 = Math.max(margin, top - offsetTop - finalH)
            updateDynamicStyleClass(containerDiv, 'smtcmp-typeahead-menu-pos', {
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
    }
  }, [editor, resolution, className, parent])

  useEffect(() => {
    const rootElement = editor.getRootElement()
    if (resolution !== null) {
      positionMenu()
      return () => {
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
      }
    }
  }, [editor, positionMenu, resolution])

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
