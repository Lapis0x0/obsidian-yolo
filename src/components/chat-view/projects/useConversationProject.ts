import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import type { ChatConversationMetadata } from '../../../database/json/chat/types'
import { type ChatProject, findChatProject } from '../../../types/project.types'

/** 还没有指定要进入的项目 */
const NO_ENTRY = Symbol('no-entry')

/**
 * 当前对话属于哪个项目，以及「用户此刻在哪个项目里」。
 *
 * 已落盘的对话以元数据里的 `projectId` 为准。新对话要等第一条消息发出后才
 * 落盘，此前它的归属记在 `unsaved` 里；对话一出现在 chatList 中，就把
 * `projectId` 写进去并从 `unsaved` 移除。
 *
 * `currentProjectId` 是新对话默认归入的项目：跟随当前已落盘对话的项目（包括
 * 它被移进移出项目），所以头部「新对话」会留在当前项目里。
 * 从侧边栏进入项目或回到全局时，调用方先 `enterProject`，再开新对话；中间可能先经过运行时切换（会短暂切到
 * 那个运行时上次的对话），所以这个意图一直保留到真正出现一个新对话为止。
 */
export function useConversationProject({
  projects,
  chatList,
  conversationId,
  setConversationProject,
}: {
  projects: readonly ChatProject[] | undefined
  chatList: readonly ChatConversationMetadata[]
  conversationId: string | undefined
  setConversationProject: (
    conversationId: string,
    projectId: string | null,
  ) => Promise<boolean>
}) {
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)
  const [unsaved, setUnsaved] = useState<Readonly<Record<string, string>>>({})
  const pendingEntryRef = useRef<string | null | typeof NO_ENTRY>(NO_ENTRY)
  const currentProjectIdRef = useRef(currentProjectId)
  currentProjectIdRef.current = currentProjectId
  /** 已经判定过归属的未落盘对话，避免 unsaved 更新后重复判定 */
  const settledIdRef = useRef<string | undefined>(undefined)

  const persisted = conversationId
    ? chatList.find((item) => item.id === conversationId)
    : undefined
  const isPersisted = persisted !== undefined
  // 刚落盘、projectId 还没写进元数据的那一小段时间里，以 unsaved 为准
  const projectId =
    persisted?.projectId ??
    (conversationId ? unsaved[conversationId] : undefined)

  // 用 layout effect：新对话第一次渲染时还没判定归属，要在绘制前补上，否则
  // 进入项目时会先闪一帧不属于任何项目的空白页，再变成项目主页
  useLayoutEffect(() => {
    if (!conversationId) return
    if (isPersisted) {
      // 正在进入某个项目：途中经过的已落盘对话（运行时切换会短暂切到那个
      // 运行时上次的对话）不改变用户要去的地方
      if (pendingEntryRef.current !== NO_ENTRY) return
      settledIdRef.current = conversationId
      setCurrentProjectId(projectId ?? null)
      return
    }
    if (settledIdRef.current === conversationId) return
    settledIdRef.current = conversationId
    const entry = pendingEntryRef.current
    pendingEntryRef.current = NO_ENTRY
    const nextProjectId =
      entry === NO_ENTRY ? currentProjectIdRef.current : entry
    setCurrentProjectId(nextProjectId)
    if (nextProjectId) {
      setUnsaved((current) => ({ ...current, [conversationId]: nextProjectId }))
    }
  }, [conversationId, isPersisted, projectId])

  // 落盘后写入 projectId；等元数据里真的有了再从 unsaved 移除，中间这段时间
  // 归属仍以 unsaved 为准，不会闪回「不在项目里」
  const writingRef = useRef(new Set<string>())
  useEffect(() => {
    const done: string[] = []
    for (const [id, unsavedProjectId] of Object.entries(unsaved)) {
      const item = chatList.find((candidate) => candidate.id === id)
      if (!item) continue
      if (item.projectId === unsavedProjectId) {
        done.push(id)
        writingRef.current.delete(id)
        continue
      }
      if (writingRef.current.has(id)) continue
      writingRef.current.add(id)
      void setConversationProject(id, unsavedProjectId)
    }
    if (done.length === 0) return
    setUnsaved((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([id]) => !done.includes(id)),
      ),
    )
  }, [chatList, unsaved, setConversationProject])

  const project = useMemo(
    () => findChatProject(projects, projectId),
    [projects, projectId],
  )

  /** 接下来开的新对话归入这个项目；null 表示回到不属于任何项目。 */
  const enterProject = useCallback((nextProjectId: string | null) => {
    pendingEntryRef.current = nextProjectId
  }, [])

  return { project, enterProject }
}
