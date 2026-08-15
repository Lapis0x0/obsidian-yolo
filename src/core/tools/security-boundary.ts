import type { YoloSettings } from '../../settings/schema/setting.types'
import type { AssistantWorkspaceScope } from '../../types/assistant.types'
import {
  buildAllowedSkillPathSet,
  findPathOutsideScope,
  findPathWithinExcludedRoot,
} from '../agent/workspaceScope'
import { isWithinYoloUserDataRoot } from '../paths/yoloPaths'

/**
 * The two safety-critical checks that live outside every built-in tool's own
 * logic (master.md §3.4). Extracted verbatim from `callLocalFileTool`
 * (`src/core/mcp/localFileTools.ts`, formerly inline at the top of its
 * `try` block) so `dispatcher.ts` and the still-live `callLocalFileTool`
 * switch can share one implementation instead of two that could drift.
 *
 * Throws with the exact same messages the inline checks used to throw.
 * Callers must run this inside the same try/catch that normalizes thrown
 * errors into a tool error result — it does not catch anything itself.
 *
 * DO NOT inline this into a single tool's `execute` — it must stay reachable
 * from every call path, manual-approval and direct-call included ("this is
 * a security boundary" — see the comments below, copied verbatim from the
 * original call site).
 */
export function enforceBuiltinToolSecurityBoundary(
  toolName: string,
  args: Record<string, unknown>,
  {
    settings,
    workspaceScope,
    allowedSkillPaths,
  }: {
    settings?: YoloSettings
    workspaceScope?: AssistantWorkspaceScope
    allowedSkillPaths?: readonly string[]
  },
): void {
  // Final defense: reject any fs_* call whose path args fall outside the
  // agent's workspace scope. The gateway performs the same check up front
  // for UI Rejected status, but we re-validate here so manual-approval /
  // direct-call code paths cannot bypass the constraint.
  if (workspaceScope?.enabled) {
    const exemptPaths = allowedSkillPaths
      ? buildAllowedSkillPathSet(allowedSkillPaths)
      : undefined
    const offendingPath = findPathOutsideScope(toolName, args, workspaceScope, {
      exemptPaths,
    })
    if (offendingPath !== null) {
      throw new Error(
        `Path "${offendingPath}" is outside this agent's workspace scope.`,
      )
    }
  }

  // The YOLO user-data root (`<baseDir>/data`: chat history, module
  // settings/intent — see `ensureUserDataRootDir` in
  // `core/paths/yoloManagedData.ts`) must stay invisible to agent tools,
  // unconditionally and regardless of workspace scope. Before that data
  // moved out of the hidden `.yolo_json_db` directory, it could never be
  // reached this way at all — dot directories are never indexed into the
  // `TFile` tree fs_* tools resolve paths against. This reproduces that
  // same invisibility now that the root is a normal, visible folder.
  // Reported as a plain not-found, matching a genuine miss, so nothing
  // about "this path is specially hidden" leaks to the model.
  const offendingUserDataPath = findPathWithinExcludedRoot(
    toolName,
    args,
    (path) => isWithinYoloUserDataRoot(path, settings),
  )
  if (offendingUserDataPath !== null) {
    throw new Error(`File not found: ${offendingUserDataPath}`)
  }
}
