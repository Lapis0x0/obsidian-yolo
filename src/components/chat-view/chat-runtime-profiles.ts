import type { ToolCapabilityMode } from '../../core/agent/tool-capability-prompt'
import type { AgentRuntimeLoopConfig } from '../../core/agent/types'
import { getLocalFileToolServerName } from '../../core/mcp/localFileTools'
import { getToolName } from '../../core/mcp/tool-name-utils'
import { resolveModuleCapabilityProfile } from '../../core/modules/moduleCapabilityProfile'
import type { RegisteredModuleChatModeV1 } from '../../core/modules/moduleChatModeRegistry'
import { getCapability } from '../../core/tools/registry'
import type { Assistant } from '../../types/assistant.types'
import type { NativeToolPolicy } from '../../types/llm/request'

import type { ChatMode } from './chat-input/ChatModeSelect'
import { isAgentChatMode, isModuleChatMode } from './chat-input/ChatModeSelect'

type AssistantRuntimeOptions = Pick<
  Assistant,
  | 'enableTools'
  | 'includeBuiltinTools'
  | 'toolPreferences'
  | 'builtinCapabilityPreferences'
  | 'toolServerPreferences'
>

export const DEFAULT_AGENT_MAX_AUTO_ITERATIONS = 100

/**
 * Capabilities withheld from non-Agent chat modes (Ask mode): file writes,
 * the vault shell, the local terminal, and autonomous task planning — see
 * master.md §3.1's "非 Agent 聊天模式屏蔽的能力" note.
 *
 * D7 (phase2-migration.md D7 item 9): this used to be a hand-listed array of
 * 6 tool FQNs (the `fs_edit_ops` group name plus 5 member/tool names) that
 * had to be kept in sync with the tool catalog by inspection. It is now
 * derived from each blocked capability's own `tools` list, so adding a tool
 * to (say) `file_editing` automatically extends the block — no second list
 * to remember. `todo_list` is included here even though it wasn't one of
 * the three capabilities master.md §3.1 names in its "非 Agent 聊天模式屏蔽"
 * sentence: `todo_write`'s own description ("Agent mode only", see
 * `capabilities/todo-list.ts`) documents that it has always been part of
 * this block, and the pre-D7 6-FQN list did include it explicitly — the
 * prose in §3.1 just undercounts by one.
 */
const CHAT_BLOCKED_CAPABILITY_IDS = [
  'file_editing',
  'vault_shell',
  'terminal',
  'todo_list',
] as const

export const CHAT_BLOCKED_TOOL_NAMES: readonly string[] =
  CHAT_BLOCKED_CAPABILITY_IDS.flatMap((capabilityId) => {
    const capability = getCapability(capabilityId)
    if (!capability) {
      return []
    }
    return capability.tools.map((tool) =>
      getToolName(getLocalFileToolServerName(), tool.name),
    )
  })

/**
 * Explicit context-assembly policy produced by `resolveChatModeRuntime` and
 * consumed by every prompt/tool/context/model resolution path. Module chat
 * modes are a complete product contract of their own — assistant
 * instructions, memory, skills policy, workspace scope, current-file policy,
 * default model, and new-session model init all cut over together, never
 * partially. See `ChatContextPolicy` consumers in
 * `src/utils/chat/requestContextBuilder.ts` and the call sites that resolve
 * a model id.
 */
export type ChatContextPolicy = Readonly<{
  /** false only for module chat modes; built-in modes are always true. */
  useAssistant: boolean
}>

export type ChatModeRuntime = {
  loopConfig: AgentRuntimeLoopConfig
  allowedToolNames: string[] | undefined
  toolPreferences: Assistant['toolPreferences']
  builtinCapabilityPreferences: Assistant['builtinCapabilityPreferences']
  toolServerPreferences: Assistant['toolServerPreferences']
  bypassToolApproval: boolean
  toolCapabilityMode: ToolCapabilityMode
  /**
   * True when the shared 'bash' tool identity must run read-only for this
   * entire run. Always false for built-in modes. Follows
   * `resolveModuleCapabilityProfile` for module chat modes — see that
   * function's doc comment for why this must never be a separately-set flag.
   */
  bashReadOnly: boolean
  /** Module chat mode persona, injected in place of assistant instructions. */
  modePersonaPrompt?: string
  /** The owning module id, for the persona injection's `module="..."` attribute. */
  modePersonaModuleId?: string
  /**
   * Full running mode id (`module:<moduleId>:<modeId>`) — see
   * `ModuleChatModeId`. Scopes skill resolution (`LiteSkillScope`) so a
   * mode's own declared skills join the candidate set only for its own
   * runs; distinct from `modePersonaModuleId`, which names only the owning
   * module and cannot disambiguate between two modes of the same module.
   * Undefined for built-in modes.
   */
  moduleChatModeId?: string
  contextPolicy: ChatContextPolicy
  /**
   * For module chat modes: full tool name (`<serverName>__<toolName>`, see
   * `getToolName`) → the mode's declared `requiresApproval` for every tool
   * on the mode's own server (present with `false` when omitted/unset, so
   * the gateway can distinguish "not a mode tool" from "mode tool, auto
   * approve"). `AgentToolGateway` reads this once per tool call, at creation
   * time, to fix the persisted `approvalPolicy` snapshot — see
   * `ToolCallRequest.metadata`. Always an (possibly empty) object for module
   * chat modes and `undefined` for built-in modes; its mere presence is how
   * the gateway knows a run is a module chat mode run at all (also gating
   * whether bash calls get a persisted `executionConstraints.bashReadOnly`).
   */
  moduleToolApprovalPolicies?: ReadonlyMap<string, boolean>
}

export type ChatModeRuntimeInput = {
  mode: ChatMode
  /**
   * Auto-approve tool calls (YOLO). Orthogonal to `mode`; only takes effect in
   * Agent mode.
   */
  yoloEnabled?: boolean
  assistant?: AssistantRuntimeOptions | null
  assistantEnabledToolNames: string[]
  /**
   * The registered entry for `mode` when `mode` is a module chat mode id.
   * Callers are expected to have already resolved `mode` to an *effective*
   * value via `resolveEffectiveChatMode` before calling this function — an
   * unregistered/unavailable module id never reaches here as `'agent'` would
   * have been substituted upstream. Omitted/undefined for built-in modes.
   */
  moduleChatMode?: RegisteredModuleChatModeV1
}

const BUILT_IN_CONTEXT_POLICY: ChatContextPolicy = Object.freeze({
  useAssistant: true,
})
const MODULE_CONTEXT_POLICY: ChatContextPolicy = Object.freeze({
  useAssistant: false,
})

export function resolveChatModeRuntime({
  mode,
  yoloEnabled = false,
  assistant,
  assistantEnabledToolNames,
  moduleChatMode,
}: ChatModeRuntimeInput): ChatModeRuntime {
  if (isModuleChatMode(mode) && moduleChatMode) {
    return resolveModuleChatModeRuntime(moduleChatMode)
  }

  const enableTools = assistant?.enableTools ?? true
  const includeBuiltinTools = enableTools
    ? (assistant?.includeBuiltinTools ?? true)
    : false

  const isAgentMode = isAgentChatMode(mode)
  const blocked = new Set(CHAT_BLOCKED_TOOL_NAMES)
  const allowedToolNames = enableTools
    ? isAgentMode
      ? assistantEnabledToolNames
      : assistantEnabledToolNames.filter((name) => !blocked.has(name))
    : undefined

  return {
    loopConfig: {
      enableTools,
      includeBuiltinTools,
      maxAutoIterations: DEFAULT_AGENT_MAX_AUTO_ITERATIONS,
    },
    allowedToolNames,
    toolPreferences: isAgentMode ? assistant?.toolPreferences : undefined,
    builtinCapabilityPreferences: isAgentMode
      ? assistant?.builtinCapabilityPreferences
      : undefined,
    toolServerPreferences: isAgentMode
      ? assistant?.toolServerPreferences
      : undefined,
    bypassToolApproval: isAgentMode && yoloEnabled,
    toolCapabilityMode: isAgentMode ? 'agent' : 'ask',
    bashReadOnly: false,
    contextPolicy: BUILT_IN_CONTEXT_POLICY,
  }
}

/**
 * The same mode promise, expressed for a provider that runs its own tools.
 *
 * Providers with a native runtime never reach the tool gateway or the approval
 * UI, so the chat mode has to reach them as a policy they can enforce inside
 * their own loop. Ask stays read-only rather than tool-less: the promise is
 * "do not change my vault", not "do not look at it".
 */
export function resolveNativeToolPolicy(
  runtime: ChatModeRuntime,
): NativeToolPolicy {
  if (runtime.toolCapabilityMode !== 'agent') return 'read-only'
  return runtime.bypassToolApproval ? 'unrestricted' : 'edit'
}

/**
 * Module chat mode branch: host tool grant + mode-declared tools, no
 * assistant participation at all. Does not intersect with the assistant's
 * enabled tool set — a module mode's tool grant is fully self-declared
 * (capability tier + mode tools), never narrowed by whatever assistant
 * happens to be selected in settings.
 */
function resolveModuleChatModeRuntime(
  registered: RegisteredModuleChatModeV1,
): ChatModeRuntime {
  const capabilityProfile = resolveModuleCapabilityProfile(
    registered.mode.capability,
  )
  const moduleTools = registered.mode.tools ?? []
  const moduleToolNames = moduleTools.map((tool) =>
    getToolName(registered.serverName, tool.name),
  )
  const moduleToolApprovalPolicies = new Map<string, boolean>(
    moduleTools.map((tool) => [
      getToolName(registered.serverName, tool.name),
      tool.requiresApproval === true,
    ]),
  )
  return {
    loopConfig: {
      enableTools: true,
      includeBuiltinTools: true,
      maxAutoIterations: DEFAULT_AGENT_MAX_AUTO_ITERATIONS,
    },
    allowedToolNames: [
      ...capabilityProfile.allowedHostToolNames,
      ...moduleToolNames,
    ],
    toolPreferences: undefined,
    builtinCapabilityPreferences: undefined,
    toolServerPreferences: undefined,
    bypassToolApproval: false,
    toolCapabilityMode: registered.mode.capability === 'none' ? 'ask' : 'agent',
    bashReadOnly: capabilityProfile.bashReadOnly,
    modePersonaPrompt: registered.mode.personaPrompt,
    modePersonaModuleId: registered.moduleId,
    moduleChatModeId: registered.fullModeId,
    contextPolicy: MODULE_CONTEXT_POLICY,
    moduleToolApprovalPolicies,
  }
}
