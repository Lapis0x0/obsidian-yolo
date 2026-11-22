import { z } from 'zod'

import { assistantWorkspaceScopeSchema } from './assistant.types'

/**
 * 项目：一组对话的容器，自带工作区和默认 Agent。
 *
 * - 工作区复用 Agent 工作区的包含 / 排除规则。项目里的对话用项目工作区
 *   **替换** Agent 自己的工作区，不求交集；不在项目里时一切照旧。只约束 YOLO
 *   Agent，CLI Agent 用自己的工具，不受约束。
 * - 项目指令就是工作区包含目录里的 `AGENTS.md` / `CLAUDE.md`，项目里总是读取，
 *   不在这里存任何指令文本。
 * - 对话归属只存在对话上（`ChatConversation.projectId`），项目侧不存对话列表。
 */
export const chatProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** lucide 图标名 */
  icon: z.string().optional(),
  /** 图标底色，CSS 颜色值 */
  color: z.string().optional(),
  workspaceScope: assistantWorkspaceScopeSchema,
  /** 序列化的 AgentRef（见 agent-picker/agentRef.ts）；不设则沿用当前 Agent */
  defaultAgent: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type ChatProject = z.infer<typeof chatProjectSchema>

export const findChatProject = (
  projects: readonly ChatProject[] | undefined,
  projectId: string | undefined | null,
): ChatProject | null => {
  if (!projectId) return null
  return projects?.find((project) => project.id === projectId) ?? null
}
