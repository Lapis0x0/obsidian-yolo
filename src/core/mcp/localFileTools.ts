import { App, TFile, normalizePath } from 'obsidian'

import { McpTool } from '../../types/mcp.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

const LOCAL_FILE_TOOL_SERVER = 'yolo_local'
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024

type LocalFileToolName =
  | 'read_file'
  | 'create_file'
  | 'write_file'
  | 'delete_file'

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
  ]
}

const getTextArg = (args: Record<string, unknown>, key: string): string => {
  const value = args[key]
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string.`)
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
