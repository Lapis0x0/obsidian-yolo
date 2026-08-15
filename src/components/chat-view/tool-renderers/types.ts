import type { ReactNode } from 'react'

import type { ChatSubagentResultMessage } from '../../../types/chat'
import type {
  ToolCallRequest,
  ToolCallResponse,
} from '../../../types/tool-call.types'

/**
 * Per-tool-call context a custom renderer needs to mount. Assembled and
 * handed down by the caller (currently nothing live — ToolMessage.tsx's own
 * rendering still runs unchanged until D8 replaces its `if` chain with a
 * lookup into `TOOL_RENDERERS`); this type is what that future call site
 * must produce.
 *
 * Shape decided against `delegate_subagent`'s `SubagentCard` (Phase 1 D3 —
 * see phase1-skeleton.md's "关键验证点"), the upper bound of what a custom
 * card needs:
 *   - `toolCallId` / `request` / `response` / `conversationId`: plain values
 *     already threaded through ToolMessage.tsx's per-call render function.
 *   - `subagentResult`: message-tree-derived (looked up from a
 *     `Map<toolCallId, ChatSubagentResultMessage>` assembled above the
 *     per-call level, `ToolMessage.tsx`'s `subagentResultsByToolCallId`) —
 *     a renderer mounted from just `(request, response)` could not derive
 *     this itself.
 *   - `onAbort`: closes over `useChatRuntimeActions()` and the active
 *     conversation/recovery state — likewise not independently derivable.
 *
 * Extending this bag with more optional fields as later tools (D6) need them
 * — e.g. `terminalCommandResult`, `onResponseUpdate` — is additive and does
 * not require revisiting this shape or any existing renderer.
 */
export type ToolRendererProps = {
  toolCallId: string
  request: ToolCallRequest
  response: ToolCallResponse
  conversationId: string
  subagentResult?: ChatSubagentResultMessage
  onAbort: () => void
}

/**
 * A tool's chat-surface rendering strategy.
 *
 * Three kinds, because the existing card mount sites in ToolMessage.tsx come
 * in exactly two custom shapes plus the default:
 *
 * - `{ kind: 'generic' }` — explicit opt-out meaning "no custom card; use the
 *   default collapsed-card rendering". Distinct from a missing table entry,
 *   which is a compile error (see `TOOL_RENDERERS`'s doc comment).
 *
 * - `{ kind: 'replace', render }` — renders *instead of* the whole tool-call
 *   block. Modelled on `SubagentCard` (`ToolMessage.tsx:1520`), which
 *   `return`s early and takes over the entire call's presentation.
 *
 * - `{ kind: 'body', render }` — renders *inside* the default collapsed
 *   card's content area, below the parameters section. Modelled on
 *   `LiveTaskCard` (`ToolMessage.tsx:1651`), which augments the generic card
 *   rather than replacing it. Without this variant, terminal-like tools
 *   (D6 batch 6) could not be expressed at all.
 *
 * Either `render` may return `null` for a particular call/state to fall back
 * to the default rendering — e.g. `delegate_subagent`'s renderer returns
 * `null` while pending approval, matching current behavior where the approval
 * footer (not `SubagentCard`) owns that state.
 *
 * Deliberately NOT modelled here: `CliSubagentCard` (`ToolMessage.tsx:1541`).
 * Its gate is `cliSubagent.presentation && actions && sessionRef` — a
 * capability/state condition, not a tool name — so it is not a by-name
 * concern and stays out of this table (phase2-migration.md D8: non-tool-name
 * branches are preserved as-is).
 *
 * Not yet consumed: replacing ToolMessage.tsx's `if` chain with a lookup
 * against `TOOL_RENDERERS` is D8. This phase (D3/D4) only builds the
 * exhaustive table and proves a renderer can mount under this shape.
 */
export type ToolRenderer =
  | { kind: 'generic' }
  | {
      kind: 'replace'
      render: (props: ToolRendererProps) => ReactNode
    }
  | {
      kind: 'body'
      render: (props: ToolRendererProps) => ReactNode
    }
