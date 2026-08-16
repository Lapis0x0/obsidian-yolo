import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useRef,
} from 'react'

/**
 * 流式正文不再随会话快照发布，因此"消息变长了"这件事不再经过父层的
 * `chatMessages` 变化。可见文本 commit 之后由播放器直接通知滚动跟随，
 * 节拍从发布频率变成真正的可见帧频率。
 *
 * 回调引用必须稳定：它会被叶子在 render 期间读取，一旦每次渲染都换新引用就会
 * 破坏下游 memo。
 */
const noop = () => undefined

const LiveEdgeFollowContext = createContext<() => void>(noop)

export const useLiveEdgeFollow = (): (() => void) =>
  useContext(LiveEdgeFollowContext)

export function LiveEdgeFollowProvider({
  onFollowLiveEdge,
  children,
}: {
  onFollowLiveEdge: () => void
  children: ReactNode
}) {
  const latestRef = useRef(onFollowLiveEdge)
  latestRef.current = onFollowLiveEdge
  const stableFollow = useCallback(() => {
    latestRef.current()
  }, [])

  return (
    <LiveEdgeFollowContext.Provider value={stableFollow}>
      {children}
    </LiveEdgeFollowContext.Provider>
  )
}
