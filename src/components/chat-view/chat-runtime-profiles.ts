import type { App } from 'obsidian'

import { resolveMaxEnvironmentPrompt } from '../../core/agent/max-environment-prompt'
import type { ToolCapabilityMode } from '../../core/agent/tool-capability-prompt'
import type { AgentRuntimeLoopConfig } from '../../core/agent/types'
import { getToolName } from '../../core/mcp/tool-name-utils'
import { resolveModuleCapabilityProfile } from '../../core/modules/moduleCapabilityProfile'
import type { RegisteredModuleChatModeV1 } from '../../core/modules/moduleChatModeRegistry'
import {
  getToolNamesForChatMode,
  listBuiltinToolNames,
} from '../../core/tools/registry'
import type { BuiltinChatModeId } from '../../core/tools/types'
import type { Assistant } from '../../types/assistant.types'
import type { NativeToolPolicy } from '../../types/llm/request'

import type { ChatMode } from './chat-input/ChatModeSelect'
import { isModuleChatMode, isToolChatMode } from './chat-input/ChatModeSelect'

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
 * Every built-in tool, by fully-qualified name. Membership in this set is the
 * only thing that decides whether a name is subject to per-mode visibility at
 * all: an MCP server's tool or a module tool set's tool is not this layer's
 * business and passes through untouched.
 */
const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(listBuiltinToolNames())

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
  /**
   * Environment facts the running mode has to state to the model — cwd, OS,
   * shell, date, tool discipline. Only Max produces one (see
   * `buildMaxEnvironmentPrompt`); it rides the same runtime → agent input →
   * `requestContextBuilder` pipeline as `modePersonaPrompt` and lands in its
   * own `system.max-mode` section.
   */
  modeEnvironmentPrompt?: string
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
   * the tool modes, Agent and Max, each of which stores its own value (see
   * `yoloPreferenceKeyForMode`).
   */
  yoloEnabled?: boolean
  /**
   * Needed only to describe Max's environment to the model (cwd comes from
   * the vault's real directory — see `resolveMaxEnvironmentPrompt`). Callers
   * that can never run Max — Quick Ask, tests of the Ask/Agent/module
   * branches — omit it; every surface that offers the mode passes it.
   */
  app?: App
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
  app,
  assistant,
  assistantEnabledToolNames,
  moduleChatMode,
}: ChatModeRuntimeInput): ChatModeRuntime {
  if (isModuleChatMode(mode) && moduleChatMode) {
    return resolveModuleChatModeRuntime(moduleChatMode)
  }

  const modeEnvironmentPrompt =
    mode === 'max' && app ? resolveMaxEnvironmentPrompt(app) : undefined

  const enableTools = assistant?.enableTools ?? true
  const includeBuiltinTools = enableTools
    ? (assistant?.includeBuiltinTools ?? true)
    : false

  // Which built-in mode's capability grant applies. A module chat mode that
  // reached here without its registration (the defensive fallback below) is
  // not a tool mode, so it lands on 'ask'.
  const builtinMode: BuiltinChatModeId =
    mode === 'max' ? 'max' : mode === 'agent' ? 'agent' : 'ask'
  // Max and Agent are the same shape at this layer — the assistant
  // participates, tools run, YOLO applies. Everything that differs between
  // them is declared per capability (`chatModes`) and resolved above, not
  // branched on here.
  const isToolMode = isToolChatMode(mode)
  const exposedBuiltinToolNames = new Set(getToolNamesForChatMode(builtinMode))
  const allowedToolNames = enableTools
    ? assistantEnabledToolNames.filter(
        (name) =>
          !BUILTIN_TOOL_NAMES.has(name) || exposedBuiltinToolNames.has(name),
      )
    : undefined

  return {
    loopConfig: {
      enableTools,
      includeBuiltinTools,
      maxAutoIterations: DEFAULT_AGENT_MAX_AUTO_ITERATIONS,
    },
    allowedToolNames,
    toolPreferences: isToolMode ? assistant?.toolPreferences : undefined,
    builtinCapabilityPreferences: isToolMode
      ? assistant?.builtinCapabilityPreferences
      : undefined,
    toolServerPreferences: isToolMode
      ? assistant?.toolServerPreferences
      : undefined,
    bypassToolApproval: isToolMode && yoloEnabled,
    toolCapabilityMode: builtinMode,
    bashReadOnly: false,
    contextPolicy: BUILT_IN_CONTEXT_POLICY,
    modeEnvironmentPrompt,
  }
}

/**
 * The same mode promise, expressed for a provider that runs its own tools.
 *
 * Providers with a native runtime never reach the tool gateway or the approval
 * UI, so the chat mode has to reach them as a policy they can enforce inside
 * their own loop. Ask stays read-only rather than tool-less: the promise is
 * "do not change my vault", not "do not look at it".
 *
 * Max maps onto the same policy as Agent, not a wider one: `NativeToolPolicy`
 * describes what a *provider's own* tools may do, and Max's extra reach comes
 * entirely from YOLO tools that such a provider never runs. Promising more
 * here would hand a provider's sandbox permissions we never granted it.
 */
export function resolveNativeToolPolicy(
  runtime: ChatModeRuntime,
): NativeToolPolicy {
  if (
    runtime.toolCapabilityMode !== 'agent' &&
    runtime.toolCapabilityMode !== 'max'
  ) {
    return 'read-only'
  }
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
