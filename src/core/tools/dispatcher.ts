import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { asErrorMessage } from '../mcp/localFileTools'
import type { LocalToolCallResult } from '../mcp/localFileTools'

import { getToolDefinition } from './registry'
import { enforceBuiltinToolSecurityBoundary } from './security-boundary'
import type { ToolContext } from './types'

/**
 * The single execution entry point for built-in tools — replaces the
 * `switch (toolName)` body of `callLocalFileTool`
 * (`src/core/mcp/localFileTools.ts:2194`). Both this dispatcher and the
 * still-live `callLocalFileTool` switch call the same
 * `enforceBuiltinToolSecurityBoundary` (see `./security-boundary.ts`) so the
 * two safety-critical checks it performs can never drift between the two
 * call paths while both exist (D6 migrates the remaining tools off
 * `callLocalFileTool` and removes it; this dispatcher is the only caller
 * from then on).
 *
 * Full step list (master.md §3.4 / phase1-skeleton.md D1):
 *   1. `signal.aborted` check
 *   2. workspace-scope second line of defense (shared with `callLocalFileTool`)
 *   3. YOLO user-data-root isolation (shared with `callLocalFileTool`)
 *   4. registry lookup; unknown tool -> explicit error
 *   5. execute + normalize thrown errors
 */
export const executeBuiltinTool = async (
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<LocalToolCallResult> => {
  if (ctx.signal?.aborted) {
    return { status: ToolCallResponseStatus.Aborted }
  }

  try {
    enforceBuiltinToolSecurityBoundary(name, args, ctx)

    const definition = getToolDefinition(name)
    if (!definition) {
      throw new Error(`Unknown local file tool: ${name}`)
    }

    return await definition.execute(args, ctx)
  } catch (error) {
    return {
      status: ToolCallResponseStatus.Error,
      error: asErrorMessage(error),
    }
  }
}
