import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { asErrorMessage } from '../mcp/localFileTools'
import type { LocalToolCallResult } from '../mcp/localFileTools'

import { getToolDefinition } from './registry'
import type { ToolContext } from './types'

/**
 * The single execution entry point for built-in tools — replaces the
 * `switch (toolName)` body of `callLocalFileTool`
 * (`src/core/mcp/localFileTools.ts:2176`) once D5 wires it up. Not called
 * from `mcpManager` or any live path yet: this phase only establishes the
 * contract and the steps that don't require relocating safety-critical
 * logic. `localFileTools.ts` is untouched and keeps serving every real tool
 * call until D5.
 *
 * Full step list (master.md §3.4 / phase1-skeleton.md D1):
 *   1. `signal.aborted` check                       — implemented below
 *   2. workspace-scope second line of defense        — TODO(D5)
 *   3. YOLO user-data-root isolation                 — TODO(D5)
 *   4. registry lookup; unknown tool -> explicit error — implemented below
 *   5. execute + normalize thrown errors              — implemented below
 */
export const executeBuiltinTool = async (
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<LocalToolCallResult> => {
  if (ctx.signal?.aborted) {
    return { status: ToolCallResponseStatus.Aborted }
  }

  // TODO(D5): workspace-scope second line of defense. Move verbatim from
  // `localFileTools.ts:2232` (the `findPathOutsideScope` call guarded by
  // `workspaceScope?.enabled`). Its comment there says why re-validation
  // here (not just at the gateway) matters: "manual-approval / direct-call
  // code paths cannot bypass the constraint." This is a security boundary —
  // relocate it unchanged, do not reimplement it ahead of time.

  // TODO(D5): YOLO user-data-root isolation. Move verbatim from
  // `localFileTools.ts:2256` (the `findPathWithinExcludedRoot` call). Must
  // stay unconditional and independent of workspace scope — this is a
  // security boundary, relocate it unchanged.

  const definition = getToolDefinition(name)
  if (!definition) {
    return {
      status: ToolCallResponseStatus.Error,
      error: `Unknown local file tool: ${name}`,
    }
  }

  try {
    return await definition.execute(args, ctx)
  } catch (error) {
    return {
      status: ToolCallResponseStatus.Error,
      error: asErrorMessage(error),
    }
  }
}
