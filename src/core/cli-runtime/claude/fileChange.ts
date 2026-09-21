import type {
  FileChangeRows,
  ToolCallRequest,
  ToolCallResponse,
  ToolEditSummary,
} from '../../../types/tool-call.types'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { createToolEditSummary } from '../../../utils/chat/editSummary'
import { buildFileChangeRowsFromTexts } from '../../tools/file-change-rows'

// Claude Code's own file tools, mapped onto the shared file-change contract
// (`FileChangeRows` on the request, `editSummary` on the response). Field
// names follow the SDK's `sdk-tools.d.ts`: tool *inputs* are snake_case,
// `FileEditOutput` / `FileWriteOutput` are camelCase, `NotebookEditOutput` is
// snake_case again. SDK 0.3.220 has no `MultiEdit`.

export const CLAUDE_EDIT_TOOL = 'Edit'
export const CLAUDE_WRITE_TOOL = 'Write'
export const CLAUDE_NOTEBOOK_EDIT_TOOL = 'NotebookEdit'

const CLAUDE_FILE_CHANGE_TOOLS: ReadonlySet<string> = new Set([
  CLAUDE_EDIT_TOOL,
  CLAUDE_WRITE_TOOL,
  CLAUDE_NOTEBOOK_EDIT_TOOL,
])

export const isClaudeFileChangeTool = (toolName: string): boolean =>
  CLAUDE_FILE_CHANGE_TOOLS.has(toolName)

/**
 * Claude reports absolute paths (its cwd is the vault root). Everything the
 * chat keys on a path — the turn's checkpoint summary and each call's
 * `editSummary` alike — uses the vault-relative form, so one file is one row
 * in the edit summary panel. Paths outside the vault stay absolute.
 */
export const toVaultRelativePath = (
  vaultPath: string,
  filePath: string,
): string => {
  const normalizedVaultPath = vaultPath.replace(/\\/g, '/').replace(/\/$/, '')
  const normalizedFilePath = filePath.replace(/\\/g, '/')
  return normalizedFilePath.startsWith(`${normalizedVaultPath}/`)
    ? normalizedFilePath.slice(normalizedVaultPath.length + 1)
    : normalizedFilePath
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const readString = (
  record: Record<string, unknown>,
  key: string,
): string | undefined =>
  typeof record[key] === 'string' ? record[key] : undefined

/**
 * The Edit tool's replacement applied to `before` (`null` = no file yet), or
 * `null` when it does not apply — the same preconditions the tool enforces:
 * an empty `oldString` only creates (or fills an empty file), and without
 * `replaceAll` the match must be unique.
 */
export const applyClaudeEdit = (
  before: string | null,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string | null => {
  if (oldString === '') {
    return before === null || before === '' ? newString : null
  }
  if (before === null) return null
  const first = before.indexOf(oldString)
  if (first < 0) return null
  if (replaceAll) return before.split(oldString).join(newString)
  if (before.indexOf(oldString, first + oldString.length) >= 0) return null
  return (
    before.slice(0, first) + newString + before.slice(first + oldString.length)
  )
}

/** A completed call's change, as the tool itself reported it. */
type CompletedFileChange = {
  filePath: string
  /** Whole file before the call; `null` = the call created it. */
  before: string | null
  /** Whole file after the call. */
  after: string
  /** What the card diffs — the whole file, or one notebook cell. */
  shown: { before: string; after: string }
}

const readCompletedFileChange = (
  toolName: string,
  result: unknown,
): CompletedFileChange | null => {
  if (!isRecord(result)) return null

  if (toolName === CLAUDE_WRITE_TOOL) {
    const filePath = readString(result, 'filePath')
    const after = readString(result, 'content')
    const before = result.originalFile
    if (!filePath || after === undefined) return null
    if (before !== null && typeof before !== 'string') return null
    return { filePath, before, after, shown: { before: before ?? '', after } }
  }

  if (toolName === CLAUDE_EDIT_TOOL) {
    const filePath = readString(result, 'filePath')
    const oldString = readString(result, 'oldString')
    const newString = readString(result, 'newString')
    const before = result.originalFile
    if (!filePath || oldString === undefined || newString === undefined) {
      return null
    }
    if (before !== null && typeof before !== 'string') return null
    const after = applyClaudeEdit(
      before,
      oldString,
      newString,
      result.replaceAll === true,
    )
    if (after === null) return null
    return { filePath, before, after, shown: { before: before ?? '', after } }
  }

  if (toolName === CLAUDE_NOTEBOOK_EDIT_TOOL) {
    // The notebook JSON before/after is what the file-level stats count; the
    // card diffs the edited cell's source (`old_source` exists "to enable
    // cell-relative diff rendering"), which is readable where a JSON diff of
    // the whole `.ipynb` is not.
    const filePath = readString(result, 'notebook_path')
    const before = readString(result, 'original_file')
    const after = readString(result, 'updated_file')
    const newSource = readString(result, 'new_source')
    const oldSource = readString(result, 'old_source')
    const editMode = readString(result, 'edit_mode')
    if (
      !filePath ||
      before === undefined ||
      after === undefined ||
      readString(result, 'error') !== undefined
    ) {
      return null
    }
    const shown =
      editMode === 'insert' && newSource !== undefined
        ? { before: '', after: newSource }
        : editMode === 'replace' &&
            oldSource !== undefined &&
            newSource !== undefined
          ? { before: oldSource, after: newSource }
          : editMode === 'delete' && oldSource !== undefined
            ? { before: oldSource, after: '' }
            : null
    if (!shown) return null
    return { filePath, before, after, shown }
  }

  return null
}

const buildEditSummary = (
  path: string,
  change: CompletedFileChange,
): ToolEditSummary | undefined => {
  const summary = createToolEditSummary({
    path,
    beforeContent: change.before ?? '',
    afterContent: change.after,
    beforeExists: change.before !== null,
    afterExists: true,
  })
  if (!summary) return undefined
  // Claude wrote the file, not YOLO: there is no snapshot to undo from.
  return {
    ...summary,
    files: summary.files.map((file) => ({
      ...file,
      undoStatus: 'unavailable' as const,
    })),
    undoStatus: 'unavailable',
  }
}

const withFileChangeRows = (
  request: ToolCallRequest,
  fileChangeRows: FileChangeRows[],
): ToolCallRequest => ({
  ...request,
  metadata: { ...request.metadata, fileChangeRows },
})

/**
 * Folds a completed Edit / Write / NotebookEdit result into its tool call:
 * the card's rows onto the request (replacing any approval-time preview) and
 * this call's `editSummary` onto the response. Anything else — another tool,
 * a failed call, a result whose shape is not the SDK's — passes through
 * unchanged.
 */
export const applyClaudeFileChangeResult = (
  vaultPath: string,
  toolCall: { request: ToolCallRequest; response: ToolCallResponse },
): { request: ToolCallRequest; response: ToolCallResponse } => {
  const { request, response } = toolCall
  if (response.status !== ToolCallResponseStatus.Success) return toolCall
  const change = readCompletedFileChange(
    request.name,
    response.data.metadata?.cliToolResult,
  )
  if (!change) return toolCall
  const path = toVaultRelativePath(vaultPath, change.filePath)
  const editSummary = buildEditSummary(path, change)
  return {
    request: withFileChangeRows(request, [
      buildFileChangeRowsFromTexts(
        path,
        change.shown.before,
        change.shown.after,
      ),
    ]),
    response: editSummary
      ? {
          ...response,
          data: {
            ...response.data,
            metadata: { ...response.data.metadata, editSummary },
          },
        }
      : response,
  }
}

const isAbsolutePath = (path: string): boolean =>
  path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)

/**
 * The file a pending Edit / Write would change, when the approval preview can
 * be built from it: Claude's inputs carry absolute paths. NotebookEdit has no
 * preview — its input names a cell, and applying that to the notebook JSON
 * would be a second implementation of the tool.
 */
export const getClaudePendingFilePath = (
  toolName: string,
  input: Record<string, unknown>,
): string | null => {
  if (toolName !== CLAUDE_EDIT_TOOL && toolName !== CLAUDE_WRITE_TOOL) {
    return null
  }
  const filePath = readString(input, 'file_path')
  return filePath && isAbsolutePath(filePath) ? filePath : null
}

/**
 * The approval preview of a pending Edit / Write. Nothing has been written
 * yet, so the file as it is on disk (`current`, `null` = absent) is the
 * before-text; the after-text is the input applied to it. `null` when the
 * input does not apply to the current text.
 */
export const buildClaudePendingFileChangeRows = (
  vaultPath: string,
  toolName: string,
  input: Record<string, unknown>,
  current: string | null,
): FileChangeRows | null => {
  const filePath = getClaudePendingFilePath(toolName, input)
  if (!filePath) return null
  let after: string | null = null
  if (toolName === CLAUDE_WRITE_TOOL) {
    after = readString(input, 'content') ?? null
  } else {
    const oldString = readString(input, 'old_string')
    const newString = readString(input, 'new_string')
    after =
      oldString !== undefined && newString !== undefined
        ? applyClaudeEdit(
            current,
            oldString,
            newString,
            input.replace_all === true,
          )
        : null
  }
  if (after === null) return null
  return buildFileChangeRowsFromTexts(
    toVaultRelativePath(vaultPath, filePath),
    current ?? '',
    after,
  )
}
