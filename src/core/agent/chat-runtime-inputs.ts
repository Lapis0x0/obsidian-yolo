import type { Assistant } from '../../types/assistant.types'
import type { ChatProject } from '../../types/project.types'

import type { RunWorkspaceScope } from './workspaceScope'

/**
 * Chat and Agent runtimes both inherit workspace scope from the selected assistant
 * so restricted Chat tools (e.g. bash) respect the same boundaries as Agent.
 *
 * Inside a project the project's scope replaces the assistant's outright —
 * no intersection, so an assistant's own scope never narrows a project. It is
 * tagged with the project id so the gates exempt the project's memory.
 */
export function resolveWorkspaceScopeForRuntimeInput(
  assistant: Assistant | null | undefined,
  project?: ChatProject | null,
): RunWorkspaceScope | undefined {
  if (project) return { ...project.workspaceScope, projectId: project.id }
  return assistant?.workspaceScope
}
