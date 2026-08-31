import { type ReactNode, createContext, useContext } from 'react'

import type { AssistantRenderStreamAccess } from '../../core/agent/assistantRenderStreamStore'

/**
 * 生成中 assistant 消息的展示流入口。
 *
 * 走独立 context 而不是让叶子直接 `usePlugin()`：叶子在 markdown 渲染链的最
 * 底层，让它依赖 plugin context 会把 `main.ts` 拉进 markdown 渲染的依赖环里。
 * 缺省为 null——没有提供者时（测试、子代理转录、独立预览）叶子退回 props。
 */
const AssistantRenderStreamContext =
  createContext<AssistantRenderStreamAccess | null>(null)

export const useAssistantRenderStreamAccess =
  (): AssistantRenderStreamAccess | null =>
    useContext(AssistantRenderStreamContext)

export function AssistantRenderStreamProvider({
  access,
  children,
}: {
  access: AssistantRenderStreamAccess | null
  children: ReactNode
}) {
  return (
    <AssistantRenderStreamContext.Provider value={access}>
      {children}
    </AssistantRenderStreamContext.Provider>
  )
}
