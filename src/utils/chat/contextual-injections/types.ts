import type { App, TFile } from 'obsidian'

import type { TodoItem } from '../../../core/agent/todos-from-messages'
import type { CurrentFileViewState } from '../../../types/mentionable'

/**
 * Pointer-style injection used by Sidebar Chat focus sync.
 * Tells the agent which file the user is viewing + position metadata,
 * but does NOT include file content. The agent decides whether to read.
 */
export type CurrentFilePointerInjection = {
  type: 'current-file-pointer'
  file: TFile
  viewState?: CurrentFileViewState
}

export type EditorSnapshotSelection = {
  content: string
  filePath: string
}

/**
 * Content-style injection used by Quick Ask.
 * Captures the editor's current scene (file path/title, surrounding cursor
 * context, optional selection) and feeds it directly to the model — Quick Ask
 * is invoked with the assumption the model must operate on what the user is
 * looking at right now.
 */
export type EditorSnapshotInjection = {
  type: 'editor-snapshot'
  filePath: string
  fileTitle: string
  /** Text around cursor; may contain `cursorMarker` at the cursor position. */
  contextText: string
  cursorMarker: string
  selection?: EditorSnapshotSelection
}

export type TodoListInjection = {
  type: 'todo-list'
  todos: ReadonlyArray<TodoItem>
}

/**
 * Browser context injection. Emitted when focus sync is enabled and the user's
 * most-recent root-split leaf is a supported `<webview>` host (core Web Viewer
 * or .url WebView Opener).
 *
 * The app reference is captured at build time, but the active webview is
 * resolved lazily only when the injection is rendered. This avoids touching
 * webview DOM while the user is merely browsing or while context previews are
 * being prepared.
 */
export type BrowserContextInjection = {
  type: 'browser-context'
  app: App
}

export type ContextualInjection =
  | CurrentFilePointerInjection
  | EditorSnapshotInjection
  | TodoListInjection
  | BrowserContextInjection
