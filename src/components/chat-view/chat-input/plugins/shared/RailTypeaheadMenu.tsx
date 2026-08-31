/*
 * 输入框内 typeahead 菜单（`/` 斜杠菜单与 `@` 提及菜单）共用的双栏面板呈现层。
 *
 * 三种呈现态：
 * - 根态（无查询词）+ 容器够宽：左栏竖排类别 rail + 右栏当前类别的条目列表。
 * - 根态 + 容器过窄（< NARROW_CONTAINER_THRESHOLD_PX）：同样的信息结构转 90°，
 *   类别变成顶部横排 tabs（只留文字，图标与计数由 CSS 收起），下方仍是当前类别
 *   的条目列表。不是降级成拍平列表——那会把 `@` 变成六十多行的长队。
 * - 过滤态（有查询词）：单列扁平列表，不分类别（排序与跨类别打分在各自的
 *   plugin 里，这里只负责渲染 flatOptions）。
 *
 * 键盘模型按类别选择器的朝向分派，与 ARIA tablist 的惯例一致：
 * - 竖排 rail（宽）：单焦点、双区，打开时焦点在 rail。←/→ 在两栏之间移动焦点；
 *   焦点在 rail 时 ↑/↓ 切类别、Enter/→ 进入 list；焦点在 list 时 ↑/↓/Enter/Tab
 *   走 LexicalMenu 默认的行导航与选择。
 * - 横排 tabs（窄）：没有焦点分区。←/→ 直接切类别，↑/↓/Enter 恒归列表。
 * - 过滤态或只有一个类别时没有选择器，全部按键返回 false 放行给默认行为 /
 *   编辑器移动光标。
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
} from './LexicalMenu'

// 与 LexicalMenu.ts 里 RAIL_MENU_WIDTH_PX（470）配套：面板的实际渲染宽度由
// 外层 popover 钳在 min(470px, 输入框宽度)，这里只是「低于多少判定为放不下
// 双栏」的阈值，两个数字不要求相等。
const NARROW_CONTAINER_THRESHOLD_PX = 420

export type RailMenuCategory<TOption extends MenuOption> = {
  key: string
  label: string
  icon: ReactNode
  options: TOption[]
  /**
   * rail 上显示的条目数。省略即不显示——文件/文件夹这类被截断的搜索结果，
   * 写出来的数字只会是谎言。
   */
  count?: number
}

export type RailMenuItemProps<TOption extends MenuOption> = {
  id: string
  index: number
  isSelected: boolean
  onClick: () => void
  onMouseEnter: () => void
  option: TOption
}

type RailMenuRenderProps<TOption extends MenuOption> = {
  anchorElementRef: MutableRefObject<HTMLElement | null>
  itemProps: Parameters<MenuRenderFn<TOption>>[1]
  menuContainer?: HTMLElement | null
  emptyLabel: string
  renderItem: (props: RailMenuItemProps<TOption>) => ReactNode
}

type UseRailTypeaheadMenuConfig<TOption extends MenuOption> = {
  /** 类别顺序即 rail 顺序；首个类别是打开菜单时的默认激活类别。 */
  categories: RailMenuCategory<TOption>[]
  /** 非 null 时代表处于过滤态：直接渲染这个扁平列表，忽略 categories 的分栏/分组。 */
  flatOptions: TOption[] | null
  placement: 'top' | 'bottom'
}

/**
 * 双栏菜单里的一行。两个 plugin 共用同一套行结构与类名，只在图标、文案、
 * 尾部指示（勾选等）上有差别，保证 `/` 与 `@` 的行视觉是同一套语言。
 *
 * inlineMeta：把描述与标题排在同一行（文件路径、模型 provider 这类短 meta），
 * 否则描述换行到标题下方（技能/命令的整句描述）。
 */
export function RailMenuRow<TOption extends MenuOption>({
  id,
  isSelected,
  onClick,
  onMouseEnter,
  option,
  icon,
  name,
  description,
  inlineMeta = false,
  trailing,
}: RailMenuItemProps<TOption> & {
  icon: ReactNode
  name: string
  description?: string | null
  inlineMeta?: boolean
  trailing?: ReactNode
}) {
  return (
    <button
      type="button"
      className={`yolo-rail-menu-row${
        inlineMeta ? ' yolo-rail-menu-row--inline-meta' : ''
      }`}
      ref={(el) => option.setRefElement(el)}
      role="option"
      aria-selected={isSelected}
      id={id}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      data-highlighted={isSelected ? 'true' : undefined}
    >
      {icon}
      <span className="yolo-rail-menu-row-text">
        <span className="yolo-rail-menu-row-name">{name}</span>
        {description ? (
          <span className="yolo-rail-menu-row-desc">{description}</span>
        ) : null}
      </span>
      {trailing}
    </button>
  )
}

export function useRailTypeaheadMenu<TOption extends MenuOption>({
  categories,
  flatOptions,
  placement,
}: UseRailTypeaheadMenuConfig<TOption>): {
  displayOptions: TOption[]
  customKeyHandlers: CustomKeyHandlers
  renderMenu: (
    props: RailMenuRenderProps<TOption>,
  ) => ReturnType<MenuRenderFn<TOption>>
  reset: () => void
} {
  const isFiltered = flatOptions !== null
  const firstCategoryKey = categories[0]?.key ?? ''

  const [activeCategoryKey, setActiveCategoryKey] = useState(firstCategoryKey)
  const [isNarrow, setIsNarrow] = useState(false)
  // 单焦点双区模型的焦点位置。初始在 rail：根态的第一个决定是「哪一类」，先落在
  // 左栏读起来才和布局一致；→ 或 Enter 进入右栏选条目。窄容器降级态与过滤态
  // 没有 rail，另由下面的 effect 收回 list。
  const [focusZone, setFocusZone] = useState<'rail' | 'list'>('rail')

  // 面板节点用 state 而不是 ref 持有：菜单打开时 queryString 是同步 setState、
  // resolution 却在 startTransition 里（见 LexicalTypeaheadMenuPlugin），所以
  // 「isFiltered 变 false」这一帧面板还没挂载。若测量 effect 只依赖 isFiltered，
  // 首次打开必然测空并早退，且之后不再重试——窄容器降级会永远不生效。
  const [panelEl, setPanelEl] = useState<HTMLDivElement | null>(null)
  const activeCategoryKeyRef = useRef(activeCategoryKey)
  const focusZoneRef = useRef(focusZone)
  const setHighlightedIndexRef = useRef<((index: number) => void) | null>(null)

  useEffect(() => {
    activeCategoryKeyRef.current = activeCategoryKey
  }, [activeCategoryKey])

  useEffect(() => {
    focusZoneRef.current = focusZone
  }, [focusZone])

  // 类别集合变化（如 skills/助手列表更新）时，若当前激活类别不再存在，
  // 回退到第一个类别，避免停留在一个已消失的 key 上。
  useEffect(() => {
    if (!categories.some((category) => category.key === activeCategoryKey)) {
      setActiveCategoryKey(firstCategoryKey)
    }
  }, [activeCategoryKey, categories, firstCategoryKey])

  // 过滤态结束、回到根态时，重新从第一个类别开始，而不是停留在上次过滤前
  // 碰巧激活的类别——根态的类别栏应当每次都从头呈现。
  // 只在 isFiltered 由 true 变 false 的那次重置，不应因 firstCategoryKey 本身
  // 变化而重置，所以依赖数组只放 isFiltered。
  useEffect(() => {
    if (!isFiltered) {
      setActiveCategoryKey(firstCategoryKey)
    }
    // 过滤态没有 rail 可聚焦，焦点收回 list；退回根态则重新落在 rail。
    setFocusZone(isFiltered ? 'list' : 'rail')
  }, [isFiltered])

  // 测量面板实际渲染宽度，决定是否降级为无左栏的单列分组列表。宽度已经被
  // LexicalMenu.ts 钳在 min(470px, 输入框宽度)，所以这里读到的就是「双栏布局
  // 真正可用的宽度」，不会和内部选择的布局形成测量循环。
  useLayoutEffect(() => {
    if (isFiltered || !panelEl) return
    const ownerWindow = panelEl.ownerDocument.defaultView ?? window

    const measure = () => {
      const width = panelEl.getBoundingClientRect().width
      if (width > 0) {
        setIsNarrow(width < NARROW_CONTAINER_THRESHOLD_PX)
      }
    }

    measure()

    const ResizeObserverCtor = ownerWindow.ResizeObserver
    if (ResizeObserverCtor) {
      const observer = new ResizeObserverCtor(() => measure())
      observer.observe(panelEl)
      return () => observer.disconnect()
    }

    ownerWindow.addEventListener('resize', measure)
    return () => ownerWindow.removeEventListener('resize', measure)
  }, [isFiltered, panelEl])

  const activeCategory = useMemo(
    () =>
      categories.find((category) => category.key === activeCategoryKey) ??
      categories[0] ??
      null,
    [activeCategoryKey, categories],
  )

  // 宽窄两种根态渲染的都是「当前类别的条目」，只是类别选择器的方向不同，
  // 所以列表内容与 isNarrow 无关。
  const displayOptions = useMemo<TOption[]>(
    () => (isFiltered ? (flatOptions ?? []) : (activeCategory?.options ?? [])),
    [activeCategory, flatOptions, isFiltered],
  )

  const switchCategory = useCallback((key: string) => {
    if (activeCategoryKeyRef.current === key) return
    setActiveCategoryKey(key)
    setHighlightedIndexRef.current?.(0)
  }, [])

  const customKeyHandlers = useMemo<CustomKeyHandlers>(() => {
    const hasSelector = !isFiltered && categories.length > 1
    // 竖排 rail 与横排 tabs 的键位按各自朝向分派，这也是 ARIA tablist 的惯例：
    // 竖排用 ↑/↓ 走类别（←/→ 留给「在两栏之间移动焦点」），横排用 ←/→ 走类别、
    // ↑/↓ 直接归列表，没有焦点分区可言。
    const isTwoPane = hasSelector && !isNarrow
    const isTabs = hasSelector && isNarrow
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
        if (event.isComposing || !hasSelector) return false
        if (isTabs) {
          moveCategory(-1)
          return true
        }
        setFocusZone('rail')
        return true
      },
      onArrowRight: (event) => {
        if (event.isComposing || !hasSelector) return false
        if (isTabs) {
          moveCategory(1)
          return true
        }
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
    setFocusZone('rail')
    setHighlightedIndexRef.current = null
  }, [])

  const renderMenu = ({
    anchorElementRef,
    itemProps,
    menuContainer,
    emptyLabel,
    renderItem,
  }: RailMenuRenderProps<TOption>): ReturnType<MenuRenderFn<TOption>> => {
    const portalTarget = menuContainer ?? anchorElementRef.current
    if (!portalTarget) return null
    if (isFiltered && displayOptions.length === 0) return null

    const { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex } =
      itemProps
    setHighlightedIndexRef.current = setHighlightedIndex

    // 鼠标移到右栏条目上即把焦点交给 list：否则焦点留在 rail 时，右栏高亮被
    // 主动压低（见 CSS），悬停会看起来没有任何反馈。
    const focusListItem = (index: number) => {
      setFocusZone('list')
      setHighlightedIndex(index)
    }

    const hasSelector = !isFiltered && categories.length > 1
    const showRail = hasSelector && !isNarrow
    const showTabs = hasSelector && isNarrow

    return createPortal(
      <div className="yolo-rail-menu-popover" data-placement={placement}>
        <div
          ref={setPanelEl}
          className={`yolo-popover-surface yolo-popover-surface--continuation yolo-rail-menu-panel${
            showRail ? ' yolo-rail-menu-panel--two-pane' : ''
          }${showTabs ? ' yolo-rail-menu-panel--tabs' : ''}`}
          // 焦点分区只存在于竖排 rail 的双栏布局；横排 tabs 下焦点恒在列表。
          data-focus-zone={showRail ? focusZone : 'list'}
        >
          {hasSelector && (
            <div
              className={`yolo-rail-menu-rail${
                showTabs ? ' yolo-rail-menu-rail--horizontal' : ''
              }`}
              role="tablist"
              aria-orientation={showTabs ? 'horizontal' : 'vertical'}
            >
              {categories.map((category) => (
                <button
                  key={category.key}
                  type="button"
                  role="tab"
                  aria-selected={category.key === activeCategoryKey}
                  className={`yolo-rail-menu-rail-item${
                    category.key === activeCategoryKey ? ' is-active' : ''
                  }`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => switchCategory(category.key)}
                >
                  {category.icon}
                  <span className="yolo-rail-menu-rail-item-label">
                    {category.label}
                  </span>
                  {category.count !== undefined && (
                    <span className="yolo-rail-menu-rail-item-count">
                      {category.count}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="yolo-rail-menu-list" role="listbox">
            {displayOptions.length > 0 ? (
              displayOptions.map((option, index) =>
                renderItem({
                  id: `typeahead-item-${index}`,
                  index,
                  isSelected: selectedIndex === index,
                  onClick: () => selectOptionAndCleanUp(option),
                  onMouseEnter: () => focusListItem(index),
                  option,
                }),
              )
            ) : (
              <div className="yolo-rail-menu-empty">{emptyLabel}</div>
            )}
          </div>
        </div>
      </div>,
      portalTarget,
    )
  }

  return { displayOptions, customKeyHandlers, renderMenu, reset }
}
