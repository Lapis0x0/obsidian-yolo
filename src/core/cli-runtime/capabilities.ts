import type { ChatRuntimeId, CliRuntimeId } from './types'

/**
 * Static "does this runtime support X" answers, consumed only for UI
 * visibility and entry guards. Process differences must stay inside each
 * runtime implementation — never branch behavior on these fields.
 *
 * Fields are inducted from the guards they replace (see
 * `docs/plans/2026-08-11-arch-governance-step2-survey.md`); do not add a
 * field ahead of an actual guard that needs it.
 */
export type ChatRuntimeCapabilities = Readonly<{
  /** Shift+Tab plan-mode shortcut and plan/agent mode switching (A20). */
  supportsPlanMode: boolean
  /** Needs `warmConversationRuntime` before first use (A25, codex only). */
  needsWarmup: boolean
  /** Loads provider-native skills into the skills picker (A12). */
  hasNativeSkills: boolean
  /** Has a native MCP server status panel (A5, B8). */
  hasNativeMcpPanel: boolean
  /** Has a plugin manager surface (B8, claude-code only). */
  hasPluginManagement: boolean
  /** Shows the assistant selector (B5, yolo only). */
  hasAssistants: boolean
  /** Supports rewriting an already-sent user turn (A17). */
  supportsMessageRewrite: boolean
  /**
   * Shows the `/` compact-context command. Hermes supports it through its
   * `/compress` slash command, sent as a plain ACP prompt (see
   * `AcpAgentProfile.compactCommand`); other ACP agents get it only once
   * their own profile supplies a compact command.
   */
  supportsContextCompaction: boolean
  /** Supports exporting the conversation to the vault (B6, yolo only). */
  supportsVaultExport: boolean
  /** Subagent transcripts can be watched live, not just read once (C3). */
  supportsSubagentWatch: boolean
  /** Shows the main-input model control and allows `@model` mentions (B1). */
  supportsModelControl: boolean
  /** Shows the main-input reasoning-effort selector (B1). */
  supportsReasoningSelect: boolean
  /** Main input skips its yolo-only image/model capability check (B1). */
  skipsImageModelCapabilityCheck: boolean
  /** Main input allows queueing a message while a run is in flight (B1). */
  supportsQueueWhileGenerating: boolean
}>

export const RUNTIME_CAPABILITIES: Record<
  ChatRuntimeId,
  ChatRuntimeCapabilities
> = {
  yolo: {
    supportsPlanMode: false,
    needsWarmup: false,
    hasNativeSkills: false,
    hasNativeMcpPanel: false,
    hasPluginManagement: false,
    hasAssistants: true,
    supportsMessageRewrite: false,
    supportsContextCompaction: true,
    supportsVaultExport: true,
    supportsSubagentWatch: false,
    supportsModelControl: true,
    supportsReasoningSelect: true,
    skipsImageModelCapabilityCheck: false,
    supportsQueueWhileGenerating: true,
  },
  'claude-code': {
    supportsPlanMode: true,
    needsWarmup: false,
    hasNativeSkills: true,
    hasNativeMcpPanel: true,
    hasPluginManagement: true,
    hasAssistants: false,
    supportsMessageRewrite: true,
    supportsContextCompaction: true,
    supportsVaultExport: false,
    supportsSubagentWatch: false,
    supportsModelControl: false,
    supportsReasoningSelect: false,
    skipsImageModelCapabilityCheck: true,
    supportsQueueWhileGenerating: false,
  },
  codex: {
    supportsPlanMode: false,
    needsWarmup: true,
    hasNativeSkills: true,
    hasNativeMcpPanel: true,
    hasPluginManagement: false,
    hasAssistants: false,
    supportsMessageRewrite: true,
    supportsContextCompaction: true,
    supportsVaultExport: false,
    supportsSubagentWatch: true,
    supportsModelControl: false,
    supportsReasoningSelect: false,
    skipsImageModelCapabilityCheck: true,
    supportsQueueWhileGenerating: false,
  },
  hermes: {
    supportsPlanMode: false,
    needsWarmup: false,
    hasNativeSkills: false,
    hasNativeMcpPanel: false,
    hasPluginManagement: false,
    hasAssistants: false,
    supportsMessageRewrite: false,
    supportsContextCompaction: true,
    supportsVaultExport: false,
    supportsSubagentWatch: false,
    supportsModelControl: false,
    supportsReasoningSelect: false,
    skipsImageModelCapabilityCheck: true,
    supportsQueueWhileGenerating: false,
  },
  pi: {
    supportsPlanMode: false,
    needsWarmup: false,
    hasNativeSkills: false,
    hasNativeMcpPanel: false,
    hasPluginManagement: false,
    hasAssistants: false,
    supportsMessageRewrite: true,
    supportsContextCompaction: true,
    supportsVaultExport: false,
    supportsSubagentWatch: false,
    // The model/reasoning picker still shows for pi via CliRuntimeControls
    // (rendered unconditionally for every CLI runtime's main input) — these
    // two flags only gate the *yolo-native* ModelSelect/ReasoningSelect and
    // @model mention wiring, which is tied to YOLO's own model list and
    // would conflict with pi's provider-native models if turned on here.
    // Kept false, matching claude-code/codex.
    supportsModelControl: false,
    supportsReasoningSelect: false,
    skipsImageModelCapabilityCheck: true,
    supportsQueueWhileGenerating: false,
  },
}

/**
 * Single definition point for "is this a CLI runtime" — the identity check
 * that `activeRuntimeId !== 'yolo'` / `=== 'yolo'` comparisons were
 * reimplementing ad hoc across chat-view. Answers "which runtime", never
 * "what can it do" (see `RUNTIME_CAPABILITIES` for that). A type predicate
 * so callers keep the same `CliRuntimeId` narrowing a literal `!== 'yolo'`
 * comparison gave them.
 */
export const isCliRuntime = (
  runtimeId: ChatRuntimeId,
): runtimeId is CliRuntimeId => runtimeId !== 'yolo'
