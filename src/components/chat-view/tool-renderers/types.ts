import type { ReactNode } from 'react'

import type {
  ChatSubagentResultMessage,
  ChatTerminalCommandResultMessage,
} from '../../../types/chat'
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
 * Extending this bag with more optional fields as later tools need them is
 * additive and does not require revisiting this shape or any existing
 * renderer. `terminalCommandResult` (D8) is the first such addition —
 * `terminal_command`'s `body` renderer needs it to hydrate a live/persisted
 * background-session result, mirroring `subagentResult` above.
 */
export type ToolRendererProps = {
  toolCallId: string
  request: ToolCallRequest
  response: ToolCallResponse
  conversationId: string
  subagentResult?: ChatSubagentResultMessage
  terminalCommandResult?: ChatTerminalCommandResultMessage
  onAbort: () => void
}

/**
 * A tool's chat-surface header summary — the short text after the title in
 * the collapsed card's header row (e.g. "docs/plan.md", "git status"), and
 * in the plain-text transcript `getToolMessageContent` produces. A pure
 * function of the call's *arguments* — no React, no response data — which is
 * why its implementations live beside each tool's `definition.ts` in
 * `core/tools/<tool>/chat-summary.ts` rather than in a `ui.tsx` (D8): they
 * need no more from the UI layer than `ui.tsx` files are explicitly allowed
 * to avoid (master.md §3.2 — `definition.ts` never imports `ui.tsx`).
 *
 * `labels` is declared here as a plain structural echo of the handful of
 * translated strings any summary function needs (currently: `todo_write`'s
 * four list-state strings, `terminal_command`'s three session-follow-up
 * strings) — NOT an import of `ToolMessage.tsx`'s `ToolLabels`. Importing
 * that type would create a components -> components cycle the moment
 * `ToolMessage.tsx` itself imports `TOOL_RENDERERS` (this D8 change), since
 * a component-scoped type-only import is still an edge this project's
 * circular-dependency check counts (see `core/tools/types.ts`'s
 * `OpaqueSubagentParentContext` doc comment for the same reasoning applied
 * to a core/core edge). The real `ToolLabels` object is a structural
 * superset of `ToolChatSummaryLabels`, so it satisfies this type without
 * either side importing the other; each concrete `summary` function further
 * narrows `labels` down to only the fields it actually reads (see
 * `terminal_command/chat-summary.ts` / `todo_write/chat-summary.ts`).
 *
 * Returns `undefined` for "no summary" — e.g. every tool that had no branch
 * in the old `if` chain (memory_add/update/delete, context_compact,
 * context_prune_tool_results, ask_user_question) simply omits this field.
 */
export type ToolChatSummaryLabels = {
  todoWriteCleared: string
  todoWriteAllCompleted: (count: number) => string
  todoWriteCreated: (count: number) => string
  todoWriteProgress: (done: number, total: number) => string
  terminalCommandSessionPoll: (sessionId: number) => string
  terminalCommandSessionKill: (sessionId: number) => string
  terminalCommandSessionInput: (
    sessionId: number,
    inputPreview: string,
  ) => string
}

export type ToolChatSummaryFn = (args: {
  argumentsObject: Record<string, unknown> | null
  labels: ToolChatSummaryLabels
}) => string | undefined

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
 *   block. Modelled on `SubagentCard` (`ToolMessage.tsx`'s pre-D8 early
 *   `return`), which takes over the entire call's presentation.
 *
 * - `{ kind: 'body', render }` — renders *inside* the default collapsed
 *   card's content area, below the parameters section. Modelled on
 *   `LiveTaskCard` (`ToolMessage.tsx`'s pre-D8 `isTerminalLikeRequest`
 *   branch), which augments the generic card rather than replacing it.
 *   Without this variant, terminal-like tools (D6 batch 6) could not be
 *   expressed at all. `terminal_command` is the sole `body` entry (D8) —
 *   the CLI `command_execution` capability and the legacy
 *   `delegate_external_agent` name also mount `LiveTaskCard`, but neither is
 *   tool-name-indexed, so both stay as inline branches in `ToolMessage.tsx`
 *   rather than table entries (see that file's own comment at the mount
 *   site).
 *
 * Either `render` may return `null` for a particular call/state to fall back
 * to the default rendering — e.g. `delegate_subagent`'s renderer returns
 * `null` while pending approval, matching current behavior where the approval
 * footer (not `SubagentCard`) owns that state.
 *
 * `summary` (D8) is orthogonal to `kind` — a `generic`-kind tool can still
 * have a custom header summary (most of them do); see `ToolChatSummaryFn`'s
 * own doc comment above.
 *
 * Deliberately NOT modelled here: `CliSubagentCard` (`ToolMessage.tsx`'s
 * `cliSubagent.presentation && actions && sessionRef` branch). That gate is
 * a capability/state condition, not a tool name — so it is not a by-name
 * concern and stays out of this table (phase2-migration.md D8: non-tool-name
 * branches are preserved as-is).
 */
export type ToolRenderer = {
  summary?: ToolChatSummaryFn
} & (
  | { kind: 'generic' }
  | {
      kind: 'replace'
      render: (props: ToolRendererProps) => ReactNode
    }
  | {
      kind: 'body'
      render: (props: ToolRendererProps) => ReactNode
    }
)
