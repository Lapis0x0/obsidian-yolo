import { type App, Platform, Scope } from 'obsidian'
import { useEffect, useRef } from 'react'
import { flushSync } from 'react-dom'

import {
  type ChatConversationMetadata,
  getChatConversationOrigin,
} from '../../../database/json/chat/types'
import {
  MOTION_DURATION_ENTER_S,
  MOTION_EASE_OUT_CSS,
} from '../../../styles/tokens/motion'
import type { ChatProject } from '../../../types/project.types'
import {
  getSortKeyAfterMove,
  selectProjectConversations,
  sortUserChatList,
} from '../chat-history-list'

/**
 * 侧边栏里拖动对话：在所在的那一组里拖动排序（置顶、其余对话、某个项目里的
 * 对话各是一组，组与组之间不混排），拖到项目上放进项目，把项目里的对话拖到
 * 下面的对话列表上移出项目。
 *
 * 拖动过程完全不经过 React：按下时量好这一组每一行的位置和各个放下目标的
 * 范围，之后指针每移动一次只算出落点（同组的行按位置排好，比一比中心线），
 * 落点变了才给需要让位的几行写 transform；被拖的行自己用 transform 跟着指针
 * 走。松手时才通知 React 一次（写 sortKey，或移进、移出项目），并在同一帧里
 * 撤掉所有 transform，画面不跳。用 dnd-kit 的话，指针每移动一次都会让所有
 * 可排序的行重渲染一遍，快速拖动时一直掉帧。
 *
 * 行和目标都用 data 属性标出（见下面的常量），React 不管这些属性，拖动中
 * 列表因为别的原因重渲染（比如流式回复刷新运行状态）也不会把它们冲掉。
 * 触屏上长按已经留给对话的操作菜单，不开拖动。
 */

/** 对话所在的那一组：置顶、其余对话，或某个项目里的对话 */
export type ConversationSortGroup =
  | 'pinned'
  | 'conversations'
  | `project:${string}`

export const projectSortGroup = (projectId: string): ConversationSortGroup =>
  `project:${projectId}`

/** 可拖动的行上的属性 */
export const sortableRowAttributes = (
  conversationId: string,
  group: ConversationSortGroup,
) => ({
  'data-sort-id': conversationId,
  'data-sort-group': group,
})

/** 放下目标：项目（项目条目上，值是项目 id）、对话列表（移出项目） */
export const DROP_PROJECT_ATTRIBUTE = 'data-drop-project'
export const DROP_HISTORY_ATTRIBUTE = 'data-drop-history'

const DRAG_DISTANCE_PX = 5
/** 指针离滚动区上下边缘这么近时自动滚动，越近越快 */
const AUTO_SCROLL_EDGE_PX = 40
const AUTO_SCROLL_MAX_SPEED_PX = 16
/** 拖到项目或对话列表上时，被拖的行缩小并往下让一点，露出高亮的目标 */
const MOVING_OUT_OFFSET = { x: 14, y: 18 }
const MOVING_OUT_SCALE = 0.9

type DropTarget = {
  /** 项目 id；移出项目为 null */
  projectId: string | null
  element: HTMLElement
  left: number
  right: number
  /** 滚动内容坐标 */
  top: number
  bottom: number
}

type DragSession = {
  pointerId: number
  row: HTMLElement
  conversationId: string
  group: ConversationSortGroup
  /** 同组的行，按显示顺序 */
  rows: HTMLElement[]
  /** 各行中心线，滚动内容坐标 */
  centers: number[]
  fromIndex: number
  /** 相邻两行的间距，让位时移动这么多 */
  slot: number
  targets: DropTarget[]
  containerTop: number
  containerBottom: number
  startContentY: number
  pointerX: number
  pointerY: number
  /** 当前落点（在除去被拖行之后的列表里的位置） */
  index: number
  over: DropTarget | null
  frame: number | null
  scope: Scope
}

const groupProjectId = (group: ConversationSortGroup) =>
  group.startsWith('project:') ? group.slice('project:'.length) : null

/** 一组对话的完整列表（不截断、不折叠），按显示顺序 */
function getGroupList(
  chatList: readonly ChatConversationMetadata[],
  projects: readonly ChatProject[],
  group: ConversationSortGroup,
): ChatConversationMetadata[] {
  const projectId = groupProjectId(group)
  if (projectId !== null) return selectProjectConversations(chatList, projectId)
  // 和 ChatHistoryList 的过滤同义：不在项目里，或所在的项目已被删除
  const projectIds = new Set(projects.map((project) => project.id))
  const pinned = group === 'pinned'
  return sortUserChatList(
    chatList.filter(
      (chat) =>
        getChatConversationOrigin(chat) === 'user' &&
        (!chat.projectId || !projectIds.has(chat.projectId)) &&
        Boolean(chat.isPinned) === pinned,
    ),
  )
}

/**
 * 被拖的对话放在 above 和 below 两行之间（这两行是页面上看得到的邻居，
 * 可能都不存在）时的新 sortKey。页面上一组可能只显示了一部分（项目只列前
 * 几个，列表折叠了更早的），所以在完整列表里找邻居。
 */
function getDroppedSortKey(
  list: readonly ChatConversationMetadata[],
  conversationId: string,
  aboveId: string | null,
  belowId: string | null,
): number | null {
  const fromIndex = list.findIndex((chat) => chat.id === conversationId)
  if (fromIndex === -1) return null
  const rest = list.filter((chat) => chat.id !== conversationId)
  const toIndex = aboveId
    ? rest.findIndex((chat) => chat.id === aboveId) + 1
    : belowId
      ? rest.findIndex((chat) => chat.id === belowId)
      : 0
  return getSortKeyAfterMove(list, fromIndex, Math.max(0, toIndex))
}

export function useSidebarConversationSort({
  app,
  scrollElement,
  chatList,
  projects,
  onMoveToProject,
  onReorder,
}: {
  app: App
  /** 侧边栏的滚动区：行和放下目标都在里面 */
  scrollElement: HTMLElement | null
  chatList: readonly ChatConversationMetadata[]
  projects: readonly ChatProject[]
  onMoveToProject: (conversationId: string, projectId: string | null) => unknown
  onReorder: (conversationId: string, sortKey: number) => unknown
}) {
  // 拖动跨越多次渲染，读的都是松手那一刻的数据
  const latestRef = useRef({ chatList, projects, onMoveToProject, onReorder })
  latestRef.current = { chatList, projects, onMoveToProject, onReorder }

  useEffect(() => {
    const container = scrollElement
    if (!container || Platform.isMobile) return
    const doc = container.ownerDocument
    const win = doc.defaultView
    if (!win) return

    const duration = () =>
      win.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 0
        : MOTION_DURATION_ENTER_S * 1000
    const transition = () => `transform ${duration()}ms ${MOTION_EASE_OUT_CSS}`

    let pending: {
      pointerId: number
      row: HTMLElement
      x: number
      y: number
    } | null = null
    let session: DragSession | null = null
    let settleTimer: number | null = null

    const toContentY = (clientY: number, s: DragSession) =>
      clientY - s.containerTop + container.scrollTop

    const stopListening = () => {
      doc.removeEventListener('pointermove', handlePointerMove, true)
      doc.removeEventListener('pointerup', handlePointerUp, true)
      doc.removeEventListener('pointercancel', handlePointerCancel, true)
      win.removeEventListener('blur', handlePointerCancel)
    }

    // 拖完松手，浏览器还会在行上派发一次 click，会把刚拖完的对话打开
    const swallowNextClick = () => {
      const swallow = (event: MouseEvent) => {
        event.stopPropagation()
        event.preventDefault()
      }
      win.addEventListener('click', swallow, { capture: true, once: true })
      win.setTimeout(
        () => win.removeEventListener('click', swallow, { capture: true }),
        0,
      )
    }

    const setOver = (s: DragSession, over: DropTarget | null) => {
      if (s.over === over) return
      s.over?.element.removeAttribute('data-drop-active')
      over?.element.setAttribute('data-drop-active', '')
      s.row.setAttribute('data-sort-state', over ? 'moving-out' : 'lifted')
      s.over = over
    }

    /** 让同组的行给落点 index 让出位置 */
    const shiftRows = (s: DragSession, index: number) => {
      if (s.index === index) return
      s.index = index
      s.rows.forEach((row, i) => {
        if (i === s.fromIndex) return
        const shift =
          i < s.fromIndex && i >= index
            ? s.slot
            : i > s.fromIndex && i <= index
              ? -s.slot
              : 0
        row.setCssProps({ transform: shift ? `translate(0, ${shift}px)` : '' })
      })
    }

    const update = () => {
      const s = session
      if (!s) return
      s.frame = null
      const contentY = toContentY(s.pointerY, s)
      // 只跟着指针上下走：项目和对话都在同一列里，左右移动没有用处，还会
      // 让这一行超出滚动区被裁掉
      const dy = contentY - s.startContentY

      const over =
        s.targets.find(
          (target) =>
            s.pointerX >= target.left &&
            s.pointerX <= target.right &&
            contentY >= target.top &&
            contentY <= target.bottom,
        ) ?? null
      setOver(s, over)

      if (over) {
        s.row.setCssProps({
          transform: `translate(${MOVING_OUT_OFFSET.x}px, ${
            dy + MOVING_OUT_OFFSET.y
          }px) scale(${MOVING_OUT_SCALE})`,
        })
        // 放进或移出项目时，原来那一组恢复原样
        shiftRows(s, s.fromIndex)
      } else {
        s.row.setCssProps({ transform: `translate(0, ${dy}px)` })
        const center = s.centers[s.fromIndex] + dy
        let index = 0
        s.centers.forEach((c, i) => {
          if (i !== s.fromIndex && c < center) index += 1
        })
        shiftRows(s, index)
      }

      // 指针贴近滚动区上下边缘时自动滚动；滚动改变了内容坐标，下一帧接着算
      const speed =
        s.pointerY < s.containerTop + AUTO_SCROLL_EDGE_PX
          ? -AUTO_SCROLL_MAX_SPEED_PX *
            Math.min(
              1,
              (s.containerTop + AUTO_SCROLL_EDGE_PX - s.pointerY) /
                AUTO_SCROLL_EDGE_PX,
            )
          : s.pointerY > s.containerBottom - AUTO_SCROLL_EDGE_PX
            ? AUTO_SCROLL_MAX_SPEED_PX *
              Math.min(
                1,
                (s.pointerY - (s.containerBottom - AUTO_SCROLL_EDGE_PX)) /
                  AUTO_SCROLL_EDGE_PX,
              )
            : 0
      if (speed !== 0) {
        const before = container.scrollTop
        container.scrollBy(0, speed)
        if (container.scrollTop !== before) schedule()
      }
    }

    const schedule = () => {
      if (session && session.frame === null) {
        session.frame = win.requestAnimationFrame(update)
      }
    }

    const start = (p: NonNullable<typeof pending>) => {
      const group = p.row.dataset.sortGroup as ConversationSortGroup
      const rows = Array.from(
        container.querySelectorAll<HTMLElement>('[data-sort-group]'),
      ).filter((row) => row.dataset.sortGroup === group)
      const fromIndex = rows.indexOf(p.row)
      if (fromIndex === -1) return
      const box = container.getBoundingClientRect()
      const contentY = (clientY: number) =>
        clientY - box.top + container.scrollTop
      const centers = rows.map((row) => {
        const rect = row.getBoundingClientRect()
        return contentY(rect.top + rect.height / 2)
      })
      const slot =
        rows.length > 1
          ? fromIndex < rows.length - 1
            ? centers[fromIndex + 1] - centers[fromIndex]
            : centers[fromIndex] - centers[fromIndex - 1]
          : p.row.getBoundingClientRect().height

      const sourceProjectId = groupProjectId(group)
      const targets: DropTarget[] = []
      const addTarget = (element: HTMLElement, projectId: string | null) => {
        const rect = element.getBoundingClientRect()
        targets.push({
          projectId,
          element,
          left: rect.left,
          right: rect.right,
          top: contentY(rect.top),
          bottom: contentY(rect.bottom),
        })
      }
      container
        .querySelectorAll<HTMLElement>(`[${DROP_PROJECT_ATTRIBUTE}]`)
        .forEach((element) => {
          const projectId = element.getAttribute(DROP_PROJECT_ATTRIBUTE)
          if (projectId && projectId !== sourceProjectId) {
            addTarget(element, projectId)
          }
        })
      if (sourceProjectId !== null) {
        const history = container.querySelector<HTMLElement>(
          `[${DROP_HISTORY_ATTRIBUTE}]`,
        )
        if (history) addTarget(history, null)
      }

      const scope = new Scope(app.keymap.scope)
      scope.register([], 'Escape', () => {
        cancel()
        return false
      })
      app.keymap.pushScope(scope)

      session = {
        pointerId: p.pointerId,
        row: p.row,
        conversationId: p.row.dataset.sortId ?? '',
        group,
        rows,
        centers,
        fromIndex,
        slot,
        targets,
        containerTop: box.top,
        containerBottom: box.bottom,
        startContentY: contentY(p.y),
        pointerX: p.x,
        pointerY: p.y,
        index: fromIndex,
        over: null,
        frame: null,
        scope,
      }
      win.getSelection()?.removeAllRanges()
      // 指针捕获在滚动区上：拖动期间指针事件都落在滚动区，下面的行收不到
      // 悬停和移入移出（行的悬停会改列表的焦点行，每掠过一行就让整个列表
      // 重渲染）。滚轮不受捕获影响，拖动时照样能滚
      container.setPointerCapture(p.pointerId)
      container.setAttribute('data-sorting', '')
      p.row.setAttribute('data-sort-state', 'lifted')
      rows.forEach((row) => {
        row.setCssProps({ transition: row === p.row ? 'none' : transition() })
      })
      schedule()
    }

    /**
     * 收尾：在同一个任务里先让 React 提交（flushSync），再撤掉所有
     * transform。新顺序和撤掉位移在同一帧画出来，行不会闪回原位再跳过去。
     * 撤的时候不能带过渡，否则会从让位的位置再滑一次。
     */
    const finish = (commit?: () => void) => {
      const s = session
      if (!s) return
      session = null
      if (s.frame !== null) win.cancelAnimationFrame(s.frame)
      app.keymap.popScope(s.scope)
      stopListening()
      if (commit) flushSync(commit)
      s.over?.element.removeAttribute('data-drop-active')
      for (const row of s.rows) {
        row.setCssProps({ transition: 'none' })
        row.setCssProps({ transform: '' })
        row.removeAttribute('data-sort-state')
      }
      void container.offsetHeight
      for (const row of s.rows) row.setCssProps({ transition: '' })
      container.removeAttribute('data-sorting')
      if (container.hasPointerCapture(s.pointerId)) {
        container.releasePointerCapture(s.pointerId)
      }
    }

    /** 被拖的行滑到 offset 落定后再收尾 */
    const settle = (s: DragSession, offset: number, commit?: () => void) => {
      if (s.frame !== null) {
        win.cancelAnimationFrame(s.frame)
        s.frame = null
      }
      stopListening()
      const ms = duration()
      if (ms === 0) {
        finish(commit)
        return
      }
      s.row.setCssProps({ transition: transition() })
      s.row.setCssProps({ transform: `translate(0, ${offset}px)` })
      settleTimer = win.setTimeout(() => {
        settleTimer = null
        finish(commit)
      }, ms)
    }

    const cancel = () => {
      const s = session
      if (!s) return
      setOver(s, null)
      shiftRows(s, s.fromIndex)
      settle(s, 0)
    }

    const drop = () => {
      const s = session
      if (!s) return
      swallowNextClick()
      const { onMoveToProject, onReorder, chatList, projects } =
        latestRef.current
      if (s.over) {
        const projectId = s.over.projectId
        stopListening()
        finish(() => void onMoveToProject(s.conversationId, projectId))
        return
      }
      if (s.index === s.fromIndex) {
        settle(s, 0)
        return
      }
      const rest = s.rows.filter((_, i) => i !== s.fromIndex)
      const sortKey = getDroppedSortKey(
        getGroupList(chatList, projects, s.group),
        s.conversationId,
        rest[s.index - 1]?.dataset.sortId ?? null,
        rest[s.index]?.dataset.sortId ?? null,
      )
      const offset = (s.index - s.fromIndex) * s.slot
      settle(
        s,
        offset,
        sortKey === null
          ? undefined
          : () => void onReorder(s.conversationId, sortKey),
      )
    }

    function handlePointerMove(event: PointerEvent) {
      if (session) {
        if (event.pointerId !== session.pointerId) return
        session.pointerX = event.clientX
        session.pointerY = event.clientY
        schedule()
        return
      }
      const p = pending
      if (!p || event.pointerId !== p.pointerId) return
      if (
        Math.hypot(event.clientX - p.x, event.clientY - p.y) < DRAG_DISTANCE_PX
      ) {
        return
      }
      pending = null
      start(p)
      if (session) {
        ;(session as DragSession).pointerX = event.clientX
        ;(session as DragSession).pointerY = event.clientY
      } else {
        stopListening()
      }
    }

    function handlePointerUp(event: PointerEvent) {
      if (session && event.pointerId === session.pointerId) {
        drop()
        return
      }
      pending = null
      stopListening()
    }

    function handlePointerCancel() {
      pending = null
      if (session) cancel()
      else stopListening()
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.pointerType === 'touch') return
      if (session || settleTimer !== null) return
      const target = event.target
      if (!(target instanceof Element)) return
      const row = target.closest<HTMLElement>('[data-sort-group]')
      if (!row || !container.contains(row)) return
      // 从行里的按钮、输入框上按下的，是那个控件的操作；行本身可以是按钮
      const control = target.closest('button, a, input, textarea, select')
      if (control && control !== row && row.contains(control)) return
      pending = {
        pointerId: event.pointerId,
        row,
        x: event.clientX,
        y: event.clientY,
      }
      doc.addEventListener('pointermove', handlePointerMove, true)
      doc.addEventListener('pointerup', handlePointerUp, true)
      doc.addEventListener('pointercancel', handlePointerCancel, true)
      win.addEventListener('blur', handlePointerCancel)
    }

    container.addEventListener('pointerdown', handlePointerDown)
    return () => {
      container.removeEventListener('pointerdown', handlePointerDown)
      if (settleTimer !== null) win.clearTimeout(settleTimer)
      pending = null
      finish()
      stopListening()
    }
  }, [app, scrollElement])
}
