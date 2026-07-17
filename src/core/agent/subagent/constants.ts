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
 *
 * Tools that merely require approval (`js_eval` with high-risk caps, `fs_edit`
 * in review mode, etc.) are NOT blocked here — their approval requests are
 * routed to the parent conversation's UI (the SubagentCard renders an inline
 * approval block). See `docs/plans/2026-06-18-subagent-tool-approval-routing.md`.
 */
export const SUBAGENT_BLOCKED_TOOL_SHORT_NAMES: readonly string[] = [
  DELEGATE_SUBAGENT_TOOL_SHORT_NAME,
  'ask_user_question',
]

export const SUBAGENT_BLOCKED_TOOL_NAMES: readonly string[] =
  SUBAGENT_BLOCKED_TOOL_SHORT_NAMES.map((shortName) =>
    getToolName(getLocalFileToolServerName(), shortName),
  )
