import { Platform } from 'obsidian'

import type { BuiltinChatModeId } from '../tools/types'

/**
 * The chat-mode vocabulary: which modes exist, how a module mode is
 * recognized, and which modes carry tools.
 *
 * This lives in core rather than beside the selector that renders it because
 * a chat mode is not a UI concern: `resolveChatModeRuntime` turns one into a
 * run's tool grant and trust profile, and the agent runtime reads that on
 * every run. `ChatModeSelect.tsx` is one consumer of this vocabulary, not its
 * owner — it imports these names like everyone else and adds only the
 * selector's own props on top.
 */

/**
 * Namespaced id a module chat mode is addressed by everywhere outside its
 * own registration: `module:<moduleId>:<modeId>`. The prefix lets every
 * consumer recognize a module mode by shape alone, with no registry lookup
 * required (registry lookup is only needed to resolve *availability* — see
 * `resolveEffectiveChatMode`).
 */
export type ModuleChatModeId = `module:${string}:${string}`

/**
 * The host-native modes — excludes module chat modes. `settings.chatOptions.
 * chatMode` (global default) stays scoped to this narrower type: a global
 * default can't sensibly point at something that may be uninstalled.
 *
 * The same union the tool registry declares capability visibility against
 * (`BuiltinChatModeId`), reused rather than restated: two hand-aligned copies
 * of "which built-in modes exist" can only drift.
 */
export type BuiltinChatMode = BuiltinChatModeId

/**
 * YOLO-native capability modes plus any published module chat mode. Built-in
 * values are mutually exclusive and describe what the chat is allowed to do.
 * "Auto-approve tool calls" (YOLO) is NOT a mode — it is an orthogonal
 * boolean that only takes effect in the tool-carrying modes (Agent, Max),
 * each of which keeps its own value. See `chat-runtime-profiles.ts` and
 * `YoloByMode`.
 */
export type ChatMode = BuiltinChatMode | ModuleChatModeId

/**
 * Semantic alias for `ChatMode` used at persistence boundaries (conversation
 * overrides, settings). A persisted value may name a module mode that is
 * currently unregistered or disabled — see `resolveEffectiveChatMode`, which
 * is the only place that downgrades a persisted value for actual use.
 */
export type PersistedChatMode = ChatMode

/**
 * Values the mode selector can display. CLI runtimes may include `plan`
 * (Claude Code only) without expanding YOLO-native `ChatMode`.
 */
export type ChatModeSelectValue = ChatMode | 'plan'
export type ChatModeSelectOptionValue = ChatModeSelectValue | 'continue'

export const CHAT_MODES: readonly ChatMode[] = ['ask', 'agent', 'max']

/**
 * Max's tools are a real filesystem and a real shell (`native_files`,
 * `terminal`), neither of which exists on mobile — so mobile is never offered
 * the mode at all, and a persisted or session-override `'max'` opened there
 * runs as Agent (see `resolveEffectiveChatMode`).
 */
const MOBILE_CHAT_MODES: readonly ChatMode[] = ['ask', 'agent']

/** The built-in modes selectable on this device — see `MOBILE_CHAT_MODES`. */
export const availableBuiltinChatModes = (): readonly ChatMode[] =>
  Platform.isDesktop ? CHAT_MODES : MOBILE_CHAT_MODES

/** Full persisted/runtime module mode id format — see `ChatMode`. */
export const MODULE_CHAT_MODE_ID_RE = /^module:[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/

export const isModuleChatMode = (value: string): value is ModuleChatModeId =>
  MODULE_CHAT_MODE_ID_RE.test(value)

/**
 * The built-in modes that run the agent loop with tools: Agent and Max. Each
 * owns a trust profile, so this is also exactly the set of modes that carry a
 * YOLO switch — see `YoloByMode`.
 */
export type ToolChatMode = Extract<BuiltinChatMode, 'agent' | 'max'>

/**
 * Use this — not `isAgentChatMode` — wherever the question is "does this mode
 * have tools, an assistant, a trust profile, a task list", which is nearly
 * everywhere the codebase used to compare against `'agent'`.
 * `isAgentChatMode` is left for the few places that genuinely mean the Agent
 * mode specifically.
 */
export const isToolChatMode = (
  mode: ChatModeSelectOptionValue,
): mode is ToolChatMode => mode === 'agent' || mode === 'max'
