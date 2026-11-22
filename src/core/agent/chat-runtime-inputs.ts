import type { Assistant } from '../../types/assistant.types'
import type { ChatProject } from '../../types/project.types'

/**
 * Chat and Agent runtimes both inherit workspace scope from the selected assistant
 * so restricted Chat tools (e.g. bash) respect the same boundaries as Agent.
 *
 * Inside a project the project's scope replaces the assistant's outright —
 * no intersection, so an assistant's own scope never narrows a project.
 */
export function resolveWorkspaceScopeForRuntimeInput(
  assistant: Assistant | null | undefined,
  project?: ChatProject | null,
): Assistant['workspaceScope'] | undefined {
  if (project) return project.workspaceScope
  return assistant?.workspaceScope
}
