import type { App } from 'obsidian'

import type { YoloSettings } from '../../settings/schema/setting.types'
import type { ApplyViewState } from '../../types/apply-view.types'
import type {
  AssistantToolApprovalMode,
  AssistantWorkspaceScope,
} from '../../types/assistant.types'
import type { ChatMessage, TaskSource } from '../../types/chat'
import type { ChatModel, ChatModelModality } from '../../types/chat-model.types'
import type { ContentPart } from '../../types/llm/request'
import type { McpTool } from '../../types/mcp.types'
import type {
  LLMProvider,
  LLMProviderApiType,
} from '../../types/provider.types'
import type {
  ToolCallResponseStatus,
  ToolEditSummary,
  ToolFsReadOperationSummary,
} from '../../types/tool-call.types'
import type { PromptSourceWatcher } from '../agent/promptSourceWatcher'
import type { SubagentAcceptedResult } from '../agent/subagent/types'
import type { BaseLLMProvider } from '../llm/base'
import type { RagKnowledgeAccess } from '../rag/ragAccess'

/** A translatable piece of UI text: an i18n key plus its English fallback. */
export type I18nText = {
  key: string
  fallback: string
}

/**
 * A built-in tool's execution result. Owned here (the tool protocol's home)
 * rather than in `core/mcp/localFileTools.ts`, which now imports it back —
 * see that file's import block. `localFileTools.ts`'s still-live switch
 * cases and this file's `ToolContext['execute']` share the exact same shape.
 */
export type LocalToolCallResultMetadata = {
  editSummary?: ToolEditSummary
  fsReadOperation?: ToolFsReadOperationSummary
  appliedAt?: number
  truncated?: { totalBytes: number; omittedBytes: number }
}

export type LocalToolCallResult =
  | {
      status: ToolCallResponseStatus.Success
      text: string
      contentParts?: ContentPart[]
      metadata?: LocalToolCallResultMetadata
    }
  | {
      status: ToolCallResponseStatus.Rejected
      reason?: string
    }
  | {
      status: ToolCallResponseStatus.Error
      error: string
    }
  | {
      status: ToolCallResponseStatus.Aborted
      /** 中断时已采集的部分输出（可选） */
      data?: {
        type: 'text'
        text: string
        metadata?: {
          truncated?: { totalBytes: number; omittedBytes: number }
        }
      }
    }

/**
 * Opaque handle for the active subagent-delegation run, threaded through
 * `ToolContext` without `core/tools/*` knowing its concrete shape. Every
 * tool except `delegate_subagent` only ever null-checks this field; that one
 * tool forwards it unexamined into the injected `runSubagent`'s `parent`
 * parameter (see `ToolContext['runSubagent']` below and
 * `delegate_subagent/definition.ts`) — it never needs to know the real
 * `SubagentParentContext` shape either, since both sides of the handoff are
 * typed opaquely and the concrete type is only recovered once, at the
 * injection site in `mcpManager.ts`.
 *
 * This indirection exists because `core/agent/subagent/parent-context.ts` is
 * upstream of `core/agent/types.ts`, which is itself part of the pre-existing
 * circular dependency component containing `core/mcp/mcpManager.ts` — a
 * static import of `SubagentParentContext` from *this* file would pull every
 * capability and tool definition (all of which import `ToolContext`) back
 * into that cycle the moment `mcpManager.ts` calls into the registry
 * (docs/plans/2026-08-15-tool-registry/master.md, D6a fix).
 */
export type OpaqueSubagentParentContext = unknown

export type BuiltinToolCategory = 'vault' | 'context' | 'external'

/**
 * Context available when building a tool's MCP protocol projection (i.e.
 * listing the catalog). No execution-time dependencies (signal, toolCallId,
 * ...) belong here — those live on `ToolContext`.
 */
export type ToolCatalogContext = {
  /** Modalities the active chat model supports; drives `fs_read`'s dynamic `modality` schema field. */
  chatModelModalities?: ChatModelModality[]
  vaultBasePath?: string
}

/**
 * Context available when deciding whether a tool is usable in the current
 * environment (platform, provider/feature configuration, ...). Kept separate
 * from `ToolCatalogContext` (different inputs) and from capability enablement
 * (a user-authorization concern, not an environment one — see master.md
 * decision 18).
 */
export type ToolAvailabilityContext = {
  settings?: YoloSettings
}

/**
 * Execution-time dependency injection, per tool call. Field-for-field lifted
 * from the anonymous parameter type of `callLocalFileTool`
 * (`src/core/mcp/localFileTools.ts:2176`), minus `toolName` (becomes
 * `executeBuiltinTool`'s first argument — the dispatcher still needs it for
 * `findPathOutsideScope`), `args` (becomes `execute`'s first argument), and
 * `runContext` (dropped entirely, not opacified: it had zero readers on
 * either side — `callLocalFileTool` itself destructured it straight into
 * `_runContext` — so there was no live shape to hide, only a dead field to
 * remove). Every other field's type,
 * optionality, and comment is copied verbatim. Do NOT narrow this to a
 * per-tool slice here — that's an explicit non-goal for this phase (see
 * master.md decision 5 / §7).
 */
export type ToolContext = {
  app: App
  settings?: YoloSettings
  openApplyReview?: (state: ApplyViewState) => Promise<boolean>
  ragAccess?: RagKnowledgeAccess
  conversationId?: string
  conversationMessages?: ChatMessage[]
  roundId?: string
  toolCallId?: string
  requireReview?: boolean
  signal?: AbortSignal
  chatModelId?: string
  workspaceScope?: AssistantWorkspaceScope
  allowedSkillPaths?: readonly string[]
  /**
   * Opaque outside `delegate_subagent`'s own definition — see
   * {@link OpaqueSubagentParentContext}'s doc comment for why this isn't
   * typed as the concrete `SubagentParentContext`.
   */
  subagentParentContext?: OpaqueSubagentParentContext
  /**
   * Host-provided capability to dispatch a subagent run — the same
   * dependency-injection shape as `openApplyReview` / `ragAccess` above
   * (master.md decision 5: `ToolContext` is DI; tools consume host
   * capabilities through it rather than importing the implementation
   * themselves). `delegate_subagent` is this field's only consumer.
   *
   * Populated by `mcpManager.ts` from `core/agent/subagent/runner.ts`'s
   * `runSubagent` — that module is, transitively, part of the same
   * pre-existing circular dependency component `OpaqueSubagentParentContext`
   * documents above, so this field is typed structurally (matching
   * `runSubagent`'s real parameter shape field-for-field, with `parent` left
   * opaque) rather than by importing `runSubagent`'s own type from that
   * module.
   */
  runSubagent?: (params: {
    description: string
    prompt: string
    conversationId: string
    source: TaskSource
    parent: OpaqueSubagentParentContext
    childModel: {
      providerClient: BaseLLMProvider<LLMProvider>
      model: ChatModel
      apiType?: LLMProviderApiType | null
    }
    signal?: AbortSignal
  }) => Promise<SubagentAcceptedResult>
  promptSourceWatcher?: PromptSourceWatcher
  /** Effective approval tier for the bash tool (see tool-gateway.ts). */
  bashApprovalMode?: AssistantToolApprovalMode
  /**
   * Forces the bash tool call into its structurally read-only variant for
   * this entire run (see tool-gateway.ts). When true, mkdir/mv/rm/rmdir are
   * unavailable regardless of `bashApprovalMode`.
   */
  bashReadOnly?: boolean
}

/**
 * A single model-callable tool. `Name` is intentionally a *local* generic
 * (default `string`) rather than a reference to the registry-derived
 * `BuiltinToolName` union: `BuiltinToolName` is computed *from* the concrete
 * `CAPABILITIES` array (see registry.ts), so this type must not reach back
 * into it — doing so would make `BuiltinToolName` a self-referential type
 * alias (and, short of an outright compile error, would silently widen it to
 * `string`, defeating every completeness check this project exists to add).
 * `defineTool` below instantiates `Name` with the literal tool name.
 */
export type BuiltinToolDefinition<Name extends string = string> = {
  name: Name
  /**
   * MCP protocol projection. **Must be a function**: `fs_read`'s schema
   * depends on the active chat model's modality support
   * (`localFileTools.ts:707` `buildFsReadModalitySchema`). Static tools just
   * return a constant, e.g. `getMcpTool: () => MEMORY_ADD_MCP_TOOL` — do not
   * special-case "static" tools with a non-function shape.
   */
  getMcpTool: (ctx: ToolCatalogContext) => Omit<McpTool, 'name'>
  /** Environment availability (platform, provider config, ...). Omitted = always available. */
  isAvailable?: (ctx: ToolAvailabilityContext) => boolean
  /**
   * Chat-surface display label. Distinct from the owning capability's
   * `label`: the capability is "File Editing", its tools are "Edit" / "Write".
   */
  chatLabel: I18nText
  /** Whether this tool's result can be dropped by `context_prune_tool_results`. */
  contextPrunable?: boolean
  execute: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<LocalToolCallResult>
}

/**
 * A user-authorized capability: the thing a person actually enables/disables
 * and sets an approval tier for. Owns the tools it exposes to the model (see
 * master.md decision 13 — ownership flows capability -> tools, never the
 * reverse). `Id`/`Tools` are local generics for the same reason `Name` is
 * local on `BuiltinToolDefinition` above — see that type's doc comment.
 */
export type BuiltinCapabilityDefinition<
  Id extends string = string,
  Tools extends
    readonly BuiltinToolDefinition[] = readonly BuiltinToolDefinition[],
> = {
  id: Id
  /** Settings-page display name. What the user sees as the "tool" name. */
  label: I18nText
  description?: I18nText
  category: BuiltinToolCategory
  defaultEnabled: boolean
  approval: {
    defaultMode: AssistantToolApprovalMode
    allowedModes: readonly AssistantToolApprovalMode[]
    /** false = hide the "always allow for this conversation" button. */
    allowAlwaysAllow: boolean
  }
  /** Whether the settings page has a dedicated configuration entry for this capability. Which modal opens is decided by the UI-layer wiring table (D4), not here. */
  hasSettings: boolean
  tools: Tools
}
