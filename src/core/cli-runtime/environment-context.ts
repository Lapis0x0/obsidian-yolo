import type { App, TFile } from 'obsidian'

import type { ContentPart } from '../../types/llm/request'
import type { CurrentFileViewState } from '../../types/mentionable'
import type { ChatProject } from '../../types/project.types'
import {
  renderBrowserContextInjection,
  renderCurrentFilePointerInjection,
  renderInjectedContext,
} from '../../utils/chat/contextual-injections'
import {
  type MemorySettingsLike,
  resolveMemoryIndexPaths,
} from '../memory/memoryStore'
import { resolveProjectInstructionFilePaths } from '../project-instructions'

import { RUNTIME_CAPABILITIES } from './capabilities'
import type { CliRuntimeId } from './types'

export type BuildCliEnvironmentContextInput = {
  app: App
  runtimeId: CliRuntimeId
  currentFile: TFile | null
  currentFileViewState?: CurrentFileViewState
  /**
   * The conversation's project, passed only on the first turn
   * ({@link isFirstCliTurn}); the settings resolve its memory path.
   */
  project?: ChatProject | null
  settings?: MemorySettingsLike
}

/**
 * Tells a CLI agent which project the conversation belongs to. CLI agents
 * start at the vault root and are not restricted by the project's scope, so
 * this is guidance only: the folders to focus on, the project instruction
 * files below the root (the root ones the CLI already discovers itself), and
 * the project memory index when one exists.
 *
 * Sent once, on the conversation's first turn (see {@link isFirstCliTurn}).
 * It is conversation-level context, unlike the per-turn environment snapshot
 * it rides along with: the CLI keeps every turn in its own session history,
 * so repeating it would pile up identical copies. ACP runtimes have no system
 * prompt to put it in, so the first turn is the one place every runtime
 * shares. A conversation moved into a project later is not told.
 */
export const isFirstCliTurn = (
  messages: readonly { role: string; id: string }[],
  rewrittenMessageId?: string,
): boolean => {
  const firstUserMessage = messages.find((message) => message.role === 'user')
  return !firstUserMessage || firstUserMessage.id === rewrittenMessageId
}

export const renderCliProjectContext = ({
  app,
  project,
  settings,
}: {
  app: App
  project: ChatProject
  settings?: MemorySettingsLike
}): string => {
  const { include, exclude } = project.workspaceScope
  const scoped = project.workspaceScope.enabled
  const lines = [
    `This conversation belongs to the YOLO project ${JSON.stringify(project.name)}.`,
  ]
  if (scoped && include.length > 0) {
    lines.push(
      `- Focus folders: ${include.join(', ')}. Work within them unless the user asks otherwise.`,
    )
  }
  if (scoped && exclude.length > 0) {
    lines.push(`- Leave alone: ${exclude.join(', ')}.`)
  }
  const instructionFiles = [
    ...resolveProjectInstructionFilePaths(app, true, project.workspaceScope),
  ].filter(
    (path) => path.includes('/') && app.vault.getFileByPath(path) !== null,
  )
  if (instructionFiles.length > 0) {
    lines.push(
      `- Project instructions, read before acting: ${instructionFiles.join(', ')}`,
    )
  }
  const memoryIndex = resolveMemoryIndexPaths({
    settings,
    projectId: project.id,
  }).project
  if (memoryIndex && app.vault.getFileByPath(memoryIndex) !== null) {
    lines.push(
      `- Project memory index: ${memoryIndex}. Read it for durable facts about this project.`,
    )
  }
  return `<project>\n${lines.join('\n')}\n</project>`
}

/**
 * Capture the Obsidian environment visible when a new CLI turn is submitted.
 * The returned parts become provider-owned turn content, so retries and
 * continuations retain the original snapshot instead of following later UI
 * focus changes.
 */
export const buildCliEnvironmentContext = async ({
  app,
  runtimeId,
  currentFile,
  currentFileViewState,
  project,
  settings,
}: BuildCliEnvironmentContextInput): Promise<ContentPart[]> => {
  const currentFileContext = currentFile
    ? renderCurrentFilePointerInjection({
        type: 'current-file-pointer',
        file: currentFile,
        viewState: currentFileViewState,
      })
    : null
  const browserContext = await renderBrowserContextInjection({
    type: 'browser-context',
    app,
  })

  const parts = await renderInjectedContext(
    [...(currentFileContext ?? []), ...(browserContext ?? [])],
    app,
  )
  if (project) {
    parts.unshift({
      type: 'text',
      text: renderCliProjectContext({ app, project, settings }),
    })
  }

  // Viewing an image file makes the current-file pointer contribute the
  // image itself. A runtime that takes no images would fail the whole turn
  // over context the user never attached, so drop just that part — the
  // pointer text naming the file still goes through.
  return RUNTIME_CAPABILITIES[runtimeId].supportsImageAttachments
    ? parts
    : parts.filter((part) => part.type !== 'image_url')
}
