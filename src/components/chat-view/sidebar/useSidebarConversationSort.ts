import { type App, Platform, Scope } from 'obsidian'
import { useEffect, useRef } from 'react'
import { flushSync } from 'react-dom'

import {
  type ChatConversationMetadata,
  getChatConversationOrigin,
} from '../../../database/json/chat/types'
import type { ConversationPlacement } from '../../../hooks/useChatHistory'
import {
  MOTION_DURATION_ENTER_S,
  MOTION_EASE_OUT_CSS,
} from '../../../styles/tokens/motion'
import type { ChatProject } from '../../../types/project.types'
import {
  getSortKeyForInsert,
  selectProjectConversations,
  sortUserChatList,
} from '../chat-history-list'

/**
 * 侧边栏里拖动对话。看得见的每一个对话列表——置顶、其余对话、每个展开的
 * 项目——都是同一种列表：被拖的行经过哪个列表，哪个列表就让出空位，离开的
 * 那个列表把空位合上；松手就进到那个列表、落在那个空位上，所属项目、是否
 * 置顶、位置一次写完。折叠的项目看不到里面的对话，拖到上面整行高亮，松手
 * 放进去，位置不变。
 *
 * 拖动过程完全不经过 React：按下时量好各列表每一行的位置和各列表的范围，
 * 之后指针每移动一次只算出落在哪个列表的第几位，落点变了才给需要让位的几行
 * 写 transform；被拖的行自己用 transform 跟着指针上下走。松手时才通知 React
 * 一次（flushSync），然后用 FLIP 落位：提交前记下每一行在屏幕上的位置，提交
 * 后量新位置，从旧位置滑过去——跨列表移动会真的改变布局（项目卡片变矮，下面
 * 的列表整体上移），拖动时写的 transform 盖不住这些变化。用 dnd-kit 的话，
 * 指针每移动一次都会让所有可排序的行重渲染一遍，快速拖动时一直掉帧。
 *
 * 行和目标都用 data 属性标出，React 不管这些属性，拖动中列表因为别的原因
 * 重渲染（比如流式回复刷新运行状态）也不会把它们冲掉。触屏上长按已经留给
 * 对话的操作菜单，不开拖动。
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

/**
 * 项目条目（值是项目 id）：展开时是一个列表的范围，折叠时是整行的放下目标。
 * 对话列表：置顶和其余对话两个列表的范围。
 */
export const DROP_PROJECT_ATTRIBUTE = 'data-drop-project'
export const DROP_HISTORY_ATTRIBUTE = 'data-drop-history'
/**
 * 列表的「更多」那一行上（值是列表的组）：还有没列出的对话，这个列表是满的。
 * 拖进来一条，最后一条就被挤进「更多」里，而不是列表变长。
 */
export const SORT_CAPPED_ATTRIBUTE = 'data-sort-capped'

const DRAG_DISTANCE_PX = 5
/** 指针离滚动区上下边缘这么近时自动滚动，越近越快 */
const AUTO_SCROLL_EDGE_PX = 40
const AUTO_SCROLL_MAX_SPEED_PX = 16
/**
 * 项目卡片底边伸缩的距离，写在卡片上：卡片的底色和左侧细线画在伪元素上，
 * 拖动时按它伸长或缩短（见 projects.css），落位后 React 重排出真实的高度
 */
const CARD_EXTEND_PROPERTY = '--yolo-sort-card-extend'
/** 卡片上有它时，底边伸缩带过渡 */
const CARD_SORTING_ATTRIBUTE = 'data-sort-card'
/** 「拖到这里置顶」比它占的那一行上下各收进一点 */
const PIN_SLOT_INSET_PX = 3
/** 项目卡片和对话列表：落位时整块移动，里面的元素只补自己相对它的位移 */
const FLIP_BLOCK_SELECTOR = `[${DROP_PROJECT_ATTRIBUTE}], [${DROP_HISTORY_ATTRIBUTE}]`
/**
 * 列表之后、列表变长时要跟着往下让的单行元素：「更多」「收起」、分组标题、
 * 折叠的更早对话、任务对话入口、空项目的占位。
 */
const FOLLOWER_SELECTOR = [
  '.yolo-chat-sidebar-project-more-row',
  '.yolo-chat-sidebar-project-conversations-empty',
  '.yolo-chat-history-group',
  '.yolo-chat-list-dropdown-archive-row',
  '.yolo-chat-history-task-entry',
].join(', ')
/** 落位时参与 FLIP 的元素：对话行、项目行、上面那些单行元素，以及整块 */
const FLIP_SELECTOR = [
  FLIP_BLOCK_SELECTOR,
  '[data-sort-id]',
  '.yolo-chat-sidebar-project',
  FOLLOWER_SELECTOR,
].join(', ')

/** 滚动区里的范围：左右是视口坐标，上下是滚动内容坐标（滚动不改变它） */
type Area = { left: number; right: number; top: number; bottom: number }

type SortList = {
  group: ConversationSortGroup
  /** 列表里的行（不含被拖的那一行），按显示顺序 */
  rows: HTMLElement[]
  /** 各行中心线 */
  centers: number[]
  /** 相邻两行的间距，让位时移动这么多 */
  slot: number
  area: Area
  /** 被拖的行原本在这个列表里的位置；不是它原来的列表为 -1 */
  fromIndex: number
  /** 当前落点；指针不在这个列表上为 null */
  index: number | null
  /** 列表是满的（见 SORT_CAPPED_ATTRIBUTE） */
  capped: boolean
  /** 列表里行的左边缘和宽度：被拖的行进来时对齐到这里 */
  rowLeft: number
  rowWidth: number
  /** 列表变长或变短时跟着上下让的元素（单行元素和后面的整块） */
  followers: HTMLElement[]
  /** 列表变长或变短时整体跟着让的其他列表（置顶下面的对话） */
  listsBelow: SortList[]
  /** 因为上面的列表变长或变短而整体移动的距离 */
  base: number
  /** 项目卡片：列表变长变短时卡片的底色和左侧细线跟着伸缩（见 CARD_EXTEND_PROPERTY） */
  card: HTMLElement | null
  /** 上一次写下位移时的落点和下移距离，没变就不重写 */
  applied: string
}

/** 折叠的项目：整行是放下目标 */
type CollapsedProject = { projectId: string; element: HTMLElement; area: Area }

type DragSession = {
  pointerId: number
  row: HTMLElement
  conversationId: string
  lists: SortList[]
  collapsed: CollapsedProject[]
  containerTop: number
  containerBottom: number
  /** 被拖的行原来的中心线、左边缘和宽度 */
  rowCenter: number
  rowLeft: number
  rowWidth: number
  /** 被拖的行原来的列表 */
  source: SortList
  /** 此刻长度变了的列表和变化量（像素）：见 getLengthChanges */
  changes: Map<SortList, number>
  /** 所有列表的后续元素，去重 */
  followers: HTMLElement[]
  startContentY: number
  pointerX: number
  pointerY: number
  /** 指针此刻落在的列表；在折叠的项目上为 null */
  active: SortList | null
  over: CollapsedProject | null
  frame: number | null
  scope: Scope
  /**
   * 还没有置顶时临时出现的「拖到这里置顶」：对应的空置顶列表；指针进了
   * trigger（「对话」分组标题）才打开，打开后到松手都留着
   */
  pinSlot: {
    list: SortList
    trigger: Area
    /** 打开后插进对话列表那块的元素 */
    element: HTMLElement | null
    create: () => HTMLElement
  } | null
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
 * 被拖的对话落在列表 `group` 里 above、below 两行之间（页面上看得到的邻居，
 * 可能都不存在）时的位置。页面上一个列表可能只显示了一部分（项目只列前几个，
 * 对话列表折叠了更早的），所以在完整列表里找邻居。
 */
function getPlacement(
  chatList: readonly ChatConversationMetadata[],
  projects: readonly ChatProject[],
  conversationId: string,
  group: ConversationSortGroup,
  aboveId: string | null,
  belowId: string | null,
): ConversationPlacement {
  const list = getGroupList(chatList, projects, group).filter(
    (chat) => chat.id !== conversationId,
  )
  const aboveIndex = aboveId
    ? list.findIndex((chat) => chat.id === aboveId)
    : -1
  const belowIndex = belowId
    ? list.findIndex((chat) => chat.id === belowId)
    : -1
  const index =
    aboveIndex !== -1 ? aboveIndex + 1 : belowIndex !== -1 ? belowIndex : 0
  return {
    projectId: groupProjectId(group),
    isPinned: group === 'pinned',
    sortKey: getSortKeyForInsert(list, index),
  }
}

const contains = (area: Area, x: number, y: number) =>
  x >= area.left && x <= area.right && y >= area.top && y <= area.bottom

export function useSidebarConversationSort({
  app,
  scrollElement,
  chatList,
  projects,
  onPlace,
  onExpandProject,
  pinSlotLabel,
}: {
  app: App
  /** 侧边栏的滚动区：行和列表都在里面 */
  scrollElement: HTMLElement | null
  chatList: readonly ChatConversationMetadata[]
  projects: readonly ChatProject[]
  onPlace: (conversationId: string, placement: ConversationPlacement) => unknown
  /** 对话放进折叠的项目后展开它，让人看到对话去了哪 */
  onExpandProject: (projectId: string) => void
  /** 「拖到这里置顶」的文字 */
  pinSlotLabel: string
}) {
  // 拖动跨越多次渲染，读的都是松手那一刻的数据
  const latestRef = useRef({
    chatList,
    projects,
    onPlace,
    onExpandProject,
    pinSlotLabel,
  })
  latestRef.current = {
    chatList,
    projects,
    onPlace,
    onExpandProject,
    pinSlotLabel,
  }

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
    const transition = () =>
      `transform ${duration()}ms ${MOTION_EASE_OUT_CSS}, opacity ${duration()}ms ${MOTION_EASE_OUT_CSS}`

    let pending: {
      pointerId: number
      row: HTMLElement
      x: number
      y: number
    } | null = null
    let session: DragSession | null = null
    /** 落位动画进行中，期间不接新的拖动 */
    let landingTimer: number | null = null

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

    /**
     * 列表里各行的位移。original 是行原来的位置（源列表里被拖行之后的行原本
     * 靠后一位），current 是现在该在的位置（落点之后的行让出一位），差几位
     * 挪几个 slot，再加上因为上面的列表变长而整体下移的 base。满的列表多进
     * 一条时，最后一条会被挤进「更多」里：它原地淡出，不往下压到「更多」上。
     */
    const applyShifts = (list: SortList, index: number | null) => {
      const applied = `${index}|${list.base}`
      if (list.applied === applied) return
      list.applied = applied
      list.index = index
      const gains = index !== null && list.fromIndex === -1
      list.rows.forEach((row, i) => {
        const original =
          list.fromIndex !== -1 && i >= list.fromIndex ? i + 1 : i
        const current = index !== null && i >= index ? i + 1 : i
        const fade = gains && list.capped && i === list.rows.length - 1
        const shift = (fade ? 0 : (current - original) * list.slot) + list.base
        row.setCssProps({
          transform: shift ? `translate(0, ${shift}px)` : '',
          opacity: fade ? '0' : '',
        })
      })
    }

    /**
     * 此刻哪些列表的长度变了：指针所在的别的列表（没满）多出一行；被拖的行
     * 离开了原来的列表（没满）时，原来的列表少一行。满的列表长度不变：拖进来
     * 时最后一条挤进「更多」，拖出去时「更多」里的下一条补上来。
     */
    const getLengthChanges = (s: DragSession) => {
      const changes = new Map<SortList, number>()
      const active = s.active
      if (active && active.fromIndex === -1 && !active.capped) {
        changes.set(active, active.slot)
      }
      if (s.source !== active && !s.source.capped) {
        changes.set(s.source, -s.source.slot)
      }
      // 「拖到这里置顶」打开后一直占着一行
      if (s.pinSlot?.element) changes.set(s.pinSlot.list, s.pinSlot.list.slot)
      return changes
    }

    /**
     * 按长度的变化挪开后续元素：每个变了的列表后面的东西跟着上下让，一个
     * 元素同时在几个列表后面就加起来；项目卡片的底边跟着伸缩。
     */
    const applyLengthChanges = (
      s: DragSession,
      changes: Map<SortList, number>,
    ) => {
      const same =
        changes.size === s.changes.size &&
        [...changes].every(([list, by]) => s.changes.get(list) === by)
      if (same) return
      s.changes = changes
      const offsets = new Map<HTMLElement, number>()
      for (const [list, by] of changes) {
        for (const element of list.followers) {
          offsets.set(element, (offsets.get(element) ?? 0) + by)
        }
      }
      for (const element of s.followers) {
        const by = offsets.get(element) ?? 0
        element.setCssProps({ transform: by ? `translate(0, ${by}px)` : '' })
      }
      for (const list of s.lists) {
        list.base = 0
        for (const [above, by] of changes) {
          if (above.listsBelow.includes(list)) list.base += by
        }
        list.card?.setCssProps({
          [CARD_EXTEND_PROPERTY]: changes.has(list)
            ? `${changes.get(list)}px`
            : '',
        })
      }
    }

    const update = () => {
      const s = session
      if (!s) return
      s.frame = null
      const contentY = s.pointerY - s.containerTop + container.scrollTop
      // 只跟着指针上下走：所有列表都在同一列里，左右移动没有用处，还会让
      // 这一行超出滚动区被裁掉
      const dy = contentY - s.startContentY

      // 指针在哪个列表或折叠的项目上；都不在（比如分组标题、列表之间的
      // 空隙）时保持上一次的，不来回跳。有列表变长或变短时，它自己的底边
      // 和它下面的东西都挪了，按挪过之后的位置判断。owner 是这块范围所属
      // 的列表：它自己变长变短只挪它的底边，不挪顶边（「拖到这里置顶」那
      // 一行原本高度为 0，顶边和底边在同一处，不排除就会整块被挪走）
      const shiftAt = (y: number, owner?: SortList) => {
        let by = 0
        for (const [list, change] of s.changes) {
          if (list !== owner && y >= list.area.bottom - 0.5) by += change
        }
        return by
      }
      const seen = (area: Area, owner?: SortList): Area => {
        const own = owner ? (s.changes.get(owner) ?? 0) : 0
        return {
          ...area,
          top: area.top + shiftAt(area.top, owner),
          bottom: area.bottom + shiftAt(area.bottom, owner) + own,
        }
      }
      // 指针第一次到「对话」分组标题时打开「拖到这里置顶」。一开始就打开的
      // 话，对话列表会在指针下整体往下让一行，刚拿起的行上面那一行就跳到它
      // 下面去了；在标题上打开时，指针正好落在新出现的这一行里
      const slot = s.pinSlot
      if (
        slot &&
        !slot.element &&
        contains(seen(slot.trigger), s.pointerX, contentY)
      ) {
        slot.element = slot.create()
        applyLengthChanges(s, getLengthChanges(s))
      }
      const list = s.lists.find((l) =>
        contains(seen(l.area, l), s.pointerX, contentY),
      )
      const collapsed = list
        ? null
        : (s.collapsed.find((c) =>
            contains(seen(c.area), s.pointerX, contentY),
          ) ?? null)
      if (list) {
        s.active = list
        s.over = null
      } else if (collapsed) {
        s.active = null
        s.over = collapsed
      }

      for (const c of s.collapsed) {
        if (c === s.over) c.element.setAttribute('data-drop-active', '')
        else c.element.removeAttribute('data-drop-active')
      }
      if (s.pinSlot?.element) {
        if (s.active === s.pinSlot.list) {
          s.pinSlot.element.setAttribute('data-drop-active', '')
        } else {
          s.pinSlot.element.removeAttribute('data-drop-active')
        }
      }
      applyLengthChanges(s, getLengthChanges(s))
      // 被拖的行所在的整块（比如对话列表）可能正因为上面的列表变长变短而
      // 整体移动，这段位移会带到它身上，要扣掉，它才停在指针处
      let carried = 0
      for (const [list, by] of s.changes) {
        if (list.followers.some((f) => f.contains(s.row))) carried += by
      }
      // 进了别的列表就对齐到那个列表的行：项目里的行比对话列表的缩进多。
      // 悬在折叠的项目上时不属于任何列表，保持原样跟着指针
      const target = s.over === null ? s.active : null
      const dx = target ? target.rowLeft - s.rowLeft : 0
      const width =
        target && Math.abs(target.rowWidth - s.rowWidth) > 0.5
          ? `${target.rowWidth}px`
          : ''
      s.row.setCssProps({
        width,
        transform: `translate(${dx}px, ${dy - carried}px)`,
      })

      const center = s.rowCenter + dy
      for (const l of s.lists) {
        if (l !== s.active) {
          applyShifts(l, null)
          continue
        }
        let index = 0
        for (const c of l.centers) if (c + shiftAt(c) < center) index += 1
        applyShifts(l, index)
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
      const box = container.getBoundingClientRect()
      const contentY = (clientY: number) =>
        clientY - box.top + container.scrollTop
      const areaOf = (element: Element): Area => {
        const rect = element.getBoundingClientRect()
        return {
          left: rect.left,
          right: rect.right,
          top: contentY(rect.top),
          bottom: contentY(rect.bottom),
        }
      }
      const rowRect = p.row.getBoundingClientRect()
      const rowCenter = contentY(rowRect.top + rowRect.height / 2)

      const makeList = (
        group: ConversationSortGroup,
        allRows: HTMLElement[],
        area: Area,
        scope: HTMLElement,
      ): SortList => {
        const fromIndex = allRows.indexOf(p.row)
        const rows = allRows.filter((row) => row !== p.row)
        const centers = rows.map((row) => {
          const rect = row.getBoundingClientRect()
          return contentY(rect.top + rect.height / 2)
        })
        const allCenters = allRows.map((row) => {
          const rect = row.getBoundingClientRect()
          return contentY(rect.top + rect.height / 2)
        })
        const slot =
          allCenters.length > 1 ? allCenters[1] - allCenters[0] : rowRect.height
        // 行的左边缘和宽度：取列表里的一行；空的项目取列表内容区
        const sample = allRows[0]?.getBoundingClientRect()
        let rowLeft = sample?.left ?? rowRect.left
        let rowWidth = sample?.width ?? rowRect.width
        const ul = scope.querySelector<HTMLElement>(
          '.yolo-chat-sidebar-project-conversations',
        )
        if (!sample && ul) {
          const rect = ul.getBoundingClientRect()
          const style = win.getComputedStyle(ul)
          rowLeft = rect.left + parseFloat(style.paddingLeft)
          rowWidth =
            rect.width -
            parseFloat(style.paddingLeft) -
            parseFloat(style.paddingRight)
        }
        // 列表之后的单行元素：最后一行（空列表为列表内容区的开头）之下的
        const last = allRows.at(-1)?.getBoundingClientRect()
        const end = last
          ? contentY(last.bottom)
          : ul
            ? contentY(ul.getBoundingClientRect().top)
            : area.top
        const followers = Array.from(
          scope.querySelectorAll<HTMLElement>(FOLLOWER_SELECTOR),
        ).filter(
          (element) =>
            contentY(element.getBoundingClientRect().top) >= end - 0.5,
        )
        return {
          group,
          rows,
          centers,
          slot,
          area,
          fromIndex,
          index: null,
          capped:
            scope.querySelector(`[${SORT_CAPPED_ATTRIBUTE}="${group}"]`) !==
            null,
          rowLeft,
          rowWidth,
          followers,
          listsBelow: [],
          base: 0,
          card: null,
          applied: '',
        }
      }
      const rowsOf = (scope: Element, group: ConversationSortGroup) =>
        Array.from(
          scope.querySelectorAll<HTMLElement>('[data-sort-group]'),
        ).filter((row) => row.dataset.sortGroup === group)

      const lists: SortList[] = []
      const collapsed: CollapsedProject[] = []
      let pinSlot: DragSession['pinSlot'] = null

      // 对话列表：有置顶时按置顶和其余对话的分界切成两个列表
      const history = container.querySelector<HTMLElement>(
        `[${DROP_HISTORY_ATTRIBUTE}]`,
      )
      if (history) {
        const zone = areaOf(history)
        const pinned = rowsOf(history, 'pinned')
        const rest = rowsOf(history, 'conversations')
        const lastPinned = pinned.at(-1)
        const firstRest = rest[0]
        const boundary =
          lastPinned && firstRest
            ? (contentY(lastPinned.getBoundingClientRect().bottom) +
                contentY(firstRest.getBoundingClientRect().top)) /
              2
            : lastPinned
              ? zone.bottom
              : zone.top
        const pinnedList =
          pinned.length > 0
            ? makeList('pinned', pinned, { ...zone, bottom: boundary }, history)
            : null
        const restList =
          rest.length > 0
            ? makeList(
                'conversations',
                rest,
                { ...zone, top: boundary },
                history,
              )
            : null
        if (pinnedList) {
          // 置顶变长时，下面的对话整体往下让；对话的行不算置顶的单行后续
          if (restList) {
            pinnedList.listsBelow.push(restList)
            pinnedList.followers = pinnedList.followers.filter(
              (element) => !element.hasAttribute('data-sort-id'),
            )
          }
          lists.push(pinnedList)
        }
        if (restList) lists.push(restList)

        // 还没有置顶时没有置顶列表可拖进去：拖到「对话」分组标题上时，标题
        // 上面多出一行「拖到这里置顶」，标题和对话列表一起往下让一行（见
        // getLengthChanges）。这一行打开前高度为 0，让位按列表变长处理
        const header = history.querySelector<HTMLElement>(
          '.yolo-chat-history-group',
        )
        if (!pinnedList && restList && header) {
          const headerRect = header.getBoundingClientRect()
          const historyRect = history.getBoundingClientRect()
          const height = restList.slot
          const create = () => {
            const element = doc.createElement('div')
            element.className = 'yolo-chat-sidebar-pin-slot'
            element.textContent = latestRef.current.pinSlotLabel
            element.setCssProps({
              top: `${headerRect.top - historyRect.top + PIN_SLOT_INSET_PX}px`,
              height: `${height - 2 * PIN_SLOT_INSET_PX}px`,
            })
            history.appendChild(element)
            return element
          }
          const top = contentY(headerRect.top)
          const area = { ...areaOf(header), top, bottom: top }
          // 空的置顶列表：落点就是这一行本身。后面的分组标题等跟着往下让，
          // 对话列表整体往下让
          const list: SortList = {
            ...makeList('pinned', [], area, history),
            capped: true,
            slot: height,
            rowLeft: restList.rowLeft,
            rowWidth: restList.rowWidth,
          }
          list.listsBelow.push(restList)
          restList.area = { ...restList.area, top }
          lists.push(list)
          pinSlot = { list, trigger: areaOf(header), element: null, create }
        }
      }
      // 项目：展开的是列表，折叠的是整行目标
      container
        .querySelectorAll<HTMLElement>(`[${DROP_PROJECT_ATTRIBUTE}]`)
        .forEach((element) => {
          const projectId = element.getAttribute(DROP_PROJECT_ATTRIBUTE)
          if (!projectId) return
          const group = projectSortGroup(projectId)
          if (
            element.querySelector('.yolo-chat-sidebar-project-conversations')
          ) {
            const list: SortList = {
              ...makeList(
                group,
                rowsOf(element, group),
                areaOf(element),
                element,
              ),
              card: element,
            }
            // 项目列表变长时，后面的项目卡片和整个对话列表都往下让
            let next = element.nextElementSibling
            while (next instanceof HTMLElement) {
              list.followers.push(next)
              next = next.nextElementSibling
            }
            if (history) list.followers.push(history)
            lists.push(list)
          } else {
            collapsed.push({ projectId, element, area: areaOf(element) })
          }
        })

      const source = lists.find((list) => list.fromIndex !== -1)
      if (!source) return

      const scope = new Scope(app.keymap.scope)
      scope.register([], 'Escape', () => {
        land(null)
        return false
      })
      app.keymap.pushScope(scope)

      session = {
        pointerId: p.pointerId,
        row: p.row,
        conversationId: p.row.dataset.sortId ?? '',
        lists,
        collapsed,
        containerTop: box.top,
        containerBottom: box.bottom,
        rowCenter,
        rowLeft: rowRect.left,
        rowWidth: rowRect.width,
        source,
        changes: new Map(),
        followers: [...new Set(lists.flatMap((list) => list.followers))],
        pinSlot,
        startContentY: contentY(p.y),
        pointerX: p.x,
        pointerY: p.y,
        active: source,
        over: null,
        frame: null,
        scope,
      }
      source.index = source.fromIndex
      win.getSelection()?.removeAllRanges()
      // 指针捕获在滚动区上：拖动期间指针事件都落在滚动区，下面的行收不到
      // 悬停和移入移出（行的悬停会改列表的焦点行，每掠过一行就让整个列表
      // 重渲染）。滚轮不受捕获影响，拖动时照样能滚
      container.setPointerCapture(p.pointerId)
      container.setAttribute('data-sorting', '')
      p.row.setAttribute('data-sort-state', 'lifted')
      p.row.setCssProps({ transition: 'none' })
      for (const list of lists) {
        for (const element of [...list.rows, ...list.followers]) {
          element.setCssProps({ transition: transition() })
        }
        list.card?.setAttribute(CARD_SORTING_ATTRIBUTE, '')
      }
      schedule()
    }

    /**
     * 收尾并落位：commit 为 null 时是取消，所有行回到原位。
     *
     * FLIP：提交前记下每个元素此刻在屏幕上的位置（含拖动时的位移），在同一个
     * 任务里让 React 提交（flushSync）、撤掉拖动时的位移，再量新位置，把每个
     * 元素摁回旧位置后放开，由过渡滑到新位置。整个过程在一帧里完成，画面
     * 不跳。被拖的对话换了列表时，它在新列表里是另一个元素，从被拖行的位置
     * 滑过去；旧元素可能还在播退场动画，藏起来。
     */
    const land = (commit: (() => void) | null) => {
      const s = session
      if (!s) return
      session = null
      if (s.frame !== null) win.cancelAnimationFrame(s.frame)
      app.keymap.popScope(s.scope)
      stopListening()

      const keyOf = (element: HTMLElement): string | HTMLElement =>
        element.dataset.sortId ?? element
      const before = new Map<string | HTMLElement, DOMRect>()
      container
        .querySelectorAll<HTMLElement>(FLIP_SELECTOR)
        .forEach((element) => {
          before.set(keyOf(element), element.getBoundingClientRect())
        })

      if (commit) flushSync(commit)

      // 撤掉拖动状态。淡出的行如果被挤进了「更多」（已经不在，或在播退场
      // 动画），保持看不见
      const dragged = [
        s.row,
        ...s.lists.flatMap((list) => [...list.rows, ...list.followers]),
      ]
      for (const element of dragged) {
        const faded = element.style.opacity === '0'
        element.setCssProps({
          transition: 'none',
          transform: '',
          opacity: '',
          width: '',
        })
        element.removeAttribute('data-sort-state')
        if (
          faded &&
          element.isConnected &&
          element.style.position === 'absolute'
        ) {
          element.setCssProps({ visibility: 'hidden' })
        }
      }
      // 卡片的底边：放下时 React 已经排出真实的高度，和拖动时伸缩到的一样，
      // 直接撤掉、不过渡；取消时卡片原样，过渡回去
      for (const list of s.lists) {
        const card = list.card
        if (!card) continue
        card.setCssProps({ [CARD_EXTEND_PROPERTY]: '' })
        if (commit) {
          card.removeAttribute(CARD_SORTING_ATTRIBUTE)
        } else {
          win.setTimeout(() => {
            if (!session) card.removeAttribute(CARD_SORTING_ATTRIBUTE)
          }, duration())
        }
      }
      s.over?.element.removeAttribute('data-drop-active')
      s.pinSlot?.element?.remove()
      container.removeAttribute('data-sorting')
      if (container.hasPointerCapture(s.pointerId)) {
        container.releasePointerCapture(s.pointerId)
      }

      // 被拖的对话现在是哪个元素：换了列表时是新列表里的另一个元素，旧元素
      // 或者已经不在了，或者还在播退场动画（对话列表的行退场时切成绝对定位），
      // 藏起来免得在原处淡出
      const copies = Array.from(
        container.querySelectorAll<HTMLElement>('[data-sort-id]'),
      ).filter((element) => element.dataset.sortId === s.conversationId)
      const landed =
        copies.find((element) => element !== s.row) ??
        (s.row.isConnected && s.row.style.position !== 'absolute'
          ? s.row
          : null)
      if (landed !== s.row && s.row.isConnected) {
        s.row.setCssProps({ visibility: 'hidden' })
      }

      const ms = duration()
      const moved: HTMLElement[] = []
      if (ms > 0) {
        // 先全部量完再统一写：边量边写的话，每写一次位移，下一次测量都要
        // 重新算一遍布局
        //
        // 项目卡片和对话列表整块移动；块里的元素已经跟着块走，只补自己相对
        // 块的那部分位移，不然会移动两遍
        const deltas = new Map<HTMLElement, [number, number]>()
        const offsets: [HTMLElement, number, number][] = []
        container
          .querySelectorAll<HTMLElement>(FLIP_SELECTOR)
          .forEach((element) => {
            if (element === s.row && landed !== s.row) return
            const from = before.get(keyOf(element))
            if (!from) return
            const to = element.getBoundingClientRect()
            const delta: [number, number] = [
              from.left - to.left,
              from.top - to.top,
            ]
            deltas.set(element, delta)
            const block =
              element.parentElement?.closest<HTMLElement>(FLIP_BLOCK_SELECTOR)
            const outer = block ? deltas.get(block) : undefined
            const dx = delta[0] - (outer?.[0] ?? 0)
            const dy = delta[1] - (outer?.[1] ?? 0)
            if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
            offsets.push([element, dx, dy])
          })
        for (const [element, dx, dy] of offsets) {
          element.setCssProps({
            transition: 'none',
            transform: `translate(${dx}px, ${dy}px)`,
          })
          moved.push(element)
        }
      }
      // 被拖的行落位途中保持被拖的样子
      const settling = landed && moved.includes(landed) ? landed : null
      settling?.setAttribute('data-sort-state', 'landing')
      void container.offsetHeight
      for (const element of dragged) {
        if (!moved.includes(element)) element.setCssProps({ transition: '' })
      }
      for (const element of moved) {
        element.setCssProps({ transition: transition(), transform: '' })
      }
      if (moved.length === 0) return
      landingTimer = win.setTimeout(() => {
        landingTimer = null
        for (const element of moved) element.setCssProps({ transition: '' })
        settling?.removeAttribute('data-sort-state')
      }, ms)
    }

    const drop = () => {
      const s = session
      if (!s) return
      swallowNextClick()
      const { onPlace, onExpandProject, chatList, projects } = latestRef.current
      const id = s.conversationId
      if (s.over) {
        // 折叠的项目：放到最前面并展开项目，落位动画直接落到它在项目里的那一行
        const { projectId } = s.over
        const placement = getPlacement(
          chatList,
          projects,
          id,
          projectSortGroup(projectId),
          null,
          null,
        )
        land(() => {
          void onPlace(id, placement)
          onExpandProject(projectId)
        })
        return
      }
      const list = s.active
      if (!list || list.index === null || list.index === list.fromIndex) {
        land(null)
        return
      }
      const placement = getPlacement(
        chatList,
        projects,
        id,
        list.group,
        list.rows[list.index - 1]?.dataset.sortId ?? null,
        list.rows[list.index]?.dataset.sortId ?? null,
      )
      land(() => void onPlace(id, placement))
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
      const s = session as DragSession | null
      if (s) {
        s.pointerX = event.clientX
        s.pointerY = event.clientY
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
      if (session) land(null)
      else stopListening()
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.pointerType === 'touch') return
      if (session || landingTimer !== null) return
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
      if (landingTimer !== null) win.clearTimeout(landingTimer)
      pending = null
      land(null)
      stopListening()
    }
  }, [app, scrollElement])
}
