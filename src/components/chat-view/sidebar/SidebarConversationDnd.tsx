import {
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  type DropAnimation,
  closestCenter,
  defaultDropAnimationSideEffects,
  pointerWithin,
  useDroppable,
} from '@dnd-kit/core'
import { useReducedMotion } from 'framer-motion'
import { Platform } from 'obsidian'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import {
  type ChatConversationMetadata,
  getChatConversationOrigin,
} from '../../../database/json/chat/types'
import {
  MOTION_DURATION_ENTER_S,
  MOTION_EASE_OUT_CSS,
} from '../../../styles/tokens/motion'
import type { ChatProject } from '../../../types/project.types'
import { useSortableDragSensors } from '../../common/useSortableDragSensors'
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
 * 拖动用 dnd-kit，和设置页拖 Provider、模型是同一套：被拖的那一行留下空位，
 * 跟着指针走的是它的一份拷贝，同组的其他行实时让位。触屏上长按已经留给了
 * 对话的操作菜单，不开拖动。
 */

export const SORT_TRANSITION = {
  duration: MOTION_DURATION_ENTER_S * 1000,
  easing: MOTION_EASE_OUT_CSS,
}

/** 对话所在的那一组：置顶、其余对话，或某个项目里的对话 */
export type ConversationSortGroup =
  | 'pinned'
  | 'conversations'
  | `project:${string}`

export const projectSortGroup = (projectId: string): ConversationSortGroup =>
  `project:${projectId}`

/** 挂在每个可拖动对话上的数据 */
export type ConversationDragData = {
  kind: 'conversation'
  title: string
  group: ConversationSortGroup
  /** 对话所在的项目；不在项目里为 null */
  projectId: string | null
}

type ProjectDropData = { kind: 'project'; projectId: string }
type HistoryDropData = { kind: 'history' }
type SidebarDragData = ConversationDragData | ProjectDropData | HistoryDropData

const projectDropId = (projectId: string) => `project-drop:${projectId}`
const HISTORY_DROP_ID = 'history-drop'

const dataOf = (container: {
  data: { current?: Record<string, unknown> }
}): SidebarDragData | undefined =>
  container.data.current as SidebarDragData | undefined

/**
 * 侧边栏对话列表里出现的用户对话：不在项目里，或所在的项目已被删除。和
 * ChatHistoryList 的过滤同义。
 */
const isUngroupedUserChat = (
  chat: ChatConversationMetadata,
  projectIds: ReadonlySet<string>,
) =>
  getChatConversationOrigin(chat) === 'user' &&
  (!chat.projectId || !projectIds.has(chat.projectId))

/** 一组对话的完整列表（不截断、不折叠），按显示顺序 */
function getGroupList(
  chatList: readonly ChatConversationMetadata[],
  projects: readonly ChatProject[],
  group: ConversationSortGroup,
): ChatConversationMetadata[] {
  if (group.startsWith('project:')) {
    return selectProjectConversations(chatList, group.slice('project:'.length))
  }
  const projectIds = new Set(projects.map((project) => project.id))
  const pinned = group === 'pinned'
  return sortUserChatList(
    chatList.filter(
      (chat) =>
        isUngroupedUserChat(chat, projectIds) &&
        Boolean(chat.isPinned) === pinned,
    ),
  )
}

/**
 * 指针落在别的项目上就是放进那个项目；项目里的对话落在对话列表上就是移出
 * 项目；其余情况在同组里找最近的位置排序。
 */
const detectCollision: CollisionDetection = (args) => {
  const active = args.active.data.current as ConversationDragData | undefined
  if (!active) return []
  const containerById = new Map(
    args.droppableContainers.map((container) => [container.id, container]),
  )
  const underPointer = pointerWithin(args).filter((collision) => {
    const container = containerById.get(collision.id)
    const data = container ? dataOf(container) : undefined
    if (data?.kind === 'project') return data.projectId !== active.projectId
    if (data?.kind === 'history') return active.projectId !== null
    return false
  })
  // 项目卡片在对话列表之外，两者不会同时命中
  if (underPointer.length > 0) return underPointer.slice(0, 1)
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter((container) => {
      const data = dataOf(container)
      return data?.kind === 'conversation' && data.group === active.group
    }),
  })
}

export function SidebarConversationDnd({
  chatList,
  projects,
  ownerDocument,
  onMoveToProject,
  onReorder,
  children,
}: {
  chatList: readonly ChatConversationMetadata[]
  projects: readonly ChatProject[]
  /** 拖动中的拷贝挂在侧边栏所在窗口的 body 上（弹出窗口里是它自己的） */
  ownerDocument: Document | null
  onMoveToProject: (conversationId: string, projectId: string | null) => unknown
  onReorder: (conversationId: string, sortKey: number) => unknown
  children: ReactNode
}) {
  const sensors = useSortableDragSensors()
  const reduceMotion = useReducedMotion()
  const [dragged, setDragged] = useState<ConversationDragData | null>(null)
  /** 指针此刻是要放进项目 / 移出项目，而不是在组里排序 */
  const [movingOut, setMovingOut] = useState(false)

  const handleDragStart = ({ active }: DragStartEvent) => {
    setDragged((active.data.current as ConversationDragData) ?? null)
    setMovingOut(false)
  }

  const handleDragOver = ({ over }: DragOverEvent) => {
    const kind = over ? dataOf(over)?.kind : undefined
    setMovingOut(kind === 'project' || kind === 'history')
  }

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setDragged(null)
    const data = active.data.current as ConversationDragData | undefined
    const target = over ? dataOf(over) : undefined
    if (!data || !over || !target) return
    const conversationId = String(active.id)
    if (target.kind === 'project') {
      void onMoveToProject(conversationId, target.projectId)
      return
    }
    if (target.kind === 'history') {
      void onMoveToProject(conversationId, null)
      return
    }
    if (over.id === active.id) return
    const list = getGroupList(chatList, projects, data.group)
    const fromIndex = list.findIndex((chat) => chat.id === active.id)
    const toIndex = list.findIndex((chat) => chat.id === over.id)
    if (fromIndex === -1 || toIndex === -1) return
    void onReorder(
      conversationId,
      getSortKeyAfterMove(list, fromIndex, toIndex),
    )
  }

  // 在组里排序时，拷贝落回让出的空位；放进或移出项目时，这一行会从原来的
  // 列表里消失，没有可落的位置，拷贝直接撤掉
  const dropAnimation: DropAnimation | null =
    reduceMotion || movingOut
      ? null
      : {
          duration: SORT_TRANSITION.duration,
          easing: SORT_TRANSITION.easing,
          sideEffects: defaultDropAnimationSideEffects({
            className: { dragOverlay: 'is-dropping' },
            // 拷贝落定之前空位保持空着，否则这一行看起来落了两次
            styles: { active: { opacity: '0' } },
          }),
        }

  if (Platform.isMobile) return <>{children}</>

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={detectCollision}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setDragged(null)}
    >
      {children}
      {ownerDocument &&
        createPortal(
          <DragOverlay dropAnimation={dropAnimation}>
            {dragged ? (
              // 要放进或移出项目时，拷贝缩小并让到指针下方，露出指针下
              // 高亮的目标
              <div
                className={`yolo-chat-sidebar-drag-overlay${
                  movingOut ? ' is-moving-out' : ''
                }`}
              >
                <span className="yolo-chat-sidebar-drag-overlay-title">
                  {dragged.title}
                </span>
              </div>
            ) : null}
          </DragOverlay>,
          ownerDocument.body,
        )}
    </DndContext>
  )
}

/** 项目：拖着别处的对话悬停时高亮，松手放进这个项目 */
export function useProjectDropTarget(projectId: string) {
  const { setNodeRef, isOver } = useDroppable({
    id: projectDropId(projectId),
    data: { kind: 'project', projectId } satisfies ProjectDropData,
  })
  return { setNodeRef, isOver }
}

/** 对话列表：拖着项目里的对话悬停时高亮，松手移出项目 */
export function HistoryDropZone({ children }: { children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({
    id: HISTORY_DROP_ID,
    data: { kind: 'history' } satisfies HistoryDropData,
  })
  return (
    <div
      ref={setNodeRef}
      className={`yolo-chat-history-drop-zone${isOver ? ' is-drop-target' : ''}`}
    >
      {children}
    </div>
  )
}

/**
 * dnd-kit 拖动期间会吞掉点击，但拖完卸下监听，紧跟着松手的那次点击会漏过来，
 * 把刚拖完的对话打开。拖完后短暂忽略点击（设置页的 Provider 行同样如此）。
 */
export function useSuppressClickAfterDrag(isDragging: boolean) {
  const suppressUntilRef = useRef(0)
  useEffect(() => {
    if (!isDragging) return
    return () => {
      suppressUntilRef.current = Date.now() + 250
    }
  }, [isDragging])
  return suppressUntilRef
}
