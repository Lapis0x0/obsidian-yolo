import { ToolCallResponseStatus } from '../../types/tool-call.types'

import { getToolDefinition } from './registry'
import { enforceBuiltinToolSecurityBoundary } from './security-boundary'
import { asErrorMessage } from './tool-args'
import type { LocalToolCallResult, ToolContext } from './types'

/**
 * The single execution entry point for built-in tools, and the only caller of
 * `enforceBuiltinToolSecurityBoundary` (see `./security-boundary.ts`).
 *
 * Full step list (master.md §3.4 / phase1-skeleton.md D1):
 *   1. `signal.aborted` check
 *   2. workspace-scope second line of defense
 *   3. YOLO user-data-root isolation
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
