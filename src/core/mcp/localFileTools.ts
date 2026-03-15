import { App, TFile, TFolder, normalizePath } from 'obsidian'

import {
  materializeTextEditPlan,
  recoverLikelyEscapedBackslashSequences,
  type TextEditOperation,
  type TextEditPlan,
} from '../edits/textEditEngine'
import type { SmartComposerSettings } from '../../settings/schema/setting.types'
import type { ApplyViewState } from '../../types/apply-view.types'
import { McpTool } from '../../types/mcp.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import {
  getLiteSkillDocument,
  listLiteSkillEntries,
} from '../skills/liteSkills'

export { recoverLikelyEscapedBackslashSequences }

const LOCAL_FILE_TOOL_SERVER = 'yolo_local'
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024
const MAX_BATCH_READ_FILES = 20
const DEFAULT_READ_START_LINE = 1
const DEFAULT_READ_MAX_LINES = 50
const MAX_READ_MAX_LINES = 2000
const MAX_READ_LINE_INDEX = 1_000_000
const DEFAULT_MAX_BATCH_CHARS_PER_FILE = 20_000
const MAX_BATCH_WRITE_ITEMS = 50

type LocalFileToolName =
  | 'fs_list'
  | 'fs_search'
  | 'fs_read'
  | 'fs_edit'
  | 'fs_create_file'
  | 'fs_delete_file'
  | 'fs_create_dir'
  | 'fs_delete_dir'
  | 'fs_move'
  | 'open_skill'
type FsSearchScope = 'files' | 'dirs' | 'content' | 'all'
type FsListScope = 'files' | 'dirs' | 'all'
type FsFileOpAction =
  | 'create_file'
  | 'delete_file'
  | 'create_dir'
  | 'delete_dir'
  | 'move'

type LocalToolCallResult =
  | {
      status: ToolCallResponseStatus.Success
      text: string
    }
  | {
      status: ToolCallResponseStatus.Rejected
    }
  | {
      status: ToolCallResponseStatus.Error
      error: string
    }
  | {
      status: ToolCallResponseStatus.Aborted
    }

type FsResultItem = {
  ok: boolean
  action: FsFileOpAction
  target: string
  message: string
}

type FsEditReviewResult =
  | {
      status: ToolCallResponseStatus.Success
      finalContent: string
    }
  | {
      status: ToolCallResponseStatus.Rejected
    }
  | {
      status: ToolCallResponseStatus.Aborted
    }

const LOCAL_FS_SPLIT_ACTION_TOOL_TO_ACTION = {
  fs_create_file: 'create_file',
  fs_delete_file: 'delete_file',
  fs_create_dir: 'create_dir',
  fs_delete_dir: 'delete_dir',
  fs_move: 'move',
} as const

export const LOCAL_FS_SPLIT_ACTION_TOOL_NAMES = Object.keys(
  LOCAL_FS_SPLIT_ACTION_TOOL_TO_ACTION,
) as Array<keyof typeof LOCAL_FS_SPLIT_ACTION_TOOL_TO_ACTION>

const LOCAL_FS_WRITE_TOOL_NAMES = new Set<string>([
  'fs_edit',
  ...LOCAL_FS_SPLIT_ACTION_TOOL_NAMES,
])

const asErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return typeof error === 'string' ? error : JSON.stringify(error)
}

const asOptionalString = (value: unknown): string => {
  return typeof value === 'string' ? value : ''
}

const offsetToSelectionPosition = (content: string, offset: number) => {
  const clampedOffset = Math.max(0, Math.min(offset, content.length))
  const before = content.slice(0, clampedOffset)
  const lines = before.split('\n')

  return {
    line: Math.max(0, lines.length - 1),
    ch: lines.at(-1)?.length ?? 0,
  }
}

const getFsEditSelectionRange = (
  content: string,
  operationResults: ReturnType<
    typeof materializeTextEditPlan
  >['operationResults'],
): ApplyViewState['selectionRange'] | undefined => {
  const changedRanges = operationResults
    .map((result) => {
      if (!result.changed) {
        return undefined
      }
      return result.matchedRange ?? result.newRange
    })
    .filter((range): range is NonNullable<typeof range> => Boolean(range))

  if (changedRanges.length === 0) {
    return undefined
  }

  const start = Math.min(...changedRanges.map((range) => range.start))
  const end = Math.max(...changedRanges.map((range) => range.end))

  return {
    from: offsetToSelectionPosition(content, start),
    to: offsetToSelectionPosition(content, end),
  }
}

const waitForFsEditReview = async ({
  openApplyReview,
  file,
  originalContent,
  newContent,
  selectionRange,
  signal,
}: {
  openApplyReview: (state: ApplyViewState) => Promise<boolean>
  file: TFile
  originalContent: string
  newContent: string
  selectionRange: ApplyViewState['selectionRange']
  signal?: AbortSignal
}): Promise<FsEditReviewResult> => {
  if (signal?.aborted) {
    return { status: ToolCallResponseStatus.Aborted }
  }

  let settled = false

  const reviewResultPromise = new Promise<FsEditReviewResult>((resolve) => {
    const settle = (result: FsEditReviewResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    void openApplyReview({
      file,
      originalContent,
      newContent,
      reviewMode: selectionRange ? 'selection-focus' : 'full',
      selectionRange,
      abortSignal: signal,
      callbacks: {
        onComplete: ({ finalContent }) => {
          settle(
            finalContent === originalContent
              ? { status: ToolCallResponseStatus.Rejected }
              : {
                  status: ToolCallResponseStatus.Success,
                  finalContent,
                },
          )
        },
        onCancel: () => {
          settle({ status: ToolCallResponseStatus.Aborted })
        },
      },
    })
      .then((opened) => {
        if (!opened) {
          settle({ status: ToolCallResponseStatus.Aborted })
        }
      })
      .catch(() => {
        settle({ status: ToolCallResponseStatus.Aborted })
      })
  })

  if (!signal) {
    return reviewResultPromise
  }

  return await Promise.race([
    reviewResultPromise,
    new Promise<FsEditReviewResult>((resolve) => {
      signal.addEventListener(
        'abort',
        () => resolve({ status: ToolCallResponseStatus.Aborted }),
        { once: true },
      )
    }),
  ])
}

const validateVaultPath = (path: string): string => {
  const normalizedPath = normalizePath(path).trim()

  if (normalizedPath.length === 0) {
    throw new Error('Path is required.')
  }
  if (
    normalizedPath.startsWith('/') ||
    normalizedPath.startsWith('./') ||
    normalizedPath.startsWith('../')
  ) {
    throw new Error('Path must be a vault-relative path.')
  }
  if (normalizedPath.includes('/../') || normalizedPath.endsWith('/..')) {
    throw new Error('Path cannot contain parent directory traversal.')
  }

  return normalizedPath
}

export function getLocalFileToolServerName(): string {
  return LOCAL_FILE_TOOL_SERVER
}

export function getLocalFileTools(): McpTool[] {
  return [
    {
      name: 'fs_list',
      description:
        'List directory structure under a vault path. Useful for workspace orientation.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Optional vault-relative directory path. Omit or use "/" for vault root.',
          },
          depth: {
            type: 'integer',
            description:
              'Traversal depth from the target directory. Defaults to 1, range 1-10.',
          },
          maxResults: {
            type: 'integer',
            description:
              'Maximum entries to return. Defaults to 200, range 1-2000.',
          },
        },
      },
    },
    {
      name: 'fs_search',
      description:
        'Search files, folders, or markdown content in vault. Scope controls target type.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ['files', 'dirs', 'content', 'all'],
            description:
              'Search scope. content/all reads markdown contents; files/dirs only match paths.',
          },
          query: {
            type: 'string',
            description:
              'Keyword to search. Optional for files/dirs listing. Required when scope includes content.',
          },
          path: {
            type: 'string',
            description:
              'Optional vault-relative directory path to scope search.',
          },
          maxResults: {
            type: 'integer',
            description:
              'Maximum results to return. Defaults to 20, range 1-300.',
          },
          caseSensitive: {
            type: 'boolean',
            description:
              'Whether matching should be case-sensitive. Mainly useful for content scope.',
          },
        },
        required: ['scope'],
      },
    },
    {
      name: 'fs_read',
      description: `Read line ranges from multiple vault files by path. Defaults to the first ${DEFAULT_READ_MAX_LINES} lines.`,
      inputSchema: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: {
              type: 'string',
            },
            description: `Vault-relative file paths. Maximum ${MAX_BATCH_READ_FILES} items.`,
          },
          startLine: {
            type: 'integer',
            description: `1-based start line. Defaults to ${DEFAULT_READ_START_LINE}.`,
          },
          maxLines: {
            type: 'integer',
            description: `Maximum lines to return when endLine is not set. Defaults to ${DEFAULT_READ_MAX_LINES}, range 1-${MAX_READ_MAX_LINES}.`,
          },
          endLine: {
            type: 'integer',
            description:
              'Optional 1-based inclusive end line. If set, maxLines is ignored.',
          },
          maxCharsPerFile: {
            type: 'integer',
            description: `Safety cap for returned chars per file after line slicing. Defaults to ${DEFAULT_MAX_BATCH_CHARS_PER_FILE}, range 100-200000.`,
          },
        },
        required: ['paths'],
      },
    },
    {
      name: 'fs_edit',
      description:
        'Apply text edit operations within a single existing file. Supports replace, insert_after, and append.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Vault-relative file path.',
          },
          operations: {
            type: 'array',
            description:
              'Ordered text edit operations to apply. Supports replace, insert_after, and append.',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['replace', 'insert_after', 'append'],
                },
                oldText: {
                  type: 'string',
                  description: 'Required for replace.',
                },
                newText: {
                  type: 'string',
                  description: 'Required for replace.',
                },
                anchor: {
                  type: 'string',
                  description: 'Required for insert_after.',
                },
                content: {
                  type: 'string',
                  description: 'Required for insert_after and append.',
                },
                expectedOccurrences: {
                  type: 'integer',
                  description:
                    'Optional positive integer match count for replace and insert_after. Defaults to 1.',
                },
              },
              required: ['type'],
            },
          },
        },
        required: ['path', 'operations'],
      },
    },
    {
      name: 'fs_create_file',
      description:
        'Create a single file in the vault. Use for one-file creation with explicit path and content.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Vault-relative file path.',
          },
          content: {
            type: 'string',
            description: 'Full file content.',
          },
          dryRun: {
            type: 'boolean',
            description:
              'If true, validate and preview result without applying changes.',
          },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'fs_delete_file',
      description: 'Delete a single existing file in the vault.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Vault-relative file path.',
          },
          dryRun: {
            type: 'boolean',
            description:
              'If true, validate and preview result without applying changes.',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'fs_create_dir',
      description: 'Create a single folder in the vault.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Vault-relative folder path.',
          },
          dryRun: {
            type: 'boolean',
            description:
              'If true, validate and preview result without applying changes.',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'fs_delete_dir',
      description: 'Delete a single existing folder in the vault.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Vault-relative folder path.',
          },
          recursive: {
            type: 'boolean',
            description:
              'Default false; when false non-empty folders cannot be deleted.',
          },
          dryRun: {
            type: 'boolean',
            description:
              'If true, validate and preview result without applying changes.',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'fs_move',
      description:
        'Move or rename a single file/folder path in the vault from oldPath to newPath.',
      inputSchema: {
        type: 'object',
        properties: {
          oldPath: {
            type: 'string',
            description: 'Vault-relative source path.',
          },
          newPath: {
            type: 'string',
            description: 'Vault-relative destination path.',
          },
          dryRun: {
            type: 'boolean',
            description:
              'If true, validate and preview result without applying changes.',
          },
        },
        required: ['oldPath', 'newPath'],
      },
    },
    {
      name: 'open_skill',
      description:
        'Load a lite skill from the configured skills directory by id or name and return full markdown content.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Skill id from frontmatter.',
          },
          name: {
            type: 'string',
            description: 'Skill name from frontmatter.',
          },
        },
      },
    },
  ]
}

const getTextArg = (args: Record<string, unknown>, key: string): string => {
  const value = args[key]
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string.`)
  }
  return value
}

const getOptionalTextArg = (
  args: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = args[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string.`)
  }
  return value
}

const getOptionalIntegerArg = ({
  args,
  key,
  defaultValue,
  min,
  max,
}: {
  args: Record<string, unknown>
  key: string
  defaultValue: number
  min: number
  max: number
}): number => {
  const value = args[key]
  if (value === undefined) {
    return defaultValue
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer.`)
  }
  if (value < min || value > max) {
    throw new Error(`${key} must be between ${min} and ${max}.`)
  }
  return value
}

const getOptionalBoundedIntegerArg = ({
  args,
  key,
  min,
  max,
}: {
  args: Record<string, unknown>
  key: string
  min: number
  max: number
}): number | undefined => {
  const value = args[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer.`)
  }
  if (value < min || value > max) {
    throw new Error(`${key} must be between ${min} and ${max}.`)
  }
  return value
}

const getOptionalBooleanArg = (
  args: Record<string, unknown>,
  key: string,
): boolean | undefined => {
  const value = args[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${key} must be a boolean.`)
  }
  return value
}

const getStringArrayArg = (
  args: Record<string, unknown>,
  key: string,
): string[] => {
  const value = args[key]
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array of strings.`)
  }
  if (value.some((item) => typeof item !== 'string')) {
    throw new Error(`${key} must be an array of strings.`)
  }
  return value
}

const getRecordArrayArg = (
  args: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] => {
  const value = args[key]
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array.`)
  }
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`${key}[${index}] must be an object.`)
    }
    return item as Record<string, unknown>
  })
}

const assertContentSize = (content: string): void => {
  if (content.length > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `Content too large (${content.length} chars). Max allowed is ${MAX_FILE_SIZE_BYTES}.`,
    )
  }
}

const resolveFolderByPath = (
  app: App,
  rawPath: string | undefined,
): { folder: TFolder; normalizedPath: string } => {
  const trimmedPath = rawPath?.trim()
  // Treat "/" as vault root for better model compatibility.
  if (!trimmedPath || trimmedPath === '/') {
    return { folder: app.vault.getRoot(), normalizedPath: '' }
  }

  const normalizedPath = validateVaultPath(trimmedPath)
  const abstractFile = app.vault.getAbstractFileByPath(normalizedPath)

  if (!abstractFile) {
    throw new Error(`Folder not found: ${normalizedPath}`)
  }
  if (!(abstractFile instanceof TFolder)) {
    throw new Error(`Path is not a folder: ${normalizedPath}`)
  }

  return { folder: abstractFile, normalizedPath }
}

const isPathWithinFolder = (filePath: string, folderPath: string): boolean => {
  if (!folderPath) {
    return true
  }
  return filePath.startsWith(`${folderPath}/`)
}

const getParentFolderPath = (path: string): string => {
  const lastSlashIndex = path.lastIndexOf('/')
  return lastSlashIndex === -1 ? '' : path.slice(0, lastSlashIndex)
}

const makeContentSnippet = ({
  content,
  matchIndex,
  matchLength,
}: {
  content: string
  matchIndex: number
  matchLength: number
}): string => {
  const radius = 120
  const start = Math.max(0, matchIndex - radius)
  const end = Math.min(content.length, matchIndex + matchLength + radius)
  const snippet = content.slice(start, end).replace(/\s+/g, ' ').trim()

  const prefix = start > 0 ? '...' : ''
  const suffix = end < content.length ? '...' : ''
  return `${prefix}${snippet}${suffix}`
}

const getFsSearchScope = (args: Record<string, unknown>): FsSearchScope => {
  const value = args.scope
  if (
    value !== 'files' &&
    value !== 'dirs' &&
    value !== 'content' &&
    value !== 'all'
  ) {
    throw new Error('scope must be one of: files, dirs, content, all.')
  }
  return value
}

const getFsListScope = (args: Record<string, unknown>): FsListScope => {
  const value = args.scope
  if (value === undefined) {
    return 'all'
  }
  if (value !== 'files' && value !== 'dirs' && value !== 'all') {
    throw new Error('scope must be one of: files, dirs, all.')
  }
  return value
}

const asPositiveInteger = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return undefined
  }
  return value
}

const parseTextEditOperation = (
  operation: Record<string, unknown>,
  index: number,
): TextEditOperation => {
  const type = asOptionalString(operation.type).trim().toLowerCase()

  if (type === 'replace') {
    const oldText = getTextArg(operation, 'oldText')
    if (oldText.length === 0) {
      throw new Error(`operations[${index}].oldText must not be empty.`)
    }

    return {
      type: 'replace',
      oldText,
      newText: getTextArg(operation, 'newText'),
      expectedOccurrences: asPositiveInteger(operation.expectedOccurrences),
    }
  }

  if (type === 'insert_after') {
    const anchor = getTextArg(operation, 'anchor')
    if (anchor.length === 0) {
      throw new Error(`operations[${index}].anchor must not be empty.`)
    }

    return {
      type: 'insert_after',
      anchor,
      content: getTextArg(operation, 'content'),
      expectedOccurrences: asPositiveInteger(operation.expectedOccurrences),
    }
  }

  if (type === 'append') {
    return {
      type: 'append',
      content: getTextArg(operation, 'content'),
    }
  }

  throw new Error(
    `operations[${index}].type must be one of: replace, insert_after, append.`,
  )
}

const getFsEditPlan = (args: Record<string, unknown>): TextEditPlan => {
  const operations = getRecordArrayArg(args, 'operations').map(
    (operation, index) => {
      return parseTextEditOperation(operation, index)
    },
  )

  if (operations.length === 0) {
    throw new Error('operations cannot be empty.')
  }

  return { operations }
}

const ensureParentFolderExists = (app: App, path: string): void => {
  const parentFolderPath = getParentFolderPath(path)
  if (!parentFolderPath) {
    return
  }
  const parentFolder = app.vault.getAbstractFileByPath(parentFolderPath)
  if (!parentFolder || !(parentFolder instanceof TFolder)) {
    throw new Error(`Target parent folder not found: ${parentFolderPath}`)
  }
}

const formatJsonResult = (payload: unknown): string => {
  return JSON.stringify(payload, null, 2)
}

const normalizeLocalToolName = (toolName: string): string => {
  if (!toolName.includes('__')) {
    return toolName
  }
  const parts = toolName.split('__')
  return parts[parts.length - 1] ?? toolName
}

export function isLocalFsWriteToolName(toolName: string): boolean {
  return LOCAL_FS_WRITE_TOOL_NAMES.has(normalizeLocalToolName(toolName))
}

export function parseLocalFsActionFromToolArgs({
  toolName,
  args: _args,
}: {
  toolName: string
  args?: Record<string, unknown> | string
}): FsFileOpAction | null {
  const normalizedToolName = normalizeLocalToolName(toolName)
  const splitAction =
    LOCAL_FS_SPLIT_ACTION_TOOL_TO_ACTION[
      normalizedToolName as keyof typeof LOCAL_FS_SPLIT_ACTION_TOOL_TO_ACTION
    ]
  if (splitAction) {
    return splitAction
  }
  return null
}

const executeFsFileOps = async ({
  app,
  action,
  items,
  dryRun,
  signal,
  tool,
}: {
  app: App
  action: FsFileOpAction
  items: Record<string, unknown>[]
  dryRun: boolean
  signal?: AbortSignal
  tool: string
}): Promise<LocalToolCallResult> => {
  if (items.length === 0) {
    throw new Error('items cannot be empty.')
  }
  if (items.length > MAX_BATCH_WRITE_ITEMS) {
    throw new Error(
      `items supports up to ${MAX_BATCH_WRITE_ITEMS} operations per call.`,
    )
  }

  const results: FsResultItem[] = []

  for (const item of items) {
    if (signal?.aborted) {
      return { status: ToolCallResponseStatus.Aborted }
    }

    try {
      if (action === 'create_file') {
        const path = validateVaultPath(getTextArg(item, 'path'))
        const content = getTextArg(item, 'content')
        assertContentSize(content)

        const existing = app.vault.getAbstractFileByPath(path)
        if (existing) {
          throw new Error(`Path already exists: ${path}`)
        }
        ensureParentFolderExists(app, path)

        if (!dryRun) {
          await app.vault.create(path, content)
        }

        results.push({
          ok: true,
          action,
          target: path,
          message: dryRun ? 'Would create file.' : 'Created file.',
        })
        continue
      }

      if (action === 'delete_file') {
        const path = validateVaultPath(getTextArg(item, 'path'))
        const existing = app.vault.getAbstractFileByPath(path)
        if (!existing || !(existing instanceof TFile)) {
          throw new Error(`File not found: ${path}`)
        }

        if (!dryRun) {
          await app.fileManager.trashFile(existing)
        }

        results.push({
          ok: true,
          action,
          target: path,
          message: dryRun ? 'Would delete file.' : 'Deleted file.',
        })
        continue
      }

      if (action === 'create_dir') {
        const path = validateVaultPath(getTextArg(item, 'path'))
        const existing = app.vault.getAbstractFileByPath(path)
        if (existing) {
          throw new Error(`Path already exists: ${path}`)
        }
        ensureParentFolderExists(app, path)

        if (!dryRun) {
          await app.vault.createFolder(path)
        }

        results.push({
          ok: true,
          action,
          target: path,
          message: dryRun ? 'Would create folder.' : 'Created folder.',
        })
        continue
      }

      if (action === 'delete_dir') {
        const path = validateVaultPath(getTextArg(item, 'path'))
        const recursive = getOptionalBooleanArg(item, 'recursive') ?? false
        const existing = app.vault.getAbstractFileByPath(path)
        if (!existing || !(existing instanceof TFolder)) {
          throw new Error(`Folder not found: ${path}`)
        }
        if (!recursive && existing.children.length > 0) {
          throw new Error(
            `Folder is not empty: ${path}. Set recursive=true to delete non-empty folders.`,
          )
        }

        if (!dryRun) {
          await app.fileManager.trashFile(existing)
        }

        results.push({
          ok: true,
          action,
          target: path,
          message: dryRun ? 'Would delete folder.' : 'Deleted folder.',
        })
        continue
      }

      if (action === 'move') {
        const oldPath = validateVaultPath(getTextArg(item, 'oldPath'))
        const newPath = validateVaultPath(getTextArg(item, 'newPath'))

        if (oldPath === newPath) {
          throw new Error('oldPath and newPath must be different.')
        }

        const source = app.vault.getAbstractFileByPath(oldPath)
        if (!source) {
          throw new Error(`Source path not found: ${oldPath}`)
        }

        const targetExists = app.vault.getAbstractFileByPath(newPath)
        if (targetExists) {
          throw new Error(`Target path already exists: ${newPath}`)
        }
        ensureParentFolderExists(app, newPath)

        if (
          source instanceof TFolder &&
          (newPath === source.path || newPath.startsWith(`${source.path}/`))
        ) {
          throw new Error('Cannot move a folder into itself or its subfolder.')
        }

        if (!dryRun) {
          await app.fileManager.renameFile(source, newPath)
        }

        results.push({
          ok: true,
          action,
          target: `${oldPath} -> ${newPath}`,
          message: dryRun ? 'Would move path.' : 'Moved path.',
        })
        continue
      }

      throw new Error(`Unsupported fs action: ${action}`)
    } catch (error) {
      results.push({
        ok: false,
        action,
        target:
          action === 'move'
            ? `${asOptionalString(item.oldPath)} -> ${asOptionalString(item.newPath)}`
            : asOptionalString(item.path),
        message: asErrorMessage(error),
      })
    }
  }

  return {
    status: ToolCallResponseStatus.Success,
    text: formatJsonResult({
      tool,
      action,
      dryRun,
      results,
    }),
  }
}

export async function callLocalFileTool({
  app,
  settings,
  openApplyReview,
  toolName,
  args,
  requireReview = false,
  signal,
}: {
  app: App
  settings?: SmartComposerSettings
  openApplyReview?: (state: ApplyViewState) => Promise<boolean>
  toolName: string
  args: Record<string, unknown>
  requireReview?: boolean
  signal?: AbortSignal
}): Promise<LocalToolCallResult> {
  if (signal?.aborted) {
    return { status: ToolCallResponseStatus.Aborted }
  }

  try {
    const name = toolName as LocalFileToolName
    switch (name) {
      case 'fs_list': {
        const scopeFolder = resolveFolderByPath(
          app,
          getOptionalTextArg(args, 'path'),
        )
        const scope = getFsListScope(args)
        const depth = getOptionalIntegerArg({
          args,
          key: 'depth',
          defaultValue: 1,
          min: 1,
          max: 10,
        })
        const maxResults = getOptionalIntegerArg({
          args,
          key: 'maxResults',
          defaultValue: 200,
          min: 1,
          max: 2000,
        })

        const includeFiles = scope === 'files' || scope === 'all'
        const includeDirs = scope === 'dirs' || scope === 'all'

        const entries: Array<{
          kind: 'file' | 'dir'
          path: string
          depth: number
        }> = []
        const queue: Array<{ folder: TFolder; level: number }> = [
          { folder: scopeFolder.folder, level: 1 },
        ]

        while (queue.length > 0 && entries.length < maxResults) {
          const current = queue.shift()
          if (!current) break
          const { folder, level } = current

          const sortedChildren = [...folder.children].sort((a, b) =>
            a.path.localeCompare(b.path),
          )
          for (const child of sortedChildren) {
            if (entries.length >= maxResults) break

            if (child instanceof TFolder) {
              if (includeDirs) {
                entries.push({ kind: 'dir', path: child.path, depth: level })
              }
              if (level < depth) {
                queue.push({ folder: child, level: level + 1 })
              }
              continue
            }

            if (includeFiles && child instanceof TFile) {
              entries.push({ kind: 'file', path: child.path, depth: level })
            }
          }
        }

        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'fs_list',
            path: scopeFolder.normalizedPath,
            scope,
            depth,
            entries,
          }),
        }
      }
      case 'fs_read': {
        const paths = getStringArrayArg(args, 'paths')
          .map((path) => validateVaultPath(path))
          .filter((path, index, arr) => arr.indexOf(path) === index)

        if (paths.length === 0) {
          throw new Error('paths cannot be empty.')
        }
        if (paths.length > MAX_BATCH_READ_FILES) {
          throw new Error(
            `paths supports up to ${MAX_BATCH_READ_FILES} files per call.`,
          )
        }

        const startLine = getOptionalIntegerArg({
          args,
          key: 'startLine',
          defaultValue: DEFAULT_READ_START_LINE,
          min: 1,
          max: MAX_READ_LINE_INDEX,
        })

        const maxLines = getOptionalIntegerArg({
          args,
          key: 'maxLines',
          defaultValue: DEFAULT_READ_MAX_LINES,
          min: 1,
          max: MAX_READ_MAX_LINES,
        })

        const endLine = getOptionalBoundedIntegerArg({
          args,
          key: 'endLine',
          min: 1,
          max: MAX_READ_LINE_INDEX,
        })

        if (endLine !== undefined && endLine < startLine) {
          throw new Error('endLine must be greater than or equal to startLine.')
        }

        if (
          endLine !== undefined &&
          endLine - startLine + 1 > MAX_READ_MAX_LINES
        ) {
          throw new Error(
            `Requested line range is too large. Maximum ${MAX_READ_MAX_LINES} lines per file.`,
          )
        }

        const maxCharsPerFile = getOptionalIntegerArg({
          args,
          key: 'maxCharsPerFile',
          defaultValue: DEFAULT_MAX_BATCH_CHARS_PER_FILE,
          min: 100,
          max: 200000,
        })

        const results: Array<
          | {
              path: string
              ok: true
              totalLines: number
              returnedRange: {
                startLine: number | null
                endLine: number | null
                count: number
              }
              hasMoreAbove: boolean
              hasMoreBelow: boolean
              nextStartLine: number | null
              content: string
              truncated: boolean
            }
          | {
              path: string
              ok: false
              error: string
            }
        > = []

        for (const path of paths) {
          if (signal?.aborted) {
            return { status: ToolCallResponseStatus.Aborted }
          }

          const file = app.vault.getFileByPath(path)
          if (!file) {
            results.push({ path, ok: false, error: 'File not found.' })
            continue
          }

          if (file.stat.size > MAX_FILE_SIZE_BYTES) {
            results.push({
              path,
              ok: false,
              error: `File too large (${file.stat.size} bytes).`,
            })
            continue
          }

          const content = await app.vault.read(file)
          const lines = content.length === 0 ? [] : content.split('\n')
          const totalLines = lines.length
          const startIndex = Math.min(Math.max(startLine - 1, 0), totalLines)
          const endExclusive = Math.min(
            totalLines,
            endLine ?? startIndex + maxLines,
          )
          const selectedLines = lines.slice(startIndex, endExclusive)
          let lineWindowContent = selectedLines
            .map((line, index) => `${startIndex + index + 1}|${line}`)
            .join('\n')
          const truncated = lineWindowContent.length > maxCharsPerFile
          if (truncated) {
            lineWindowContent = `${lineWindowContent.slice(0, maxCharsPerFile)}\n... (truncated at ${maxCharsPerFile} chars)`
          }

          const returnedCount = selectedLines.length
          const returnedStartLine = returnedCount > 0 ? startIndex + 1 : null
          const returnedEndLine =
            returnedCount > 0 ? startIndex + returnedCount : null
          const hasMoreAbove = startIndex > 0
          const hasMoreBelow = endExclusive < totalLines
          results.push({
            path,
            ok: true,
            totalLines,
            returnedRange: {
              startLine: returnedStartLine,
              endLine: returnedEndLine,
              count: returnedCount,
            },
            hasMoreAbove,
            hasMoreBelow,
            nextStartLine: hasMoreBelow ? endExclusive + 1 : null,
            content: lineWindowContent,
            truncated,
          })
        }

        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'fs_read',
            requestedWindow: {
              startLine,
              endLine: endLine ?? null,
              maxLines: endLine === undefined ? maxLines : null,
              maxCharsPerFile,
            },
            results,
          }),
        }
      }

      case 'fs_edit': {
        const path = validateVaultPath(getTextArg(args, 'path'))
        const plan = getFsEditPlan(args)

        const file = app.vault.getAbstractFileByPath(path)
        if (!file || !(file instanceof TFile)) {
          throw new Error(`File not found: ${path}`)
        }
        if (file.stat.size > MAX_FILE_SIZE_BYTES) {
          throw new Error(`File too large (${file.stat.size} bytes).`)
        }

        const content = await app.vault.read(file)
        const materialized = materializeTextEditPlan({
          content,
          plan,
        })

        if (materialized.errors.length > 0) {
          throw new Error(`${path}: ${materialized.errors[0]}`)
        }

        const nextContent = materialized.newContent

        assertContentSize(nextContent)
        let appliedContent = nextContent

        if (requireReview) {
          if (!openApplyReview) {
            throw new Error('Apply review is unavailable for fs_edit.')
          }

          const reviewResult = await waitForFsEditReview({
            openApplyReview,
            file,
            originalContent: content,
            newContent: nextContent,
            selectionRange: getFsEditSelectionRange(
              content,
              materialized.operationResults,
            ),
            signal,
          })

          if (reviewResult.status === ToolCallResponseStatus.Aborted) {
            return reviewResult
          }
          if (reviewResult.status === ToolCallResponseStatus.Rejected) {
            return reviewResult
          }

          appliedContent = reviewResult.finalContent
        } else {
          await app.vault.modify(file, nextContent)
        }

        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'fs_edit',
            path,
            totalOperations: materialized.totalOperations,
            appliedCount: materialized.appliedCount,
            operationResults: materialized.operationResults.map((result) => ({
              type: result.operation.type,
              changed: result.changed,
              actualOccurrences: result.actualOccurrences,
              expectedOccurrences: result.expectedOccurrences,
              matchMode: result.matchMode,
            })),
            changed: content !== appliedContent,
            message: requireReview ? 'Applied reviewed edit.' : 'Applied edit.',
          }),
        }
      }

      case 'fs_create_file': {
        const dryRun = getOptionalBooleanArg(args, 'dryRun') ?? false
        return executeFsFileOps({
          app,
          action: 'create_file',
          items: [
            {
              path: getTextArg(args, 'path'),
              content: getTextArg(args, 'content'),
            },
          ],
          dryRun,
          signal,
          tool: 'fs_create_file',
        })
      }

      case 'fs_delete_file': {
        const dryRun = getOptionalBooleanArg(args, 'dryRun') ?? false
        return executeFsFileOps({
          app,
          action: 'delete_file',
          items: [{ path: getTextArg(args, 'path') }],
          dryRun,
          signal,
          tool: 'fs_delete_file',
        })
      }

      case 'fs_create_dir': {
        const dryRun = getOptionalBooleanArg(args, 'dryRun') ?? false
        return executeFsFileOps({
          app,
          action: 'create_dir',
          items: [{ path: getTextArg(args, 'path') }],
          dryRun,
          signal,
          tool: 'fs_create_dir',
        })
      }

      case 'fs_delete_dir': {
        const dryRun = getOptionalBooleanArg(args, 'dryRun') ?? false
        const recursive = getOptionalBooleanArg(args, 'recursive')
        return executeFsFileOps({
          app,
          action: 'delete_dir',
          items: [
            {
              path: getTextArg(args, 'path'),
              ...(recursive === undefined ? {} : { recursive }),
            },
          ],
          dryRun,
          signal,
          tool: 'fs_delete_dir',
        })
      }

      case 'fs_move': {
        const dryRun = getOptionalBooleanArg(args, 'dryRun') ?? false
        return executeFsFileOps({
          app,
          action: 'move',
          items: [
            {
              oldPath: getTextArg(args, 'oldPath'),
              newPath: getTextArg(args, 'newPath'),
            },
          ],
          dryRun,
          signal,
          tool: 'fs_move',
        })
      }

      case 'fs_search': {
        const scope = getFsSearchScope(args)
        const query = (getOptionalTextArg(args, 'query') ?? '').trim()
        const maxResults = getOptionalIntegerArg({
          args,
          key: 'maxResults',
          defaultValue: 20,
          min: 1,
          max: 300,
        })
        const caseSensitive =
          getOptionalBooleanArg(args, 'caseSensitive') ?? false
        const scopeFolder = resolveFolderByPath(
          app,
          getOptionalTextArg(args, 'path'),
        )

        const queryForMatch = caseSensitive ? query : query.toLowerCase()
        const matchPath = (path: string): boolean => {
          if (!query) {
            return true
          }
          const source = caseSensitive ? path : path.toLowerCase()
          return source.includes(queryForMatch)
        }

        const includeFiles = scope === 'files' || scope === 'all'
        const includeDirs = scope === 'dirs' || scope === 'all'
        const includeContent = scope === 'content' || scope === 'all'

        if (includeContent && !query) {
          throw new Error('query is required when scope includes content.')
        }

        const results: Array<
          | { kind: 'file'; path: string }
          | { kind: 'dir'; path: string }
          | {
              kind: 'content_match'
              path: string
              line: number
              snippet: string
            }
        > = []
        if (includeFiles) {
          const files = app.vault
            .getFiles()
            .filter((file) =>
              isPathWithinFolder(file.path, scopeFolder.normalizedPath),
            )
            .map((file) => file.path)
            .filter((path) => matchPath(path))
            .sort((a, b) => a.localeCompare(b))

          for (const filePath of files) {
            if (results.length >= maxResults) break
            results.push({ kind: 'file', path: filePath })
          }
        }

        if (includeDirs && results.length < maxResults) {
          const dirs = app.vault
            .getAllLoadedFiles()
            .filter((entry): entry is TFolder => entry instanceof TFolder)
            .filter((folder) => folder.path.length > 0)
            .filter((folder) =>
              isPathWithinFolder(folder.path, scopeFolder.normalizedPath),
            )
            .map((folder) => folder.path)
            .filter((path) => matchPath(path))
            .sort((a, b) => a.localeCompare(b))

          for (const dirPath of dirs) {
            if (results.length >= maxResults) break
            results.push({ kind: 'dir', path: dirPath })
          }
        }

        if (includeContent && results.length < maxResults) {
          const searchableFiles = app.vault
            .getMarkdownFiles()
            .filter((file) =>
              isPathWithinFolder(file.path, scopeFolder.normalizedPath),
            )
            .sort((a, b) => a.path.localeCompare(b.path))

          for (const file of searchableFiles) {
            if (results.length >= maxResults) break
            if (signal?.aborted) {
              return { status: ToolCallResponseStatus.Aborted }
            }
            if (file.stat.size > MAX_FILE_SIZE_BYTES) {
              continue
            }

            const content = await app.vault.read(file)
            const source = caseSensitive ? content : content.toLowerCase()
            const matchIndex = source.indexOf(queryForMatch)
            if (matchIndex === -1) {
              continue
            }

            const line = content.slice(0, matchIndex).split('\n').length
            const snippet = makeContentSnippet({
              content,
              matchIndex,
              matchLength: query.length,
            })
            results.push({
              kind: 'content_match',
              path: file.path,
              line,
              snippet,
            })
          }
        }

        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'fs_search',
            scope,
            query,
            path: scopeFolder.normalizedPath,
            results,
          }),
        }
      }

      case 'open_skill': {
        const id = getOptionalTextArg(args, 'id')?.trim()
        const name = getOptionalTextArg(args, 'name')?.trim()

        if (!id && !name) {
          throw new Error('Either id or name is required.')
        }

        const skill = await getLiteSkillDocument({ app, id, name, settings })
        if (!skill) {
          throw new Error(`Skill not found. id=${id ?? ''} name=${name ?? ''}`)
        }

        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'open_skill',
            skill: skill.entry,
            content: skill.content,
          }),
        }
      }

      default:
        throw new Error(`Unknown local file tool: ${toolName}`)
    }
  } catch (error) {
    return {
      status: ToolCallResponseStatus.Error,
      error: asErrorMessage(error),
    }
  }
}
