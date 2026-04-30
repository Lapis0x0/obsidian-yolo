import type { Assistant } from '../../types/assistant.types'

/**
 * Unified current-file attachment mode for both Chat and Agent runtimes.
 * Uses path/title summary only (see RequestContextBuilder.getCurrentFileSummaryMessage).
 */
export function resolveCurrentFileContextModeForRuntime(): 'summary' {
  return 'summary'
}

/**
 * Chat and Agent runtimes both inherit workspace scope from the selected assistant
 * so restricted Chat tools (e.g. fs_read/fs_search) respect the same boundaries as Agent.
 */
export function resolveWorkspaceScopeForRuntimeInput(
  assistant: Assistant | null | undefined,
): Assistant['workspaceScope'] | undefined {
  return assistant?.workspaceScope
}
