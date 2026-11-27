import { useLayoutEffect, useRef } from 'react'

import {
  MOTION_DURATION_ENTER_S,
  MOTION_EASE_OUT_CSS,
} from '../../styles/tokens/motion'
import { getNodeWindow } from '../../utils/dom/window-context'

/** 对话页此刻给人看的是什么：哪个对话的内容，或哪个主页 */
export type VisibleChatContent = {
  /** 空白页（项目主页或普通主页），而不是有消息的对话 */
  empty: boolean
  /** 空白页时有意义：项目主页属于哪个项目，普通主页为 null */
  projectId: string | null
  conversationId: string
}

/**
 * 内容是否真的换了：有一边是对话时看对话换没换；两边都是空白页时看是不是
 * 同一个主页。在主页上换 Agent（会换成另一个运行时的新对话）或开新对话，
 * 看到的还是同一个主页，不算换。发出第一条消息时对话 id 不变，也不算换，
 * 那时由空白页自己淡出。
 */
export function isVisibleContentChanged(
  previous: VisibleChatContent,
  next: VisibleChatContent,
): boolean {
  if (previous.empty && next.empty) {
    return previous.projectId !== next.projectId
  }
  return previous.conversationId !== next.conversationId
}

/**
 * 切换对话或主页时，旧内容立刻撤下，新内容（会话面板，以及项目主页在输入框
 * 下方的主体）淡入。
 *
 * 由内容是否变化触发，而不是由会话面板挂载触发：YOLO 和 CLI 各有一个会话
 * 面板组件，在主页上换 Agent 会把面板整个换掉重建，但看到的还是同一个主页，
 * 这时淡入一遍只会让人以为界面重新加载了。Chat 在运行时切换时不会重建，
 * 由它记住上一次显示的内容。
 *
 * 比较的对象是上一次真正画出来的内容，而不是上一次提交：新对话的项目归属
 * 会晚一次提交才判定，同一帧里先有一次「普通主页」、再变成「项目主页」，
 * 前一次从没画出来过。所以每次提交都按画出来的内容重新判断，同一帧里早先
 * 起的淡入作废。
 *
 * 只动透明度：面板里有滚动容器和虚拟化测量，位移会干扰它们读到的几何。
 */
export function useContentEnterFade(
  container: HTMLElement | null,
  { empty, projectId, conversationId }: VisibleChatContent,
  reduceMotion: boolean,
) {
  const paintedRef = useRef<VisibleChatContent | null>(null)
  /** 这一帧里已经起了、还没画出来的淡入 */
  const unpaintedAnimationsRef = useRef<Animation[]>([])

  useLayoutEffect(() => {
    if (!container) return
    const next = { empty, projectId, conversationId }
    unpaintedAnimationsRef.current.forEach((animation) => animation.cancel())
    unpaintedAnimationsRef.current = []

    const painted = paintedRef.current
    if (painted && !reduceMotion && isVisibleContentChanged(painted, next)) {
      const targets = container.querySelectorAll<HTMLElement>(
        ':scope > .yolo-chat-conversation-surface, :scope > .yolo-project-home-below',
      )
      targets.forEach((target) => {
        unpaintedAnimationsRef.current.push(
          target.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: MOTION_DURATION_ENTER_S * 1000,
            easing: MOTION_EASE_OUT_CSS,
          }),
        )
      })
    }

    // 下一帧开头这次提交就要画出来了，它成为之后比较的基准；同一帧里再有
    // 提交时，清理函数会取消这个回调，基准留给最后那次
    const win = getNodeWindow(container)
    const frame = win.requestAnimationFrame(() => {
      paintedRef.current = next
      unpaintedAnimationsRef.current = []
    })
    return () => win.cancelAnimationFrame(frame)
  }, [container, conversationId, empty, projectId, reduceMotion])
}
