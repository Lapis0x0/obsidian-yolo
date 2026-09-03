// The whiteboard's tools, as the agent sees them
// (docs/plans/09-03-whiteboard-agent-tools/master.md D2, D3).
//
// Two tools and one renderer, and the split between them is the whole design:
//
//   - **Reading is not a tool.** A board is a file, and the model reads files
//     with `fs_read`. What the registered renderer changes is only *what it
//     gets back* — a summary instead of several hundred KB of JSON. A
//     `read_board` beside `fs_read` would make the model choose between two
//     ways to read the same thing and leave two outputs to keep in step
//     (Q23).
//   - **Writing is a tool**, because `fs_edit`'s string replacement over
//     JSON is not editing a board, it is corrupting one on a bad day. So
//     `.yoloboard` is blocked there (D4) and `edit_board` is what exists
//     instead: operations over cards and connections, never over text.
//
// Both tools are deferred by default, like every module tool set: a user who
// has never made a board pays for two names in the catalog, not two schemas.

import { applyBoardEdit } from '../domain/edit'
import {
  type Board,
  emptyBoard,
  parseBoard,
  serializeBoard,
} from '../domain/fileFormat'
import {
  previewablePaths,
  readBoardCard,
  summarizeBoard,
} from '../domain/summary'
import {
  createWhiteboardLocalizedText,
  createWhiteboardTranslation,
} from '../i18n'
import {
  GRID_WORLD_STEP_PX,
  NEW_CARD_SIZE,
  NEW_EMBED_CARD_SIZE,
} from '../ui/constants'

import { boardToolSchemas } from './boardToolSchemas'
import type { OpenBoards } from './openBoards'

export const BOARD_EXTENSION = 'yoloboard'

/**
 * How much of a note card's backing file is read before it is clipped to a
 * preview. Generous next to the ~50 characters that survive, because what
 * gets dropped first is frontmatter and blank lines, and a note whose first
 * kilobyte is all frontmatter should still show a sentence.
 */
const NOTE_PREVIEW_SOURCE_CHARS = 2000

export function registerWhiteboardAgentTools(
  host: YoloModuleHostApiV1,
  openBoards: OpenBoards,
): void {
  host.chat.registerToolSet({
    id: 'whiteboard',
    label: createWhiteboardLocalizedText('tools.label'),
    description: createWhiteboardLocalizedText('tools.description'),
    category: 'vault',
    tools: [
      {
        name: 'edit_board',
        description: boardToolSchemas.editDescription,
        inputSchema: boardToolSchemas.edit,
        handler: (input) => editBoard(host, openBoards, input),
      },
      {
        name: 'create_board',
        description: boardToolSchemas.createDescription,
        inputSchema: boardToolSchemas.create,
        handler: (input) => createBoard(host, input),
      },
    ],
  })

  host.lifecycle.add(
    host.chat.registerFileTextRenderer({
      extensions: [BOARD_EXTENSION],
      render: ({ path, content, fragment }) =>
        renderBoardForModel(host, path, content, fragment),
    }),
  )
}

// ---- reading -------------------------------------------------------------

async function renderBoardForModel(
  host: YoloModuleHostApiV1,
  path: string,
  content: string,
  fragment: string | undefined,
): Promise<string> {
  const result = parseBoard(content)
  if (!result.ok) {
    return `board: ${path}\nThis file could not be read as a whiteboard: ${result.issues
      .map((issue) => issue.type)
      .join(', ')}.`
  }
  if (fragment) {
    const card = readBoardCard(result.board, fragment)
    if (card === null) {
      return `board: ${path}\nNo card with id "${fragment}". Read the board itself to see its cards.`
    }
    return card
  }
  return summarizeBoard(result.board, {
    path,
    previews: await readNotePreviews(host, result.board),
  })
}

async function readNotePreviews(
  host: YoloModuleHostApiV1,
  board: Board,
): Promise<Map<string, string>> {
  const previews = new Map<string, string>()
  for (const notePath of previewablePaths(board)) {
    try {
      const text = await host.vault.readText(notePath)
      previews.set(notePath, noteBody(text).slice(0, NOTE_PREVIEW_SOURCE_CHARS))
    } catch {
      // A card pointing at a file that is gone is a real state a board can be
      // in, and the summary already says which path it points at. Leaving the
      // preview out says "unresolved" without turning one broken reference
      // into a failed read of the whole board.
    }
  }
  return previews
}

/** The note minus its frontmatter, which is metadata rather than what the
 * card is about. */
function noteBody(markdown: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown)
  return match ? markdown.slice(match[0].length) : markdown
}

// ---- writing -------------------------------------------------------------

type ToolResult = Readonly<{ content: string; isError?: boolean }>

const toolError = (message: string): ToolResult => ({
  content: message,
  isError: true,
})

async function editBoard(
  host: YoloModuleHostApiV1,
  openBoards: OpenBoards,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const path = readPath(input)
  if (typeof path !== 'string') return path
  const edit = input as Parameters<typeof applyBoardEdit>[1]
  const context = {
    newNodeId: () => `c-${crypto.randomUUID()}`,
    newEdgeId: () => `e-${crypto.randomUUID()}`,
    gridStep: GRID_WORLD_STEP_PX,
    textCardSize: NEW_CARD_SIZE,
    embedCardSize: NEW_EMBED_CARD_SIZE,
  }

  // The open view first: it holds a newer board than the file does for as
  // long as its debounced save is pending, and editing it is what puts the
  // change on the user's undo stack (ui/canvas.ts's agent edit surface).
  const open = openBoards.find(path)
  if (open) {
    if (!open.canAcceptAgentEdit()) {
      return toolError(
        `"${path}" is open but could not be read as a whiteboard.`,
      )
    }
    const { outcome, changed } = open.applyAgentEdit((board) => {
      const result = applyBoardEdit(board, edit, context)
      const next = result.ok && result.board !== board ? result.board : null
      return [next, { outcome: result, changed: next !== null }] as const
    })
    if (!outcome.ok) return toolError(outcome.error)
    return {
      content: changed
        ? describeEdit(path, outcome)
        : `${path}: nothing to change.`,
    }
  }

  const snapshot = await host.vault.readTextSnapshot(path)
  if (!snapshot) return toolError(`No whiteboard at "${path}".`)
  const parsed = parseBoard(snapshot.content)
  if (!parsed.ok) {
    return toolError(`"${path}" could not be read as a whiteboard.`)
  }
  const outcome = applyBoardEdit(parsed.board, edit, context)
  if (!outcome.ok) return toolError(outcome.error)
  if (outcome.board === parsed.board) {
    return { content: `${path}: nothing to change.` }
  }
  // Compare-and-swap rather than a plain write, and no retry: a conflict
  // means the board the edit was computed against is not the board on disk
  // any more, and re-applying the operations to content the model has not
  // seen is how an edit lands somewhere nobody intended.
  const written = await host.vault.replaceTextIfUnchanged(
    snapshot,
    serializeBoard(outcome.board),
  )
  if (!written) {
    return toolError(
      `"${path}" changed while this edit was being prepared. Read it again and retry.`,
    )
  }
  return { content: describeEdit(path, outcome) }
}

function describeEdit(
  path: string,
  outcome: Extract<ReturnType<typeof applyBoardEdit>, { ok: true }>,
): string {
  const lines = [`Edited ${path}.`]
  if (outcome.createdCardIds.length > 0) {
    lines.push(`new cards: ${outcome.createdCardIds.join(' ')}`)
  }
  if (outcome.createdEdgeIds.length > 0) {
    lines.push(`new connections: ${outcome.createdEdgeIds.join(' ')}`)
  }
  if (outcome.createdGroupIds.length > 0) {
    lines.push(`new groups: ${outcome.createdGroupIds.join(' ')}`)
  }
  return lines.join('\n')
}

async function createBoard(
  host: YoloModuleHostApiV1,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const path = readPath(input)
  if (typeof path !== 'string') return path
  if (await host.vault.exists(path)) {
    return toolError(`"${path}" already exists.`)
  }
  const folder = path.slice(0, Math.max(0, path.lastIndexOf('/')))
  const t = createWhiteboardTranslation(host.i18n.getSnapshot().locale)
  try {
    await host.vault.ensureFolder(folder)
    await host.vault.createText(path, serializeBoard(emptyBoard()))
  } catch (error) {
    console.error('[YOLO Whiteboard] create_board failed', error)
    return toolError(t('error.createFailed'))
  }
  return {
    content: `Created ${path}. It is empty; add cards with edit_board.`,
  }
}

/** The one check both tools start with, returned as a tool error rather than
 * thrown so the model can correct itself. */
function readPath(input: Record<string, unknown>): string | ToolResult {
  const path = input.path
  if (typeof path !== 'string' || path.trim() === '') {
    return toolError('"path" is required.')
  }
  if (!path.toLowerCase().endsWith(`.${BOARD_EXTENSION}`)) {
    return toolError(`"${path}" is not a whiteboard (.${BOARD_EXTENSION}).`)
  }
  return path
}
