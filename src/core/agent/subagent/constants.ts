import {
  type JsSandboxSettings,
  hasAnyJsSandboxCapEnabled,
} from '../../mcp/jsSandboxSettings'
import { JS_SANDBOX_TOOL_NAME } from '../../mcp/jsSandboxTool'
import { getLocalFileToolServerName } from '../../mcp/localFileTools'
import { getToolName } from '../../mcp/tool-name-utils'

/** Matches parent agent default loop cap (`DEFAULT_AGENT_MAX_AUTO_ITERATIONS`). */
export const SUBAGENT_MAX_AUTO_ITERATIONS = 100

export const DELEGATE_SUBAGENT_TOOL_SHORT_NAME = 'delegate_subagent'

export const SUBAGENT_DEFAULT_SYSTEM_PROMPT = `You are an isolated temporary sub-agent dispatched by a parent agent.

You do not have access to the parent conversation history. Work only from this turn's task prompt and your tool results.

Guidelines:
- Complete the assigned task with a clear, final deliverable.
- Do not chat casually with the user; output results, findings, or conclusions.
- Do not claim you modified the parent conversation or user files unless your tool results show you did.
- If information is insufficient, state the gaps and uncertainty explicitly.
- Prefer focused research, inspection, summarization, or second-opinion work within the task boundary.`

/**
 * Baseline tools blocked for every child subagent run regardless of settings:
 * `delegate_subagent` (no recursive subagent dispatch) and `ask_user_question`
 * (no UI surface to render the prompt). These are runtime-enforced.
 */
export const SUBAGENT_BLOCKED_TOOL_SHORT_NAMES: readonly string[] = [
  DELEGATE_SUBAGENT_TOOL_SHORT_NAME,
  'ask_user_question',
]

const BASELINE_BLOCKED_TOOL_NAMES: readonly string[] =
  SUBAGENT_BLOCKED_TOOL_SHORT_NAMES.map((shortName) =>
    getToolName(getLocalFileToolServerName(), shortName),
  )

const JS_SANDBOX_TOOL_FQN = getToolName(
  getLocalFileToolServerName(),
  JS_SANDBOX_TOOL_NAME,
)

/**
 * Resolve the runtime block list for a subagent run.
 *
 * The baseline ({@link SUBAGENT_BLOCKED_TOOL_SHORT_NAMES}) is always denied.
 * On top of that, when JS sandbox has any extension capability enabled
 * (`allowFetch` / `allowVaultRead` / `allowDbQuery` / `allowExternalScripts`),
 * the parent agent forces `require_approval` for `js_eval` — but subagents
 * have no approval UI, so calling it would fail at execution time. We deny it
 * upfront so the model never sees an unusable tool.
 *
 * `jsSandboxSettings` defaults to `{}` for safety: a missing argument means
 * "no extension capability claimed", same as a fresh install. Callers that
 * have access to `McpManager` should still pass `getJsSandboxSettings()`
 * explicitly so future capability flags propagate without code changes here.
 */
export function buildSubagentBlockedToolNames(options?: {
  jsSandboxSettings?: JsSandboxSettings | null
}): string[] {
  const blocked = [...BASELINE_BLOCKED_TOOL_NAMES]
  const jsSandboxSettings = options?.jsSandboxSettings ?? {}
  if (hasAnyJsSandboxCapEnabled(jsSandboxSettings)) {
    blocked.push(JS_SANDBOX_TOOL_FQN)
  }
  return blocked
}
