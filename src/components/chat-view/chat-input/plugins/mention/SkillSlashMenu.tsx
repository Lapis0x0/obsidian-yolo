/*
 * `/` 斜杠菜单的双栏面板呈现层 —— 设计代号 C2（docs/design/skill-menu-c-
 * description-variants.html 的 C2 小节）。只服务 SkillSlashPlugin，与
 * CascadingTypeaheadMenu.tsx（@ 提及菜单的级联子面板逻辑）完全独立、互不
 * 依赖：后者继续原样服务 MentionPlugin。
 *
 * 三种呈现态：
 * - 根态（无查询词）+ 容器够宽：左栏三个类别（技能/快捷指令/命令）+ 右栏当前
 *   类别的条目列表。
 * - 根态 + 容器过窄（< NARROW_CONTAINER_THRESHOLD_PX）：隐藏左栏，退化为单列
 *   列表，按类别分组、组前带小标题。
 * - 过滤态（有查询词）：单列扁平列表，不分类别、不分组（排序逻辑在
 *   SkillSlashPlugin 里，这里只负责渲染 flatOptions）。
 *
 * 键盘模型（根态 + 有左栏）：单焦点、双区。←/→ 在左栏（rail）和右栏（list）
 * 之间移动焦点；焦点在 rail 时 ↑/↓ 切类别、Enter/→ 进入 list；焦点在 list 时
 * ↑/↓/Enter/Tab 走 LexicalMenu 默认的行导航与选择（displayOptions 就是右栏
 * 列表本身）。过滤态或窄容器降级态没有左栏，全部按键返回 false 放行给默认
 * 行为 / 编辑器移动光标。
 */
import {
  type MutableRefObject,
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
} from '../shared/LexicalMenu'

// 与 LexicalMenu.ts 里 SKILL_SLASH_MENU_WIDTH_PX（470）配套：面板的实际渲染
// 宽度由外层 popover 钳在 min(470px, 输入框宽度)，这里只是「低于多少判定为
// 放不下双栏」的阈值，两个数字不要求相等。
const NARROW_CONTAINER_THRESHOLD_PX = 420

export type SkillSlashCategoryKey = 'skill' | 'snippet' | 'command'

export type SkillSlashCategory<TOption extends MenuOption> = {
  key: SkillSlashCategoryKey
  label: string
  icon: ReactNode
  options: TOption[]
}

export type SkillSlashItemProps<TOption extends MenuOption> = {
  id: string
  index: number
  isSelected: boolean
  onClick: () => void
  onMouseEnter: () => void
  option: TOption
}

type SkillSlashRenderMenuProps<TOption extends MenuOption> = {
  anchorElementRef: MutableRefObject<HTMLElement | null>
  itemProps: Parameters<MenuRenderFn<TOption>>[1]
  menuContainer?: HTMLElement | null
  emptyLabel: string
  renderItem: (props: SkillSlashItemProps<TOption>) => ReactNode
}

type UseSkillSlashMenuConfig<TOption extends MenuOption> = {
  /** 三个类别固定顺序：技能 / 快捷指令 / 命令。 */
  categories: SkillSlashCategory<TOption>[]
  /** 非 null 时代表处于过滤态：直接渲染这个扁平列表，忽略 categories 的分栏/分组。 */
  flatOptions: TOption[] | null
  placement: 'top' | 'bottom'
}

export function useSkillSlashMenu<TOption extends MenuOption>({
  categories,
  flatOptions,
  placement,
}: UseSkillSlashMenuConfig<TOption>): {
  displayOptions: TOption[]
  customKeyHandlers: CustomKeyHandlers
  renderMenu: (
    props: SkillSlashRenderMenuProps<TOption>,
  ) => ReturnType<MenuRenderFn<TOption>>
  reset: () => void
} {
  const isFiltered = flatOptions !== null
  const firstCategoryKey = categories[0]?.key ?? 'skill'

  const [activeCategoryKey, setActiveCategoryKey] =
    useState<SkillSlashCategoryKey>(firstCategoryKey)
  const [isNarrow, setIsNarrow] = useState(false)
  // 单焦点双区模型的焦点位置。初始在 list：打开菜单后 ↓↓+Enter 直接选第一个
  // 类别（技能）里的条目是最高频路径，进 rail 属于主动动作（按 ←）。
  const [focusZone, setFocusZone] = useState<'rail' | 'list'>('list')

  const panelRef = useRef<HTMLDivElement | null>(null)
  const activeCategoryKeyRef = useRef(activeCategoryKey)
  const focusZoneRef = useRef(focusZone)
  const setHighlightedIndexRef = useRef<((index: number) => void) | null>(null)

  useEffect(() => {
    activeCategoryKeyRef.current = activeCategoryKey
  }, [activeCategoryKey])

  useEffect(() => {
    focusZoneRef.current = focusZone
  }, [focusZone])

  // 类别集合变化（如 skills/snippets 列表更新）时，若当前激活类别不再存在，
  // 回退到第一个类别，避免停留在一个已消失的 key 上。
  useEffect(() => {
    if (!categories.some((category) => category.key === activeCategoryKey)) {
      setActiveCategoryKey(firstCategoryKey)
    }
  }, [activeCategoryKey, categories, firstCategoryKey])

  // 过滤态结束、回到根态时，重新从第一个类别（技能）开始，而不是停留在上次
  // 过滤前碰巧激活的类别——根态的类别栏应当每次都从头呈现。
  // 只在 isFiltered 由 true 变 false 的那次重置，不应因 firstCategoryKey 本身
  // 变化而重置，所以依赖数组只放 isFiltered。
  useEffect(() => {
    if (!isFiltered) {
      setActiveCategoryKey(firstCategoryKey)
    }
    // 进入或离开过滤态都把焦点收回 list：过滤态没有 rail 可聚焦。
    setFocusZone('list')
  }, [isFiltered])

  // 测量面板实际渲染宽度，决定是否降级为无左栏的单列分组列表。宽度已经被
  // LexicalMenu.ts 钳在 min(470px, 输入框宽度)，所以这里读到的就是「双栏布局
  // 真正可用的宽度」，不会和内部选择的布局形成测量循环。
  useLayoutEffect(() => {
    if (isFiltered) return
    const panel = panelRef.current
    if (!panel) return
    const ownerWindow = panel.ownerDocument.defaultView ?? window

    const measure = () => {
      const width = panel.getBoundingClientRect().width
      if (width > 0) {
        setIsNarrow(width < NARROW_CONTAINER_THRESHOLD_PX)
      }
    }

    measure()

    const ResizeObserverCtor = ownerWindow.ResizeObserver
    if (ResizeObserverCtor) {
      const observer = new ResizeObserverCtor(() => measure())
      observer.observe(panel)
      return () => observer.disconnect()
    }

    ownerWindow.addEventListener('resize', measure)
    return () => ownerWindow.removeEventListener('resize', measure)
  }, [isFiltered])

  const activeCategory = useMemo(
    () =>
      categories.find((category) => category.key === activeCategoryKey) ??
      categories[0] ??
      null,
    [activeCategoryKey, categories],
  )

  const displayOptions = useMemo<TOption[]>(() => {
    if (isFiltered) return flatOptions ?? []
    if (isNarrow) return categories.flatMap((category) => category.options)
    return activeCategory?.options ?? []
  }, [activeCategory, categories, flatOptions, isFiltered, isNarrow])

  const switchCategory = useCallback((key: SkillSlashCategoryKey) => {
    if (activeCategoryKeyRef.current === key) return
    setActiveCategoryKey(key)
    setHighlightedIndexRef.current?.(0)
  }, [])

  const customKeyHandlers = useMemo<CustomKeyHandlers>(() => {
    const isTwoPane = !isFiltered && !isNarrow && categories.length > 1
    const moveCategory = (direction: -1 | 1) => {
      const index = categories.findIndex(
        (category) => category.key === activeCategoryKeyRef.current,
      )
      const nextIndex =
        (index + direction + categories.length) % categories.length
      switchCategory(categories[nextIndex].key)
    }

    return {
      onArrowLeft: (event) => {
        if (event.isComposing || !isTwoPane) return false
        setFocusZone('rail')
        return true
      },
      onArrowRight: (event) => {
        if (event.isComposing || !isTwoPane) return false
        setFocusZone('list')
        return true
      },
      onArrowUp: (event) => {
        if (event.isComposing || !isTwoPane) return false
        if (focusZoneRef.current !== 'rail') return false
        moveCategory(-1)
        return true
      },
      onArrowDown: (event) => {
        if (event.isComposing || !isTwoPane) return false
        if (focusZoneRef.current !== 'rail') return false
        moveCategory(1)
        return true
      },
      onEnter: () => {
        if (!isTwoPane || focusZoneRef.current !== 'rail') return false
        setFocusZone('list')
        return true
      },
    }
  }, [categories, isFiltered, isNarrow, switchCategory])

  // firstCategoryKey 读取的是关闭那一刻的值；reset 语义上只在菜单关闭时调用，
  // 不需要因 categories 引用变化而重建这个 callback，所以依赖数组留空。
  const reset = useCallback(() => {
    setActiveCategoryKey(firstCategoryKey)
    setIsNarrow(false)
    setFocusZone('list')
    setHighlightedIndexRef.current = null
  }, [])

  const renderMenu = ({
    anchorElementRef,
    itemProps,
    menuContainer,
    emptyLabel,
    renderItem,
  }: SkillSlashRenderMenuProps<TOption>): ReturnType<MenuRenderFn<TOption>> => {
    const portalTarget = menuContainer ?? anchorElementRef.current
    if (!portalTarget) return null
    if (isFiltered && displayOptions.length === 0) return null

    const { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex } =
      itemProps
    setHighlightedIndexRef.current = setHighlightedIndex

    const showRail = !isFiltered && !isNarrow && categories.length > 1
    const showGroups = !isFiltered && isNarrow

    return createPortal(
      <div className="yolo-skill-slash-popover" data-placement={placement}>
        <div
          ref={panelRef}
          className={`yolo-popover-surface yolo-popover-surface--smart-space yolo-skill-slash-panel${
            showRail ? ' yolo-skill-slash-panel--two-pane' : ''
          }`}
          data-focus-zone={showRail ? focusZone : 'list'}
        >
          {showRail && (
            <div className="yolo-skill-slash-rail" role="tablist">
              {categories.map((category) => (
                <button
                  key={category.key}
                  type="button"
                  role="tab"
                  aria-selected={category.key === activeCategoryKey}
                  className={`yolo-skill-slash-rail-item${
                    category.key === activeCategoryKey ? ' is-active' : ''
                  }`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => switchCategory(category.key)}
                >
                  {category.icon}
                  <span className="yolo-skill-slash-rail-item-label">
                    {category.label}
                  </span>
                  <span className="yolo-skill-slash-rail-item-count">
                    {category.options.length}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="yolo-skill-slash-list" role="listbox">
            {showGroups ? (
              (() => {
                let flatIndex = 0
                return categories.map((category) => {
                  if (category.options.length === 0) return null
                  const rows = category.options.map((option) => {
                    const index = flatIndex
                    flatIndex += 1
                    return renderItem({
                      id: `typeahead-item-${index}`,
                      index,
                      isSelected: selectedIndex === index,
                      onClick: () => selectOptionAndCleanUp(option),
                      onMouseEnter: () => setHighlightedIndex(index),
                      option,
                    })
                  })
                  return (
                    <div key={category.key} className="yolo-skill-slash-group">
                      <div className="yolo-skill-slash-group-header">
                        {category.label}
                      </div>
                      {rows}
                    </div>
                  )
                })
              })()
            ) : displayOptions.length > 0 ? (
              displayOptions.map((option, index) =>
                renderItem({
                  id: `typeahead-item-${index}`,
                  index,
                  isSelected: selectedIndex === index,
                  onClick: () => selectOptionAndCleanUp(option),
                  onMouseEnter: () => setHighlightedIndex(index),
                  option,
                }),
              )
            ) : (
              <div className="yolo-smart-space-mention-empty">{emptyLabel}</div>
            )}
          </div>
        </div>
      </div>,
      portalTarget,
    )
  }

  return { displayOptions, customKeyHandlers, renderMenu, reset }
}
