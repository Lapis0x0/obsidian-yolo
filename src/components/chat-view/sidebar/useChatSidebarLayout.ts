import type { App } from 'obsidian'
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'

import { getNodeWindow } from '../../../utils/dom/window-context'

/**
 * - column：常驻一列
 * - rail：宽度够但用户收起了，只剩一条窄轨
 * - drawer：宽度不够，侧边栏隐藏，按需以抽屉盖在对话上
 */
export type ChatSidebarLayout = 'column' | 'rail' | 'drawer'

/** 常驻列的默认宽度，也是双击拖拽把手回到的宽度 */
const SIDEBAR_DEFAULT_WIDTH = 260
/** 再窄，项目名和对话标题就只剩几个字 */
const SIDEBAR_MIN_WIDTH = 200
const SIDEBAR_MAX_WIDTH = 480
/** 对话区至少留这么宽，侧边栏拖宽时不能把它挤得更窄 */
const CHAT_MIN_WIDTH = 500
/**
 * 对话外壳至少这么宽才常驻侧边栏：默认宽度的侧边栏加上一段读起来不局促的
 * 对话区。右侧栏里的 YOLO Chat 通常窄于它，于是走抽屉。
 */
const SIDEBAR_COLUMN_MIN_SHELL_WIDTH = SIDEBAR_DEFAULT_WIDTH + CHAT_MIN_WIDTH

const COLLAPSED_STORAGE_KEY = 'yolo-chat-sidebar-collapsed'
const WIDTH_STORAGE_KEY = 'yolo-chat-sidebar-width'

const clampWidth = (width: number) =>
  Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)))

function readStoredWidth(app: App): number {
  const stored = Number(app.loadLocalStorage(WIDTH_STORAGE_KEY))
  return Number.isFinite(stored) && stored > 0
    ? clampWidth(stored)
    : SIDEBAR_DEFAULT_WIDTH
}

/**
 * 用到侧边栏宽度的元素：侧边栏自己，以及要按它让出位置的原生标题栏（见
 * topbar.css）。这个宽度注册成了不继承的属性（见 sidebar.css），只能逐个
 * 写在用它的元素上；也正因为不继承，拖动时每帧只重算这两个元素的样式。
 */
function widthTargets(
  shell: HTMLElement,
  sidebar: HTMLElement | null,
): HTMLElement[] {
  const header = shell
    .closest(".workspace-leaf-content[data-type='yolo-chat-view']")
    ?.querySelector<HTMLElement>(':scope > .view-header')
  return [sidebar, header].filter((el): el is HTMLElement => !!el)
}

export function useChatSidebarLayout(
  app: App,
  shellRef: RefObject<HTMLElement | null>,
) {
  const [isWide, setIsWide] = useState(false)
  const [collapsed, setCollapsed] = useState(
    () => app.loadLocalStorage(COLLAPSED_STORAGE_KEY) === 'true',
  )
  const [drawerOpen, setDrawerOpen] = useState(false)

  // 用户要的宽度，和外壳此刻能给的宽度分开记：窗口变窄时侧边栏跟着让，窗口
  // 变回来时恢复用户要的宽度。拖动时每帧都在变，只写 CSS 变量，不进 React 状态。
  const preferredWidthRef = useRef(readStoredWidth(app))
  const shellWidthRef = useRef(0)

  // 侧边栏在形态之间切换时会换一个元素，挂上时由 ref 回调登记并补写宽度
  const sidebarRef = useRef<HTMLElement | null>(null)

  const applyWidth = useCallback(() => {
    const shell = shellRef.current
    if (!shell) return
    const shellWidth = shellWidthRef.current
    // 常驻列要给对话区留出位置；抽屉盖在对话上，宽度上限交给 CSS（外壳的 85%）
    const width =
      shellWidth >= SIDEBAR_COLUMN_MIN_SHELL_WIDTH
        ? Math.max(
            SIDEBAR_MIN_WIDTH,
            Math.min(preferredWidthRef.current, shellWidth - CHAT_MIN_WIDTH),
          )
        : preferredWidthRef.current
    for (const target of widthTargets(shell, sidebarRef.current)) {
      target.setCssProps({ '--yolo-chat-sidebar-width': `${width}px` })
    }
  }, [shellRef])

  const registerSidebar = useCallback(
    (element: HTMLElement | null) => {
      sidebarRef.current = element
      applyWidth()
    },
    [applyWidth],
  )

  useEffect(() => {
    const element = shellRef.current
    if (!element) return
    const update = (width: number) => {
      shellWidthRef.current = width
      setIsWide(width >= SIDEBAR_COLUMN_MIN_SHELL_WIDTH)
      applyWidth()
    }
    update(element.getBoundingClientRect().width)
    const observer = new (getNodeWindow(element).ResizeObserver)((entries) => {
      const entry = entries[0]
      if (entry) update(entry.contentRect.width)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      for (const target of widthTargets(element, sidebarRef.current)) {
        target.style.removeProperty('--yolo-chat-sidebar-width')
      }
    }
  }, [applyWidth, shellRef])

  // 变宽后抽屉没有意义，回到窄时也不该自己弹出来
  useEffect(() => {
    if (isWide) setDrawerOpen(false)
  }, [isWide])

  const layout: ChatSidebarLayout = !isWide
    ? 'drawer'
    : collapsed
      ? 'rail'
      : 'column'

  /** 展开 / 收起常驻列，或开关抽屉，视当前形态而定。 */
  const toggle = useCallback(() => {
    if (!isWide) {
      setDrawerOpen((open) => !open)
      return
    }
    setCollapsed((previous) => {
      const next = !previous
      app.saveLocalStorage(COLLAPSED_STORAGE_KEY, next ? 'true' : null)
      return next
    })
  }, [app, isWide])

  const closeDrawer = useCallback(() => setDrawerOpen(false), [])

  const setPreferredWidth = useCallback(
    (width: number) => {
      preferredWidthRef.current = clampWidth(width)
      applyWidth()
    },
    [applyWidth],
  )

  const persistWidth = useCallback(() => {
    const width = preferredWidthRef.current
    app.saveLocalStorage(
      WIDTH_STORAGE_KEY,
      width === SIDEBAR_DEFAULT_WIDTH ? null : String(width),
    )
  }, [app])

  // 拖动起点：按下时的指针位置和侧边栏实际宽度。用指针捕获，移动和松开都
  // 落在把手上，不需要往 document 挂监听，弹出窗口里也一样。
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  const resizeHandleProps = {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return
      const sidebar = event.currentTarget.parentElement
      if (!sidebar) return
      // 不让按下拖动顺带选中文字
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      event.currentTarget.classList.add('is-dragging')
      dragRef.current = {
        startX: event.clientX,
        startWidth: sidebar.getBoundingClientRect().width,
      }
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current
      if (!drag) return
      setPreferredWidth(drag.startWidth + event.clientX - drag.startX)
    },
    onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => {
      event.currentTarget.classList.remove('is-dragging')
      if (!dragRef.current) return
      dragRef.current = null
      persistWidth()
    },
    /** 双击回到默认宽度 */
    onDoubleClick: () => {
      setPreferredWidth(SIDEBAR_DEFAULT_WIDTH)
      persistWidth()
    },
  }

  return {
    layout,
    drawerOpen,
    toggle,
    closeDrawer,
    registerSidebar,
    resizeHandleProps,
  }
}

export type ChatSidebarResizeHandleProps = ReturnType<
  typeof useChatSidebarLayout
>['resizeHandleProps']
