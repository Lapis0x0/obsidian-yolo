import { App, TFile, TFolder, normalizePath } from 'obsidian'

import { McpTool } from '../../types/mcp.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

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
  | 'fs_write'
type FsSearchScope = 'files' | 'dirs' | 'content' | 'all'
type FsListScope = 'files' | 'dirs' | 'all'
type FsWriteAction =
  | 'create_file'
  | 'write_file'
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
      status: ToolCallResponseStatus.Error
      error: string
    }
  | {
      status: ToolCallResponseStatus.Aborted
    }

type FsResultItem = {
  ok: boolean
  action: FsWriteAction
  target: string
  message: string
}

const asErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return typeof error === 'string' ? error : JSON.stringify(error)
}

const asOptionalString = (value: unknown): string => {
  return typeof value === 'string' ? value : ''
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
          scope: {
            type: 'string',
            enum: ['files', 'dirs', 'all'],
            description: 'Filter listed entries by type. Defaults to all.',
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
      description:
        `Read line ranges from multiple vault files by path. Defaults to the first ${DEFAULT_READ_MAX_LINES} lines.`,
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
        'Apply exact text replacement within a single file. Safer than full-file overwrite for localized edits.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Vault-relative file path.',
          },
          oldText: {
            type: 'string',
            description: 'Exact text to replace. Must not be empty.',
          },
          newText: {
            type: 'string',
            description: 'Replacement text.',
          },
          expectedOccurrences: {
            type: 'integer',
            description:
              'Expected number of matches for oldText. Defaults to 1. Tool fails if actual count differs.',
          },
          dryRun: {
            type: 'boolean',
            description:
              'If true, validate and report replacement stats without modifying file.',
          },
        },
        required: ['path', 'oldText', 'newText'],
      },
    },
    {
      name: 'fs_write',
      description:
        'Execute vault write operations for files/folders. delete_* actions should require approval.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'create_file',
              'write_file',
              'delete_file',
              'create_dir',
              'delete_dir',
              'move',
            ],
            description: 'Write action to run for each item.',
          },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                oldPath: { type: 'string' },
                newPath: { type: 'string' },
                content: { type: 'string' },
                mode: {
                  type: 'string',
                  enum: ['overwrite', 'append'],
                },
                recursive: {
                  type: 'boolean',
                  description:
                    'Only for delete_dir. Default false; when false non-empty folders cannot be deleted.',
                },
              },
            },
            description: `Operation items. Maximum ${MAX_BATCH_WRITE_ITEMS} items per call.`,
          },
          dryRun: {
            type: 'boolean',
            description:
              'If true, validate and preview results without applying changes.',
          },
        },
        required: ['action', 'items'],
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

const getFsWriteAction = (args: Record<string, unknown>): FsWriteAction => {
  const value = args.action
  if (
    value !== 'create_file' &&
    value !== 'write_file' &&
    value !== 'delete_file' &&
    value !== 'create_dir' &&
    value !== 'delete_dir' &&
    value !== 'move'
  ) {
    throw new Error(
      'action must be one of: create_file, write_file, delete_file, create_dir, delete_dir, move.',
    )
  }
  return value
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

const countOccurrences = (content: string, target: string): number => {
  if (!target) {
    return 0
  }
  let count = 0
  let cursor = 0
  while (cursor <= content.length) {
    const index = content.indexOf(target, cursor)
    if (index === -1) break
    count += 1
    cursor = index + target.length
  }
  return count
}

const normalizeLineEndings = (value: string): string => {
  return value.replace(/\r\n/g, '\n')
}

const normalizeLineEndingsAndTrimLineEnd = (value: string): string => {
  return normalizeLineEndings(value)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
}

const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const createLooseEditRegex = (oldText: string): RegExp => {
  const lines = oldText.split(/\r?\n/)
  const pattern = lines
    .map((line, index) => {
      const escapedLine = escapeRegExp(line.replace(/[ \t]+$/g, ''))
      const endWhitespace = '[ \\t]*'
      if (index === lines.length - 1) {
        return `${escapedLine}${endWhitespace}`
      }
      return `${escapedLine}${endWhitespace}\\r?\\n`
    })
    .join('')
  return new RegExp(pattern, 'g')
}

const countRegexMatches = (content: string, regex: RegExp): number => {
  let count = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    count += 1
    if (match[0].length === 0) {
      regex.lastIndex += 1
    }
  }
  return count
}

export function parseLocalFsWriteActionFromArgs(
  args?: Record<string, unknown> | string,
): FsWriteAction | null {
  try {
    const parsedArgs: Record<string, unknown> | undefined =
      typeof args === 'string'
        ? args.trim() === ''
          ? {}
          : (JSON.parse(args) as Record<string, unknown>)
        : args
    if (!parsedArgs) {
      return null
    }
    return getFsWriteAction(parsedArgs)
  } catch {
    return null
  }
}

export async function callLocalFileTool({
  app,
  toolName,
  args,
  signal,
}: {
  app: App
  toolName: string
  args: Record<string, unknown>
  signal?: AbortSignal
}): Promise<LocalToolCallResult> {
  if (signal?.aborted) {
    return { status: ToolCallResponseStatus.Aborted }
  }

  try {
    const name = toolName as LocalFileToolName
    switch (name) {
      case 'fs_list': {
        const scopeFolder = resolveFolderByPath(app, getOptionalTextArg(args, 'path'))
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

        const entries: Array<{ kind: 'file' | 'dir'; path: string; depth: number }> = []
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
            summary: {
              returned: entries.length,
              maxResults,
            },
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

        if (endLine !== undefined && endLine - startLine + 1 > MAX_READ_MAX_LINES) {
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

        const successCount = results.filter((result) => result.ok).length
        const errorCount = results.length - successCount

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
            summary: {
              total: results.length,
              success: successCount,
              failed: errorCount,
            },
            results,
          }),
        }
      }

      case 'fs_edit': {
        const path = validateVaultPath(getTextArg(args, 'path'))
        const oldText = getTextArg(args, 'oldText')
        const newText = getTextArg(args, 'newText')
        const expectedOccurrences = getOptionalIntegerArg({
          args,
          key: 'expectedOccurrences',
          defaultValue: 1,
          min: 1,
          max: 100000,
        })
        const dryRun = getOptionalBooleanArg(args, 'dryRun') ?? false

        if (oldText.length === 0) {
          throw new Error('oldText must not be empty.')
        }

        const file = app.vault.getAbstractFileByPath(path)
        if (!file || !(file instanceof TFile)) {
          throw new Error(`File not found: ${path}`)
        }
        if (file.stat.size > MAX_FILE_SIZE_BYTES) {
          throw new Error(`File too large (${file.stat.size} bytes).`)
        }

        const content = await app.vault.read(file)
        const exactOccurrences = countOccurrences(content, oldText)
        const lineEndingOccurrences = countOccurrences(
          normalizeLineEndings(content),
          normalizeLineEndings(oldText),
        )
        const trimLineEndOccurrences = countOccurrences(
          normalizeLineEndingsAndTrimLineEnd(content),
          normalizeLineEndingsAndTrimLineEnd(oldText),
        )

        let nextContent = content
        let actualOccurrences = exactOccurrences
        let matchMode: 'exact' | 'lineEndingAndTrimLineEnd' = 'exact'

        if (exactOccurrences === expectedOccurrences) {
          nextContent = content.split(oldText).join(newText)
        } else {
          const looseRegex = createLooseEditRegex(oldText)
          const looseOccurrences = countRegexMatches(content, looseRegex)
          if (looseOccurrences === expectedOccurrences) {
            actualOccurrences = looseOccurrences
            matchMode = 'lineEndingAndTrimLineEnd'
            nextContent = content.replace(
              createLooseEditRegex(oldText),
              () => newText,
            )
          } else {
            throw new Error(
              `expectedOccurrences mismatch for ${path}: expected ${expectedOccurrences}, found ${exactOccurrences}. hints: lineEndingNormalized=${lineEndingOccurrences}, trimLineEndNormalized=${trimLineEndOccurrences}`,
            )
          }
        }

        assertContentSize(nextContent)
        if (!dryRun) {
          await app.vault.modify(file, nextContent)
        }

        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'fs_edit',
            path,
            dryRun,
            expectedOccurrences,
            actualOccurrences,
            matchMode,
            changed: content !== nextContent,
            message: dryRun ? 'Would apply edit.' : 'Applied edit.',
          }),
        }
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
        const caseSensitive = getOptionalBooleanArg(args, 'caseSensitive') ?? false
        const scopeFolder = resolveFolderByPath(app, getOptionalTextArg(args, 'path'))

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
          | { kind: 'content_match'; path: string; line: number; snippet: string }
        > = []
        let skippedLargeFiles = 0

        if (includeFiles) {
          const files = app.vault
            .getFiles()
            .filter((file) => isPathWithinFolder(file.path, scopeFolder.normalizedPath))
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
            .filter((file) => isPathWithinFolder(file.path, scopeFolder.normalizedPath))
            .sort((a, b) => a.path.localeCompare(b.path))

          for (const file of searchableFiles) {
            if (results.length >= maxResults) break
            if (signal?.aborted) {
              return { status: ToolCallResponseStatus.Aborted }
            }
            if (file.stat.size > MAX_FILE_SIZE_BYTES) {
              skippedLargeFiles += 1
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
            summary: {
              returned: results.length,
              maxResults,
              skippedLargeFiles,
            },
            results,
          }),
        }
      }

      case 'fs_write': {
        const action = getFsWriteAction(args)
        const items = getRecordArrayArg(args, 'items')
        const dryRun = getOptionalBooleanArg(args, 'dryRun') ?? false

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

            if (action === 'write_file') {
              const path = validateVaultPath(getTextArg(item, 'path'))
              const content = getTextArg(item, 'content')
              assertContentSize(content)
              const mode = item.mode
              if (mode !== undefined && mode !== 'overwrite' && mode !== 'append') {
                throw new Error('mode must be overwrite or append.')
              }

              const existing = app.vault.getAbstractFileByPath(path)
              if (existing && !(existing instanceof TFile)) {
                throw new Error(`Path is not a file: ${path}`)
              }

              if (existing instanceof TFile) {
                const nextContent =
                  mode === 'append'
                    ? `${await app.vault.read(existing)}${content}`
                    : content
                assertContentSize(nextContent)

                if (!dryRun) {
                  await app.vault.modify(existing, nextContent)
                }

                results.push({
                  ok: true,
                  action,
                  target: path,
                  message:
                    mode === 'append'
                      ? dryRun
                        ? 'Would append to file.'
                        : 'Appended to file.'
                      : dryRun
                        ? 'Would overwrite file.'
                        : 'Overwrote file.',
                })
                continue
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
                throw new Error(
                  'Cannot move a folder into itself or its subfolder.',
                )
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

            throw new Error(`Unsupported fs_write action: ${action}`)
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

        const successCount = results.filter((item) => item.ok).length
        const errorCount = results.length - successCount

        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'fs_write',
            action,
            dryRun,
            summary: {
              total: results.length,
              success: successCount,
              failed: errorCount,
            },
            results,
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
