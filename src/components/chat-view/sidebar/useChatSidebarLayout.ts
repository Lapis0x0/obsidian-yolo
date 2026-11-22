import type { App } from 'obsidian'
import { type RefObject, useCallback, useEffect, useState } from 'react'

import { getNodeWindow } from '../../../utils/dom/window-context'

/**
 * - column：常驻一列
 * - rail：宽度够但用户收起了，只剩一条窄轨
 * - drawer：宽度不够，侧边栏隐藏，按需以抽屉盖在对话上
 */
export type ChatSidebarLayout = 'column' | 'rail' | 'drawer'

/**
 * 对话外壳至少这么宽才常驻侧边栏：侧边栏一列加上一段读起来不局促的对话区。
 * 右侧栏里的 YOLO Chat 通常窄于它，于是走抽屉。
 */
const SIDEBAR_COLUMN_MIN_SHELL_WIDTH = 760

const COLLAPSED_STORAGE_KEY = 'yolo-chat-sidebar-collapsed'

export function useChatSidebarLayout(
  app: App,
  shellRef: RefObject<HTMLElement | null>,
) {
  const [isWide, setIsWide] = useState(false)
  const [collapsed, setCollapsed] = useState(
    () => app.loadLocalStorage(COLLAPSED_STORAGE_KEY) === 'true',
  )
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
    const element = shellRef.current
    if (!element) return
    const update = (width: number) => {
      setIsWide(width >= SIDEBAR_COLUMN_MIN_SHELL_WIDTH)
    }
    update(element.getBoundingClientRect().width)
    const observer = new (getNodeWindow(element).ResizeObserver)((entries) => {
      const entry = entries[0]
      if (entry) update(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [shellRef])

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

  return { layout, drawerOpen, toggle, closeDrawer }
}
