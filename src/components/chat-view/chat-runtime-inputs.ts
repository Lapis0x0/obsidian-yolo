import type { Assistant } from '../../types/assistant.types'

/**
 * Chat and Agent runtimes both inherit workspace scope from the selected assistant
 * so restricted Chat tools (e.g. fs_read/fs_search) respect the same boundaries as Agent.
 */
export function resolveWorkspaceScopeForRuntimeInput(
  assistant: Assistant | null | undefined,
): Assistant['workspaceScope'] | undefined {
  return assistant?.workspaceScope
}
