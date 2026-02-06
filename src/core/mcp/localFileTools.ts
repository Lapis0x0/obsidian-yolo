import { App, TFile, TFolder, normalizePath } from 'obsidian'

import { McpTool } from '../../types/mcp.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

const LOCAL_FILE_TOOL_SERVER = 'yolo_local'
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024
const MAX_BATCH_READ_FILES = 20
const DEFAULT_MAX_BATCH_CHARS_PER_FILE = 20_000

type LocalFileToolName =
  | 'read_file'
  | 'read_files'
  | 'create_file'
  | 'write_file'
  | 'delete_file'
  | 'list_dir'
  | 'search_dirs'
  | 'search_files'
  | 'search_content'

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

const asErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return typeof error === 'string' ? error : JSON.stringify(error)
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
      name: 'read_file',
      description: 'Read text content from a vault file by path.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Vault-relative file path, e.g. DOC/notes.md',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'read_files',
      description: 'Read text content from multiple vault files by path.',
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
          maxCharsPerFile: {
            type: 'integer',
            description: `Maximum returned chars per file. Defaults to ${DEFAULT_MAX_BATCH_CHARS_PER_FILE}, range 100-200000.`,
          },
        },
        required: ['paths'],
      },
    },
    {
      name: 'create_file',
      description:
        'Create a new vault file with content. Fails if file already exists.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Vault-relative file path to create.',
          },
          content: {
            type: 'string',
            description: 'File content.',
          },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'write_file',
      description:
        'Write content to an existing file, or create it if missing. Mode supports overwrite/append.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Vault-relative file path to write.',
          },
          content: {
            type: 'string',
            description: 'Content to write.',
          },
          mode: {
            type: 'string',
            enum: ['overwrite', 'append'],
            description: 'Write mode. Defaults to overwrite.',
          },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'delete_file',
      description: 'Delete a vault file by path.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Vault-relative file path to delete.',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'list_dir',
      description: 'List files and folders in a vault directory.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Vault-relative directory path. Omit or use empty string for vault root.',
          },
          maxResults: {
            type: 'integer',
            description:
              'Maximum entries to return. Defaults to 200, range 1-1000.',
          },
        },
      },
    },
    {
      name: 'search_files',
      description: 'Search vault files by file path/name.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Keyword to match against file paths.',
          },
          path: {
            type: 'string',
            description:
              'Optional vault-relative directory path to scope search.',
          },
          maxResults: {
            type: 'integer',
            description:
              'Maximum matches to return. Defaults to 20, range 1-200.',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'search_dirs',
      description: 'Search vault folders by folder path/name.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Keyword to match against folder paths.',
          },
          path: {
            type: 'string',
            description:
              'Optional vault-relative directory path to scope search.',
          },
          maxResults: {
            type: 'integer',
            description:
              'Maximum matches to return. Defaults to 20, range 1-200.',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'search_content',
      description: 'Search markdown file contents by keyword.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Keyword to search in markdown contents.',
          },
          path: {
            type: 'string',
            description:
              'Optional vault-relative directory path to scope search.',
          },
          maxResults: {
            type: 'integer',
            description:
              'Maximum matches to return. Defaults to 20, range 1-100.',
          },
          caseSensitive: {
            type: 'boolean',
            description: 'Whether keyword matching should be case-sensitive.',
          },
        },
        required: ['query'],
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
  if (!trimmedPath) {
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
      case 'read_file': {
        const path = validateVaultPath(getTextArg(args, 'path'))
        const file = app.vault.getFileByPath(path)
        if (!file) {
          throw new Error(`File not found: ${path}`)
        }
        const content = await app.vault.read(file)
        return {
          status: ToolCallResponseStatus.Success,
          text: content,
        }
      }
      case 'read_files': {
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
        const maxCharsPerFile = getOptionalIntegerArg({
          args,
          key: 'maxCharsPerFile',
          defaultValue: DEFAULT_MAX_BATCH_CHARS_PER_FILE,
          min: 100,
          max: 200000,
        })

        const sections: string[] = []
        let successCount = 0
        let errorCount = 0

        for (const path of paths) {
          if (signal?.aborted) {
            return { status: ToolCallResponseStatus.Aborted }
          }

          const file = app.vault.getFileByPath(path)
          if (!file) {
            errorCount += 1
            sections.push(`### ${path}\n[Error] File not found.`)
            continue
          }
          if (file.stat.size > MAX_FILE_SIZE_BYTES) {
            errorCount += 1
            sections.push(
              `### ${path}\n[Error] File too large (${file.stat.size} bytes).`,
            )
            continue
          }

          const content = await app.vault.read(file)
          const clippedContent =
            content.length > maxCharsPerFile
              ? `${content.slice(0, maxCharsPerFile)}\n... (truncated at ${maxCharsPerFile} chars)`
              : content

          successCount += 1
          sections.push(`### ${path}\n${clippedContent}`)
        }

        return {
          status: ToolCallResponseStatus.Success,
          text: `Batch read completed (${successCount} succeeded, ${errorCount} failed):\n\n${sections.join('\n\n---\n\n')}`,
        }
      }
      case 'create_file': {
        const path = validateVaultPath(getTextArg(args, 'path'))
        const content = getTextArg(args, 'content')
        assertContentSize(content)
        const existing = app.vault.getAbstractFileByPath(path)
        if (existing) {
          throw new Error(`File already exists: ${path}`)
        }
        await app.vault.create(path, content)
        return {
          status: ToolCallResponseStatus.Success,
          text: `Created file: ${path}`,
        }
      }
      case 'write_file': {
        const path = validateVaultPath(getTextArg(args, 'path'))
        const content = getTextArg(args, 'content')
        const mode = args.mode
        if (mode !== undefined && mode !== 'overwrite' && mode !== 'append') {
          throw new Error('mode must be overwrite or append.')
        }
        assertContentSize(content)
        const existing = app.vault.getFileByPath(path)
        if (!existing) {
          await app.vault.create(path, content)
          return {
            status: ToolCallResponseStatus.Success,
            text: `Created file: ${path}`,
          }
        }
        const nextContent =
          mode === 'append'
            ? `${await app.vault.read(existing)}${content}`
            : content
        assertContentSize(nextContent)
        await app.vault.modify(existing, nextContent)
        return {
          status: ToolCallResponseStatus.Success,
          text: `Updated file: ${path}`,
        }
      }
      case 'delete_file': {
        const path = validateVaultPath(getTextArg(args, 'path'))
        const existing = app.vault.getAbstractFileByPath(path)
        if (!existing || !(existing instanceof TFile)) {
          throw new Error(`File not found: ${path}`)
        }
        await app.fileManager.trashFile(existing)
        return {
          status: ToolCallResponseStatus.Success,
          text: `Deleted file: ${path}`,
        }
      }
      case 'list_dir': {
        const scope = resolveFolderByPath(app, getOptionalTextArg(args, 'path'))
        const maxResults = getOptionalIntegerArg({
          args,
          key: 'maxResults',
          defaultValue: 200,
          min: 1,
          max: 1000,
        })

        const entries = scope.folder.children
          .map((entry) =>
            entry instanceof TFolder ? `${entry.path}/` : entry.path,
          )
          .sort((a, b) => a.localeCompare(b))

        const listedEntries = entries.slice(0, maxResults)
        const scopeLabel = scope.normalizedPath || '/'
        if (listedEntries.length === 0) {
          return {
            status: ToolCallResponseStatus.Success,
            text: `Directory is empty: ${scopeLabel}`,
          }
        }

        const suffix =
          entries.length > listedEntries.length
            ? `\n... (${entries.length - listedEntries.length} more entries omitted)`
            : ''

        return {
          status: ToolCallResponseStatus.Success,
          text: `Directory listing for ${scopeLabel}:\n${listedEntries.map((entry) => `- ${entry}`).join('\n')}${suffix}`,
        }
      }
      case 'search_files': {
        const query = getTextArg(args, 'query').trim()
        if (!query) {
          throw new Error('query cannot be empty.')
        }
        const scope = resolveFolderByPath(app, getOptionalTextArg(args, 'path'))
        const maxResults = getOptionalIntegerArg({
          args,
          key: 'maxResults',
          defaultValue: 20,
          min: 1,
          max: 200,
        })

        const queryLower = query.toLowerCase()
        const results = app.vault
          .getFiles()
          .filter((file) => isPathWithinFolder(file.path, scope.normalizedPath))
          .map((file) => file.path)
          .filter((path) => path.toLowerCase().includes(queryLower))
          .sort((a, b) => a.localeCompare(b))

        const listedResults = results.slice(0, maxResults)
        if (listedResults.length === 0) {
          return {
            status: ToolCallResponseStatus.Success,
            text: `No file paths matched "${query}".`,
          }
        }

        const suffix =
          results.length > listedResults.length
            ? `\n... (${results.length - listedResults.length} more matches omitted)`
            : ''

        return {
          status: ToolCallResponseStatus.Success,
          text: `Matched file paths (${listedResults.length}/${results.length}):\n${listedResults.map((path) => `- ${path}`).join('\n')}${suffix}`,
        }
      }
      case 'search_dirs': {
        const query = getTextArg(args, 'query').trim()
        if (!query) {
          throw new Error('query cannot be empty.')
        }
        const scope = resolveFolderByPath(app, getOptionalTextArg(args, 'path'))
        const maxResults = getOptionalIntegerArg({
          args,
          key: 'maxResults',
          defaultValue: 20,
          min: 1,
          max: 200,
        })

        const queryLower = query.toLowerCase()
        const results = app.vault
          .getAllLoadedFiles()
          .filter((entry): entry is TFolder => entry instanceof TFolder)
          .filter((folder) =>
            isPathWithinFolder(folder.path, scope.normalizedPath),
          )
          .map((folder) => folder.path)
          .filter((path) => path.toLowerCase().includes(queryLower))
          .sort((a, b) => a.localeCompare(b))

        const listedResults = results.slice(0, maxResults)
        if (listedResults.length === 0) {
          return {
            status: ToolCallResponseStatus.Success,
            text: `No folder paths matched "${query}".`,
          }
        }

        const suffix =
          results.length > listedResults.length
            ? `\n... (${results.length - listedResults.length} more matches omitted)`
            : ''

        return {
          status: ToolCallResponseStatus.Success,
          text: `Matched folder paths (${listedResults.length}/${results.length}):\n${listedResults.map((path) => `- ${path}`).join('\n')}${suffix}`,
        }
      }
      case 'search_content': {
        const query = getTextArg(args, 'query').trim()
        if (!query) {
          throw new Error('query cannot be empty.')
        }
        const scope = resolveFolderByPath(app, getOptionalTextArg(args, 'path'))
        const maxResults = getOptionalIntegerArg({
          args,
          key: 'maxResults',
          defaultValue: 20,
          min: 1,
          max: 100,
        })
        const caseSensitive =
          getOptionalBooleanArg(args, 'caseSensitive') ?? false

        const searchableFiles = app.vault
          .getMarkdownFiles()
          .filter((file) => isPathWithinFolder(file.path, scope.normalizedPath))
          .sort((a, b) => a.path.localeCompare(b.path))

        const matched: string[] = []
        let skippedLargeFiles = 0

        for (const file of searchableFiles) {
          if (matched.length >= maxResults) {
            break
          }
          if (file.stat.size > MAX_FILE_SIZE_BYTES) {
            skippedLargeFiles += 1
            continue
          }

          const content = await app.vault.read(file)
          const source = caseSensitive ? content : content.toLowerCase()
          const target = caseSensitive ? query : query.toLowerCase()
          const matchIndex = source.indexOf(target)
          if (matchIndex === -1) {
            continue
          }

          const line = content.slice(0, matchIndex).split('\n').length
          const snippet = makeContentSnippet({
            content,
            matchIndex,
            matchLength: query.length,
          })
          matched.push(`- ${file.path}:${line} ${snippet}`)
        }

        if (matched.length === 0) {
          const skipMessage =
            skippedLargeFiles > 0
              ? ` (skipped ${skippedLargeFiles} oversized files)`
              : ''
          return {
            status: ToolCallResponseStatus.Success,
            text: `No markdown content matched "${query}"${skipMessage}.`,
          }
        }

        const suffix =
          skippedLargeFiles > 0
            ? `\nNote: skipped ${skippedLargeFiles} oversized files.`
            : ''

        return {
          status: ToolCallResponseStatus.Success,
          text: `Matched markdown content (${matched.length}):\n${matched.join('\n')}${suffix}`,
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
