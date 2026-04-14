import { App, TFile, TFolder, normalizePath } from 'obsidian'

import { upsertEditReviewSnapshot } from '../../database/json/chat/editReviewSnapshotStore'
import type { SmartComposerSettings } from '../../settings/schema/setting.types'
import type { ApplyViewState } from '../../types/apply-view.types'
import type { ChatMessage } from '../../types/chat'
import { McpTool } from '../../types/mcp.types'
import {
  ToolCallResponseStatus,
  type ToolEditSummary,
} from '../../types/tool-call.types'
import {
  createToolEditSummary,
  deriveToolEditUndoStatus,
} from '../../utils/chat/editSummary'
import { editUndoSnapshotStore } from '../../utils/chat/editUndoSnapshotStore'
import { isContextPrunableToolName } from '../../utils/chat/tool-context-pruning'
import {
  type TextEditOperation,
  type TextEditPlan,
  materializeTextEditPlan,
  recoverLikelyEscapedBackslashSequences,
} from '../edits/textEditEngine'
import {
  type MemoryScope,
  memoryAdd,
  memoryDelete,
  memoryUpdate,
} from '../memory/memoryManager'
import type { RAGEngine } from '../rag/ragEngine'
import { fuseRrfHybrid, type SuperSearchResult } from '../search/hybridSearch'
import { aggregateSearchResults } from '../search/searchResultAggregation'
import { getLiteSkillDocument } from '../skills/liteSkills'

export { recoverLikelyEscapedBackslashSequences }

const LOCAL_FILE_TOOL_SERVER = 'yolo_local'
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024
const MAX_BATCH_READ_FILES = 20
const DEFAULT_READ_START_LINE = 1
const DEFAULT_READ_MAX_LINES = 50
const MAX_READ_MAX_LINES = 2000
const MAX_READ_LINE_INDEX = 1_000_000
const MAX_BATCH_WRITE_ITEMS = 50
const MAX_RAG_SNIPPET_CHARS = 500
const RAG_FETCH_LIMIT_MAX = 300

const getContextPrunableToolCallIds = (
  messages: ChatMessage[] | undefined,
  currentToolCallId?: string,
): Set<string> => {
  const acceptedToolCallIds = new Set<string>()

  for (const message of messages ?? []) {
    if (message.role !== 'tool') {
      continue
    }

    if (
      currentToolCallId &&
      message.toolCalls.some(
        (toolCall) => toolCall.request.id === currentToolCallId,
      )
    ) {
      break
    }

    for (const toolCall of message.toolCalls) {
      if (
        isContextPrunableToolName(toolCall.request.name) &&
        toolCall.response.status === ToolCallResponseStatus.Success &&
        toolCall.response.data.type === 'text' &&
        toolCall.request.id.trim().length > 0
      ) {
        acceptedToolCallIds.add(toolCall.request.id)
      }
    }
  }

  return acceptedToolCallIds
}

type LocalFileToolName =
  | 'fs_list'
  | 'fs_search'
  | 'fs_read'
  | 'context_prune_tool_results'
  | 'context_compact'
  | 'fs_edit'
  | 'fs_create_file'
  | 'fs_delete_file'
  | 'fs_create_dir'
  | 'fs_delete_dir'
  | 'fs_move'
  | 'memory_add'
  | 'memory_update'
  | 'memory_delete'
  | 'open_skill'
type FsSearchScope = 'files' | 'dirs' | 'content' | 'all'
type FsSearchMode = 'keyword' | 'rag' | 'hybrid'
type LegacyFsSearchItem =
  | { kind: 'file'; path: string }
  | { kind: 'dir'; path: string }
  | { kind: 'content_match'; path: string; line: number; snippet: string }
type FsListScope = 'files' | 'dirs' | 'all'
type FsReadOperation =
  | {
      type: 'full'
    }
  | {
      type: 'lines'
      startLine: number
      endLine?: number
      maxLines: number
    }
type ContextPruneMode = 'selected' | 'all'

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
      metadata?: {
        editSummary?: ToolEditSummary
        appliedAt?: number
      }
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

export const LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES = [
  'memory_add',
  'memory_update',
  'memory_delete',
] as const

const LOCAL_FS_WRITE_TOOL_NAMES = new Set<string>([
  'fs_edit',
  ...LOCAL_FS_SPLIT_ACTION_TOOL_NAMES,
  'memory_add',
  'memory_update',
  'memory_delete',
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
        'Search the vault. By default, prefer hybrid search: keyword path/content matching plus semantic (RAG) retrieval fused with RRF. Content results are grouped by file and include the most relevant snippets. Use keyword for exact filenames, paths, or literal terms; use rag only when you explicitly want semantic-only retrieval without keyword matching. For deep reading, follow up with fs_read.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['keyword', 'rag', 'hybrid'],
            description:
              'Search mode. Default is hybrid and it should be preferred for most queries. hybrid: combines keyword path/content search with RAG using fused ranking. keyword: exact path/content string matching only. rag: semantic retrieval only.',
          },
          scope: {
            type: 'string',
            enum: ['files', 'dirs', 'content', 'all'],
            description:
              'Search scope for keyword mode (defaults to all). For rag, use content or all, or omit; files/dirs are not supported for rag. Hybrid uses keyword content search plus RAG.',
          },
          query: {
            type: 'string',
            description:
              'Search query. Optional for keyword files/dirs listing. Required when keyword scope includes content, and required for rag/hybrid.',
          },
          path: {
            type: 'string',
            description:
              'Optional vault-relative directory path to scope search.',
          },
          maxResults: {
            type: 'integer',
            description:
              'Maximum top-level results to return. For content search, this means grouped file results. Defaults to 20, range 1-300.',
          },
          caseSensitive: {
            type: 'boolean',
            description:
              'Whether matching should be case-sensitive. Mainly useful for content scope.',
          },
          ragMinSimilarity: {
            type: 'number',
            description:
              'Optional minimum similarity threshold (0-1) for rag/hybrid; defaults to settings.',
          },
          ragLimit: {
            type: 'integer',
            description:
              'Optional max RAG chunks to retrieve for rag/hybrid; defaults to settings, range 1-300.',
          },
        },
      },
    },
    {
      name: 'fs_read',
      description:
        'Read vault files by path using either full-file or targeted line-range operations. Prefer lines when you already know the relevant section to reduce context usage.',
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
          operation: {
            type: 'object',
            description:
              'Read strategy. Use type="full" to return the whole file. Use type="lines" to read a targeted range, and prefer lines for large files or when headings/line numbers are already known.',
            properties: {
              type: {
                type: 'string',
                enum: ['full', 'lines'],
              },
              startLine: {
                type: 'integer',
                description: `Required for lines. 1-based start line. Defaults to ${DEFAULT_READ_START_LINE} when omitted.`,
              },
              maxLines: {
                type: 'integer',
                description: `Optional for lines when endLine is not set. Defaults to ${DEFAULT_READ_MAX_LINES}, range 1-${MAX_READ_MAX_LINES}.`,
              },
              endLine: {
                type: 'integer',
                description:
                  'Optional for lines. 1-based inclusive end line. If set, maxLines is ignored.',
              },
            },
            required: ['type'],
          },
        },
        required: ['paths', 'operation'],
      },
    },
    {
      name: 'context_prune_tool_results',
      description:
        'Exclude historical tool call results from future model-visible context without deleting chat history. Supports pruning selected calls or all prunable calls at once.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['selected', 'all'],
            description:
              'Prune mode. Use selected to prune specific toolCallIds, or all to prune all historical prunable tool results.',
          },
          toolCallIds: {
            type: 'array',
            items: {
              type: 'string',
            },
            description:
              'Tool call ids to exclude from future prompt context when mode is selected.',
          },
          reason: {
            type: 'string',
            description:
              'Optional short reason for pruning, such as superseded by newer results or preparing for a fresh planning step.',
          },
        },
      },
    },
    {
      name: 'context_compact',
      description:
        'Compact earlier conversation history into a summary and continue in a fresh context window while preserving visible chat history.',
      inputSchema: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description:
              'Optional short reason for compacting, such as context is getting crowded.',
          },
          instruction: {
            type: 'string',
            description:
              'Optional focus hint for the summary, such as preserve file paths and pending tasks.',
          },
        },
      },
    },
    {
      name: 'fs_edit',
      description:
        'Apply exactly one text edit operation within a single existing file. Prefer this tool when modifying content in an existing file. Supports replace, replace_lines, insert_after, and append.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Vault-relative file path.',
          },
          operation: {
            type: 'object',
            description:
              'A single text edit operation to apply. Supports replace, replace_lines, insert_after, and append.',
            properties: {
              type: {
                type: 'string',
                enum: ['replace', 'replace_lines', 'insert_after', 'append'],
              },
              oldText: {
                type: 'string',
                description: 'Required for replace.',
              },
              newText: {
                type: 'string',
                description: 'Required for replace and replace_lines.',
              },
              startLine: {
                type: 'integer',
                description:
                  'Required for replace_lines. 1-based inclusive start line.',
              },
              endLine: {
                type: 'integer',
                description:
                  'Required for replace_lines. 1-based inclusive end line.',
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
        required: ['path', 'operation'],
      },
    },
    {
      name: 'fs_create_file',
      description:
        'Create file(s) in the vault. Use path/content for a single file or items[] for batch creation.',
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
          items: {
            type: 'array',
            minItems: 1,
            items: {
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
              },
              required: ['path', 'content'],
            },
          },
          dryRun: {
            type: 'boolean',
            description:
              'If true, validate and preview result without applying changes.',
          },
        },
      },
    },
    {
      name: 'fs_delete_file',
      description:
        'Delete file(s) in the vault. Use path for a single file or items[] for batch deletion.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Vault-relative file path.',
          },
          items: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: 'Vault-relative file path.',
                },
              },
              required: ['path'],
            },
          },
          dryRun: {
            type: 'boolean',
            description:
              'If true, validate and preview result without applying changes.',
          },
        },
      },
    },
    {
      name: 'fs_create_dir',
      description:
        'Create folder(s) in the vault. Use path for a single folder or items[] for batch creation.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Vault-relative folder path.',
          },
          items: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: 'Vault-relative folder path.',
                },
              },
              required: ['path'],
            },
          },
          dryRun: {
            type: 'boolean',
            description:
              'If true, validate and preview result without applying changes.',
          },
        },
      },
    },
    {
      name: 'fs_delete_dir',
      description:
        'Delete folder(s) in the vault. Use path for a single folder or items[] for batch deletion.',
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
          items: {
            type: 'array',
            minItems: 1,
            items: {
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
              },
              required: ['path'],
            },
          },
          dryRun: {
            type: 'boolean',
            description:
              'If true, validate and preview result without applying changes.',
          },
        },
      },
    },
    {
      name: 'fs_move',
      description:
        'Move or rename file/folder path(s) in the vault. Use oldPath/newPath for a single move or items[] for batch moves.',
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
          items: {
            type: 'array',
            minItems: 1,
            items: {
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
              },
              required: ['oldPath', 'newPath'],
            },
          },
          dryRun: {
            type: 'boolean',
            description:
              'If true, validate and preview result without applying changes.',
          },
        },
      },
    },
    {
      name: 'memory_add',
      description:
        'Add memory entries to global or assistant memory. Supports single entry or batch items; category defaults to other and id is auto-assigned.',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'Memory content text to store.',
          },
          items: {
            type: 'array',
            description:
              'Batch add items. Each item accepts content, optional category, and optional scope.',
            items: {
              type: 'object',
              properties: {
                content: {
                  type: 'string',
                },
                category: {
                  type: 'string',
                },
                scope: {
                  type: 'string',
                  enum: ['global', 'assistant'],
                },
              },
              required: ['content'],
            },
          },
          category: {
            type: 'string',
            description:
              'Memory category. Use profile, preferences, or other. Defaults to other.',
          },
          scope: {
            type: 'string',
            enum: ['global', 'assistant'],
            description:
              'Memory scope. Defaults to assistant, and may fallback to global when assistant memory is unavailable.',
          },
        },
      },
    },
    {
      name: 'memory_update',
      description:
        'Update an existing memory entry by id within global or assistant memory.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Memory id such as Profile_2 or Memory_4.',
          },
          new_content: {
            type: 'string',
            description: 'Replacement content for the target memory id.',
          },
          scope: {
            type: 'string',
            enum: ['global', 'assistant'],
            description:
              'Memory scope. Defaults to assistant, and may fallback to global when assistant memory is unavailable.',
          },
        },
        required: ['id', 'new_content'],
      },
    },
    {
      name: 'memory_delete',
      description:
        'Delete memory entries by id from global or assistant memory. Supports single id or batch ids.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Memory id such as Preference_1.',
          },
          ids: {
            type: 'array',
            items: {
              type: 'string',
            },
            description:
              'Batch delete ids. Each id must exist in the selected memory scope.',
          },
          scope: {
            type: 'string',
            enum: ['global', 'assistant'],
            description:
              'Memory scope. Defaults to assistant, and may fallback to global when assistant memory is unavailable.',
          },
        },
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

const getOptionalBoundedFloatArg = (
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined => {
  const value = args[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number.`)
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

const getFsFileOpItems = ({
  args,
  itemFactory,
}: {
  args: Record<string, unknown>
  itemFactory: () => Record<string, unknown>
}): Record<string, unknown>[] => {
  if (args.items !== undefined) {
    const items = getRecordArrayArg(args, 'items')
    if (items.length === 0) {
      throw new Error('items must contain at least one entry.')
    }
    return items
  }

  return [itemFactory()]
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

const ensureFolderPathExists = async (
  app: App,
  path: string,
): Promise<void> => {
  const normalizedPath = validateVaultPath(path)
  const existing = app.vault.getAbstractFileByPath(normalizedPath)
  if (existing) {
    if (!(existing instanceof TFolder)) {
      throw new Error(`Path is not a folder: ${normalizedPath}`)
    }
    return
  }

  const parentFolderPath = getParentFolderPath(normalizedPath)
  if (parentFolderPath) {
    await ensureFolderPathExists(app, parentFolderPath)
  }

  await app.vault.createFolder(normalizedPath)
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

const truncateRagSnippet = (text: string): string => {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= MAX_RAG_SNIPPET_CHARS) {
    return normalized
  }
  return `${normalized.slice(0, MAX_RAG_SNIPPET_CHARS)}...`
}

const legacyFsSearchItemsToSuper = (
  items: LegacyFsSearchItem[],
  source: 'keyword' | 'rag',
): SuperSearchResult[] => {
  return items.map((item) => {
    if (item.kind === 'file') {
      return { kind: 'file', path: item.path, source }
    }
    if (item.kind === 'dir') {
      return { kind: 'dir', path: item.path, source }
    }
    return {
      kind: 'content',
      path: item.path,
      line: item.line,
      startLine: item.line,
      endLine: item.line,
      snippet: item.snippet,
      source,
    }
  })
}

type RagEmbeddingRow = {
  path: string
  content: string
  metadata: { startLine: number; endLine: number }
  similarity: number
}

const mapRagRowsToSuper = (
  rows: RagEmbeddingRow[],
  source: 'rag',
): SuperSearchResult[] => {
  return rows.map((row) => ({
    kind: 'content' as const,
    path: row.path,
    line: row.metadata.startLine,
    startLine: row.metadata.startLine,
    endLine: row.metadata.endLine,
    snippet: truncateRagSnippet(row.content),
    similarity: row.similarity,
    source,
  }))
}

const pathFolderToRagScope = (
  normalizedFolderPath: string,
): { files: string[]; folders: string[] } | undefined => {
  if (!normalizedFolderPath) {
    return undefined
  }
  return { files: [], folders: [normalizedFolderPath] }
}

const collectKeywordFsSearchResults = async ({
  app,
  scopeFolder,
  scope,
  query,
  maxResults,
  caseSensitive,
  signal,
}: {
  app: App
  scopeFolder: { folder: TFolder; normalizedPath: string }
  scope: FsSearchScope
  query: string
  maxResults: number
  caseSensitive: boolean
  signal?: AbortSignal
}): Promise<LegacyFsSearchItem[]> => {
  const queryForMatch = caseSensitive ? query : query.toLowerCase()
  const queryTokens = Array.from(
    new Set(
      queryForMatch
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 0),
    ),
  )
  const effectiveTokens =
    queryTokens.length > 0 ? queryTokens : queryForMatch ? [queryForMatch] : []

  const getTokenMatchSummary = (
    sourceText: string,
  ): {
    matchedTokenCount: number
    firstMatchIndex: number
    bestMatchLength: number
  } | null => {
    if (!query) {
      return {
        matchedTokenCount: 0,
        firstMatchIndex: 0,
        bestMatchLength: 0,
      }
    }

    let matchedTokenCount = 0
    let firstMatchIndex = Number.MAX_SAFE_INTEGER
    let bestMatchLength = 0

    for (const token of effectiveTokens) {
      const matchIndex = sourceText.indexOf(token)
      if (matchIndex === -1) {
        continue
      }
      matchedTokenCount += 1
      if (matchIndex < firstMatchIndex) {
        firstMatchIndex = matchIndex
        bestMatchLength = token.length
      }
    }

    if (matchedTokenCount === 0) {
      return null
    }

    return {
      matchedTokenCount,
      firstMatchIndex,
      bestMatchLength,
    }
  }

  const getPathMatchSummary = (path: string) => {
    if (!query) {
      return {
        matchedTokenCount: 0,
        firstMatchIndex: 0,
        bestMatchLength: 0,
      }
    }

    const sourceText = caseSensitive ? path : path.toLowerCase()
    return getTokenMatchSummary(sourceText)
  }

  const includeFiles = scope === 'files' || scope === 'all'
  const includeDirs = scope === 'dirs' || scope === 'all'
  const includeContent = scope === 'content' || scope === 'all'

  if (includeContent && !query) {
    throw new Error('query is required when scope includes content.')
  }

  const results: LegacyFsSearchItem[] = []
  if (includeFiles) {
    const files = app.vault
      .getFiles()
      .filter((file) =>
        isPathWithinFolder(file.path, scopeFolder.normalizedPath),
      )
      .map((file) => file.path)
      .map((path) => ({
        path,
        match: getPathMatchSummary(path),
      }))
      .filter(
        (
          entry,
        ): entry is {
          path: string
          match: {
            matchedTokenCount: number
            firstMatchIndex: number
            bestMatchLength: number
          }
        } => entry.match !== null,
      )
      .sort((a, b) => {
        if (a.match.matchedTokenCount !== b.match.matchedTokenCount) {
          return b.match.matchedTokenCount - a.match.matchedTokenCount
        }
        if (a.match.firstMatchIndex !== b.match.firstMatchIndex) {
          return a.match.firstMatchIndex - b.match.firstMatchIndex
        }
        return a.path.localeCompare(b.path)
      })

    for (const fileEntry of files) {
      if (results.length >= maxResults) break
      results.push({ kind: 'file', path: fileEntry.path })
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
      .map((path) => ({
        path,
        match: getPathMatchSummary(path),
      }))
      .filter(
        (
          entry,
        ): entry is {
          path: string
          match: {
            matchedTokenCount: number
            firstMatchIndex: number
            bestMatchLength: number
          }
        } => entry.match !== null,
      )
      .sort((a, b) => {
        if (a.match.matchedTokenCount !== b.match.matchedTokenCount) {
          return b.match.matchedTokenCount - a.match.matchedTokenCount
        }
        if (a.match.firstMatchIndex !== b.match.firstMatchIndex) {
          return a.match.firstMatchIndex - b.match.firstMatchIndex
        }
        return a.path.localeCompare(b.path)
      })

    for (const dirEntry of dirs) {
      if (results.length >= maxResults) break
      results.push({ kind: 'dir', path: dirEntry.path })
    }
  }

  if (includeContent && results.length < maxResults) {
    const searchableFiles = app.vault
      .getMarkdownFiles()
      .filter((file) =>
        isPathWithinFolder(file.path, scopeFolder.normalizedPath),
      )
      .sort((a, b) => a.path.localeCompare(b.path))
    const contentMatches: Array<{
      kind: 'content_match'
      path: string
      line: number
      snippet: string
      matchedTokenCount: number
      firstMatchIndex: number
    }> = []

    for (const file of searchableFiles) {
      if (signal?.aborted) {
        break
      }
      if (file.stat.size > MAX_FILE_SIZE_BYTES) {
        continue
      }

      const content = await app.vault.read(file)
      const source = caseSensitive ? content : content.toLowerCase()
      const match = getTokenMatchSummary(source)
      if (!match) {
        continue
      }

      const matchIndex = match.firstMatchIndex
      const line = content.slice(0, matchIndex).split('\n').length
      const snippet = makeContentSnippet({
        content,
        matchIndex,
        matchLength: match.bestMatchLength,
      })
      contentMatches.push({
        kind: 'content_match',
        path: file.path,
        line,
        snippet,
        matchedTokenCount: match.matchedTokenCount,
        firstMatchIndex: match.firstMatchIndex,
      })
    }

    contentMatches
      .sort((a, b) => {
        if (a.matchedTokenCount !== b.matchedTokenCount) {
          return b.matchedTokenCount - a.matchedTokenCount
        }
        if (a.firstMatchIndex !== b.firstMatchIndex) {
          return a.firstMatchIndex - b.firstMatchIndex
        }
        if (a.line !== b.line) {
          return a.line - b.line
        }
        return a.path.localeCompare(b.path)
      })
      .slice(0, Math.max(maxResults - results.length, 0))
      .forEach(({ matchedTokenCount: _matchedTokenCount, firstMatchIndex: _firstMatchIndex, ...item }) => {
        void _matchedTokenCount
        void _firstMatchIndex
        results.push(item)
      })
  }

  return results
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

const getFsSearchMode = (args: Record<string, unknown>): FsSearchMode => {
  const value = args.mode
  if (value === undefined) {
    return 'hybrid'
  }
  if (value !== 'keyword' && value !== 'rag' && value !== 'hybrid') {
    throw new Error('mode must be one of: keyword, rag, hybrid.')
  }
  return value
}

const getOptionalFsSearchScope = (
  args: Record<string, unknown>,
  defaultScope: FsSearchScope,
): FsSearchScope => {
  if (args.scope === undefined) {
    return defaultScope
  }
  return getFsSearchScope(args)
}

const getSemanticSearchUnavailableReason = ({
  settings,
  getRagEngine,
}: {
  settings?: SmartComposerSettings
  getRagEngine?: () => Promise<RAGEngine>
}): string | null => {
  if (!getRagEngine || !settings) {
    return 'Semantic search is not available in this context.'
  }
  if (!settings.ragOptions.enabled) {
    return 'RAG is not enabled. Fell back to keyword search.'
  }
  if (!settings.embeddingModelId?.trim()) {
    return 'No embedding model configured. Fell back to keyword search.'
  }
  return null
}

const getContextPruneMode = (
  args: Record<string, unknown>,
): ContextPruneMode => {
  const value = args.mode
  if (value === undefined) {
    return 'selected'
  }
  if (value !== 'selected' && value !== 'all') {
    throw new Error('mode must be one of: selected, all.')
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
): TextEditOperation => {
  const type = asOptionalString(operation.type).trim().toLowerCase()

  if (type === 'replace') {
    const oldText = getTextArg(operation, 'oldText')
    if (oldText.length === 0) {
      throw new Error(`operation.oldText must not be empty.`)
    }

    return {
      type: 'replace',
      oldText,
      newText: getTextArg(operation, 'newText'),
      expectedOccurrences: asPositiveInteger(operation.expectedOccurrences),
    }
  }

  if (type === 'replace_lines') {
    const startLine = asPositiveInteger(operation.startLine)
    if (!startLine) {
      throw new Error('operation.startLine must be a positive integer.')
    }
    const endLine = asPositiveInteger(operation.endLine)
    if (!endLine) {
      throw new Error('operation.endLine must be a positive integer.')
    }

    return {
      type: 'replace_lines',
      startLine,
      endLine,
      newText: getTextArg(operation, 'newText'),
    }
  }

  if (type === 'insert_after') {
    const anchor = getTextArg(operation, 'anchor')
    if (anchor.length === 0) {
      throw new Error(`operation.anchor must not be empty.`)
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
    `operation.type must be one of: replace, replace_lines, insert_after, append.`,
  )
}

const coerceOperationObject = (
  operation: unknown,
): Record<string, unknown> => {
  if (typeof operation === 'string') {
    const trimmed = operation.trim()
    if (trimmed.length > 0) {
      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>
        }
      } catch {
        // fall through to the standard error below
      }
    }
    throw new Error(
      'operation must be a nested JSON object, not a string. Pass it directly as { "type": "...", ... } — do not wrap it in quotes or call JSON.stringify on it.',
    )
  }

  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new Error(
      'operation must be a nested JSON object like { "type": "...", ... }.',
    )
  }

  return operation as Record<string, unknown>
}

const getFsEditPlan = (args: Record<string, unknown>): TextEditPlan => {
  const operation = coerceOperationObject(args.operation)

  return {
    operations: [parseTextEditOperation(operation)],
  }
}

const getFsReadOperation = (args: Record<string, unknown>): FsReadOperation => {
  const parsedOperation = coerceOperationObject(args.operation)
  const type = asOptionalString(parsedOperation.type).trim().toLowerCase()

  if (type === 'full') {
    return { type: 'full' }
  }

  if (type === 'lines') {
    const startLine = getOptionalIntegerArg({
      args: parsedOperation,
      key: 'startLine',
      defaultValue: DEFAULT_READ_START_LINE,
      min: 1,
      max: MAX_READ_LINE_INDEX,
    })

    const maxLines = getOptionalIntegerArg({
      args: parsedOperation,
      key: 'maxLines',
      defaultValue: DEFAULT_READ_MAX_LINES,
      min: 1,
      max: MAX_READ_MAX_LINES,
    })

    const endLine = getOptionalBoundedIntegerArg({
      args: parsedOperation,
      key: 'endLine',
      min: 1,
      max: MAX_READ_LINE_INDEX,
    })

    if (endLine !== undefined && endLine < startLine) {
      throw new Error(
        'operation.endLine must be greater than or equal to operation.startLine.',
      )
    }

    if (endLine !== undefined && endLine - startLine + 1 > MAX_READ_MAX_LINES) {
      throw new Error(
        `Requested line range is too large. Maximum ${MAX_READ_MAX_LINES} lines per file.`,
      )
    }

    return {
      type: 'lines',
      startLine,
      endLine,
      maxLines,
    }
  }

  throw new Error('operation.type must be one of: full, lines.')
}

const ensureParentFolderExists = async (
  app: App,
  path: string,
): Promise<void> => {
  const parentFolderPath = getParentFolderPath(path)
  if (!parentFolderPath) {
    return
  }
  await ensureFolderPathExists(app, parentFolderPath)
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
  settings,
  action,
  items,
  dryRun,
  signal,
  tool,
  conversationId,
  roundId,
  toolCallId,
}: {
  app: App
  settings?: SmartComposerSettings
  action: FsFileOpAction
  items: Record<string, unknown>[]
  dryRun: boolean
  signal?: AbortSignal
  tool: string
  conversationId?: string
  roundId?: string
  toolCallId?: string
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
  let summaryFiles: ToolEditSummary['files'] = []
  let totalAddedLines = 0
  let totalRemovedLines = 0
  const appliedAt = Date.now()

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
        await ensureParentFolderExists(app, path)

        if (!dryRun) {
          await app.vault.create(path, content)
        }

        if (!dryRun) {
          let editSummary = createToolEditSummary({
            path,
            beforeContent: '',
            afterContent: content,
            beforeExists: false,
            afterExists: true,
            reviewRoundId: roundId,
          })

          if (toolCallId && editSummary) {
            editUndoSnapshotStore.set({
              toolCallId,
              path,
              beforeContent: '',
              afterContent: content,
              beforeExists: false,
              afterExists: true,
              appliedAt,
            })
          }

          if (conversationId && roundId && editSummary) {
            const snapshot = await upsertEditReviewSnapshot({
              app,
              conversationId,
              roundId,
              filePath: path,
              beforeContent: '',
              afterContent: content,
              beforeExists: false,
              afterExists: true,
              settings,
            })
            editSummary = {
              ...editSummary,
              files: editSummary.files.map((file) => ({
                ...file,
                addedLines: snapshot.addedLines,
                removedLines: snapshot.removedLines,
                reviewRoundId: roundId,
              })),
              totalAddedLines: snapshot.addedLines,
              totalRemovedLines: snapshot.removedLines,
            }
          }

          if (editSummary) {
            summaryFiles = [...summaryFiles, ...editSummary.files]
            totalAddedLines += editSummary.totalAddedLines
            totalRemovedLines += editSummary.totalRemovedLines
          }
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
        const content = await app.vault.read(existing)

        if (!dryRun) {
          await app.fileManager.trashFile(existing)
        }

        if (!dryRun) {
          let editSummary = createToolEditSummary({
            path,
            beforeContent: content,
            afterContent: '',
            beforeExists: true,
            afterExists: false,
            reviewRoundId: roundId,
          })

          if (toolCallId && editSummary) {
            editUndoSnapshotStore.set({
              toolCallId,
              path,
              beforeContent: content,
              afterContent: '',
              beforeExists: true,
              afterExists: false,
              appliedAt,
            })
          }

          if (conversationId && roundId && editSummary) {
            const snapshot = await upsertEditReviewSnapshot({
              app,
              conversationId,
              roundId,
              filePath: path,
              beforeContent: content,
              afterContent: '',
              beforeExists: true,
              afterExists: false,
              settings,
            })
            editSummary = {
              ...editSummary,
              files: editSummary.files.map((file) => ({
                ...file,
                addedLines: snapshot.addedLines,
                removedLines: snapshot.removedLines,
                reviewRoundId: roundId,
              })),
              totalAddedLines: snapshot.addedLines,
              totalRemovedLines: snapshot.removedLines,
            }
          }

          if (editSummary) {
            summaryFiles = [...summaryFiles, ...editSummary.files]
            totalAddedLines += editSummary.totalAddedLines
            totalRemovedLines += editSummary.totalRemovedLines
          }
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
        await ensureParentFolderExists(app, path)

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
        await ensureParentFolderExists(app, newPath)

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
    metadata:
      dryRun || summaryFiles.length === 0
        ? undefined
        : {
            editSummary: {
              files: summaryFiles,
              totalFiles: summaryFiles.length,
              totalAddedLines,
              totalRemovedLines,
              undoStatus: deriveToolEditUndoStatus(summaryFiles),
            },
            appliedAt,
          },
  }
}

export async function callLocalFileTool({
  app,
  settings,
  openApplyReview,
  getRagEngine,
  conversationId,
  conversationMessages,
  roundId,
  toolCallId,
  toolName,
  args,
  requireReview = false,
  signal,
}: {
  app: App
  settings?: SmartComposerSettings
  openApplyReview?: (state: ApplyViewState) => Promise<boolean>
  getRagEngine?: () => Promise<RAGEngine>
  conversationId?: string
  conversationMessages?: ChatMessage[]
  roundId?: string
  toolCallId?: string
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
        const operation = getFsReadOperation(args)

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

          let outputContent = ''
          let returnedStartLine: number | null = null
          let returnedEndLine: number | null = null
          let returnedCount = 0
          let hasMoreAbove = false
          let hasMoreBelow = false
          let nextStartLine: number | null = null

          if (operation.type === 'full') {
            outputContent = lines
              .map((line, index) => `${index + 1}|${line}`)
              .join('\n')
            returnedCount = totalLines
            returnedStartLine = totalLines > 0 ? 1 : null
            returnedEndLine = totalLines > 0 ? totalLines : null
          } else {
            const startIndex = Math.min(
              Math.max(operation.startLine - 1, 0),
              totalLines,
            )
            const endExclusive = Math.min(
              totalLines,
              operation.endLine ?? startIndex + operation.maxLines,
            )
            const selectedLines = lines.slice(startIndex, endExclusive)
            outputContent = selectedLines
              .map((line, index) => `${startIndex + index + 1}|${line}`)
              .join('\n')
            returnedCount = selectedLines.length
            returnedStartLine = returnedCount > 0 ? startIndex + 1 : null
            returnedEndLine =
              returnedCount > 0 ? startIndex + returnedCount : null
            hasMoreAbove = startIndex > 0
            hasMoreBelow = endExclusive < totalLines
            nextStartLine = hasMoreBelow ? endExclusive + 1 : null
          }

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
            nextStartLine,
            content: outputContent,
          })
        }

        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'fs_read',
            toolCallId: toolCallId ?? null,
            requestedOperation: {
              type: operation.type,
              startLine:
                operation.type === 'lines' ? operation.startLine : null,
              endLine:
                operation.type === 'lines' ? (operation.endLine ?? null) : null,
              maxLines:
                operation.type === 'lines' && operation.endLine === undefined
                  ? operation.maxLines
                  : null,
            },
            results,
          }),
        }
      }

      case 'context_prune_tool_results': {
        const mode = getContextPruneMode(args)

        const prunableToolCallIds = getContextPrunableToolCallIds(
          conversationMessages,
          toolCallId,
        )
        const toolCallIds =
          mode === 'all'
            ? [...prunableToolCallIds]
            : getStringArrayArg(args, 'toolCallIds')
                .map((value) => value.trim())
                .filter(
                  (value, index, arr) =>
                    value.length > 0 && arr.indexOf(value) === index,
                )

        if (mode === 'selected' && toolCallIds.length === 0) {
          throw new Error('toolCallIds cannot be empty when mode is selected.')
        }

        const acceptedToolCallIds = toolCallIds.filter((value) =>
          prunableToolCallIds.has(value),
        )
        const ignoredToolCallIds = toolCallIds.filter(
          (value) => !prunableToolCallIds.has(value),
        )

        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'context_prune_tool_results',
            toolCallId: toolCallId ?? null,
            operation: mode === 'all' ? 'prune_all' : 'prune_selected',
            acceptedToolCallIds,
            ignoredToolCallIds,
            reason: getOptionalTextArg(args, 'reason')?.trim() || null,
          }),
        }
      }

      case 'context_compact': {
        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'context_compact',
            toolCallId: toolCallId ?? null,
            operation: 'compact_restart',
            reason: getOptionalTextArg(args, 'reason')?.trim() || null,
            instruction:
              getOptionalTextArg(args, 'instruction')?.trim() || null,
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

        let editSummary = createToolEditSummary({
          path,
          beforeContent: content,
          afterContent: appliedContent,
          reviewRoundId: roundId,
        })
        const appliedAt = Date.now()
        if (toolCallId && editSummary) {
          editUndoSnapshotStore.set({
            toolCallId,
            path,
            beforeContent: content,
            afterContent: appliedContent,
            beforeExists: true,
            afterExists: true,
            appliedAt,
          })
        }

        if (conversationId && roundId && editSummary) {
          const snapshot = await upsertEditReviewSnapshot({
            app,
            conversationId,
            roundId,
            filePath: path,
            beforeContent: content,
            afterContent: appliedContent,
            beforeExists: true,
            afterExists: true,
            settings,
          })
          editSummary = {
            ...editSummary,
            files: editSummary.files.map((file) => ({
              ...file,
              addedLines: snapshot.addedLines,
              removedLines: snapshot.removedLines,
              reviewRoundId: roundId,
            })),
            totalAddedLines: snapshot.addedLines,
            totalRemovedLines: snapshot.removedLines,
          }
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
          metadata: {
            editSummary,
            appliedAt,
          },
        }
      }

      case 'fs_create_file': {
        const dryRun = getOptionalBooleanArg(args, 'dryRun') ?? false
        return executeFsFileOps({
          app,
          settings,
          action: 'create_file',
          items: getFsFileOpItems({
            args,
            itemFactory: () => ({
              path: getTextArg(args, 'path'),
              content: getTextArg(args, 'content'),
            }),
          }),
          dryRun,
          signal,
          tool: 'fs_create_file',
          conversationId,
          roundId,
          toolCallId,
        })
      }

      case 'fs_delete_file': {
        const dryRun = getOptionalBooleanArg(args, 'dryRun') ?? false
        return executeFsFileOps({
          app,
          settings,
          action: 'delete_file',
          items: getFsFileOpItems({
            args,
            itemFactory: () => ({ path: getTextArg(args, 'path') }),
          }),
          dryRun,
          signal,
          tool: 'fs_delete_file',
          conversationId,
          roundId,
          toolCallId,
        })
      }

      case 'fs_create_dir': {
        const dryRun = getOptionalBooleanArg(args, 'dryRun') ?? false
        return executeFsFileOps({
          app,
          action: 'create_dir',
          items: getFsFileOpItems({
            args,
            itemFactory: () => ({ path: getTextArg(args, 'path') }),
          }),
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
          items: getFsFileOpItems({
            args,
            itemFactory: () => ({
              path: getTextArg(args, 'path'),
              ...(recursive === undefined ? {} : { recursive }),
            }),
          }),
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
          items: getFsFileOpItems({
            args,
            itemFactory: () => ({
              oldPath: getTextArg(args, 'oldPath'),
              newPath: getTextArg(args, 'newPath'),
            }),
          }),
          dryRun,
          signal,
          tool: 'fs_move',
        })
      }

      case 'fs_search': {
        const requestedMode = getFsSearchMode(args)
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
        const ragMinSimilarity = getOptionalBoundedFloatArg(
          args,
          'ragMinSimilarity',
          0,
          1,
        )
        const ragLimitArg = getOptionalBoundedIntegerArg({
          args,
          key: 'ragLimit',
          min: 1,
          max: RAG_FETCH_LIMIT_MAX,
        })
        const semanticUnavailableReason =
          requestedMode === 'keyword'
            ? null
            : getSemanticSearchUnavailableReason({ settings, getRagEngine })
        const effectiveMode: FsSearchMode =
          requestedMode === 'hybrid' && semanticUnavailableReason
            ? 'keyword'
            : requestedMode

        if (effectiveMode === 'keyword') {
          const scope = getOptionalFsSearchScope(args, 'all')
          const legacy = await collectKeywordFsSearchResults({
            app,
            scopeFolder,
            scope,
            query,
            maxResults,
            caseSensitive,
            signal,
          })
          if (signal?.aborted) {
            return { status: ToolCallResponseStatus.Aborted }
          }
          const results = legacyFsSearchItemsToSuper(legacy, 'keyword')
          return {
            status: ToolCallResponseStatus.Success,
            text: formatJsonResult({
              tool: 'fs_search',
              requestedMode,
              effectiveMode,
              fallbackReason:
                requestedMode !== effectiveMode
                  ? semanticUnavailableReason
                  : undefined,
              scope,
              query,
              path: scopeFolder.normalizedPath,
              results: aggregateSearchResults({ results, maxResults }),
            }),
          }
        }

        if (semanticUnavailableReason) {
          throw new Error(
            semanticUnavailableReason.replace(
              ' Fell back to keyword search.',
              '',
            ),
          )
        }
        if (!query) {
          throw new Error('query is required for rag/hybrid mode.')
        }
        if (!getRagEngine || !settings) {
          throw new Error('Semantic search is not available in this context.')
        }

        const rawScope = args.scope
        if (rawScope === 'files' || rawScope === 'dirs') {
          throw new Error(
            'rag mode only supports content search. Use keyword or hybrid for file/dir search.',
          )
        }

        const ragEngine = await getRagEngine()
        const ragScope = pathFolderToRagScope(scopeFolder.normalizedPath)

        const effectiveRagLimit = Math.min(
          ragLimitArg ?? settings.ragOptions.limit,
          RAG_FETCH_LIMIT_MAX,
        )

        const ragRows = await ragEngine.processQuery({
          query,
          scope: ragScope,
          minSimilarity: ragMinSimilarity,
          limit: effectiveRagLimit,
        })

        const ragMapped = mapRagRowsToSuper(ragRows as RagEmbeddingRow[], 'rag')

        if (effectiveMode === 'rag') {
          const effectiveScope: FsSearchScope =
            rawScope === undefined ? 'content' : (rawScope as FsSearchScope)
          const results = ragMapped.slice(0, maxResults)
          return {
            status: ToolCallResponseStatus.Success,
            text: formatJsonResult({
              tool: 'fs_search',
              requestedMode,
              effectiveMode: 'rag',
              scope: effectiveScope,
              query,
              path: scopeFolder.normalizedPath,
              results: aggregateSearchResults({ results, maxResults }),
            }),
          }
        }

        const keywordLegacy = await collectKeywordFsSearchResults({
          app,
          scopeFolder,
          scope: 'content',
          query,
          maxResults,
          caseSensitive,
          signal,
        })
        if (signal?.aborted) {
          return { status: ToolCallResponseStatus.Aborted }
        }
        const keywordSuper = legacyFsSearchItemsToSuper(
          keywordLegacy,
          'keyword',
        )
        const pathLegacyFiles = await collectKeywordFsSearchResults({
          app,
          scopeFolder,
          scope: 'files',
          query,
          maxResults,
          caseSensitive,
          signal,
        })
        if (signal?.aborted) {
          return { status: ToolCallResponseStatus.Aborted }
        }
        const pathLegacyDirs = await collectKeywordFsSearchResults({
          app,
          scopeFolder,
          scope: 'dirs',
          query,
          maxResults,
          caseSensitive,
          signal,
        })
        if (signal?.aborted) {
          return { status: ToolCallResponseStatus.Aborted }
        }
        const pathSuper = legacyFsSearchItemsToSuper(
          [...pathLegacyFiles, ...pathLegacyDirs],
          'keyword',
        )
        const fused = fuseRrfHybrid({
          pathResults: pathSuper,
          keywordResults: keywordSuper,
          ragResults: ragMapped,
          maxResults,
        })
        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'fs_search',
            requestedMode,
            effectiveMode: 'hybrid',
            scope: 'content',
            query,
            path: scopeFolder.normalizedPath,
            results: aggregateSearchResults({ results: fused, maxResults }),
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

      case 'memory_add': {
        if (args.items !== undefined) {
          const items = getRecordArrayArg(args, 'items')
          if (items.length === 0) {
            throw new Error('items cannot be empty.')
          }

          const results: Array<
            | {
                ok: true
                id: string
                scope: MemoryScope
                filePath: string
              }
            | {
                ok: false
                error: string
                scope: MemoryScope
              }
          > = []

          for (const item of items) {
            try {
              const result = await memoryAdd({
                app,
                settings,
                content: item.content,
                category: item.category,
                scope: item.scope ?? args.scope,
                assistantId: settings?.currentAssistantId,
              })
              results.push({
                ok: true,
                id: result.id,
                scope: result.scope,
                filePath: result.filePath,
              })
            } catch (error) {
              results.push({
                ok: false,
                error: asErrorMessage(error),
                scope:
                  typeof (item.scope ?? args.scope) === 'string' &&
                  String(item.scope ?? args.scope)
                    .trim()
                    .toLowerCase() === 'global'
                    ? 'global'
                    : 'assistant',
              })
            }
          }

          return {
            status: ToolCallResponseStatus.Success,
            text: formatJsonResult({
              tool: 'memory_add',
              mode: 'batch',
              results,
              okCount: results.filter((result) => result.ok).length,
              failCount: results.filter((result) => !result.ok).length,
            }),
          }
        }

        if (args.content === undefined) {
          throw new Error('content or items is required.')
        }

        const result = await memoryAdd({
          app,
          settings,
          content: args.content,
          category: args.category,
          scope: args.scope,
          assistantId: settings?.currentAssistantId,
        })

        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'memory_add',
            id: result.id,
            scope: result.scope,
            filePath: result.filePath,
          }),
        }
      }

      case 'memory_update': {
        const result = await memoryUpdate({
          app,
          settings,
          id: args.id,
          newContent: args.new_content,
          scope: args.scope,
          assistantId: settings?.currentAssistantId,
        })

        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'memory_update',
            id: result.id,
            scope: result.scope,
            filePath: result.filePath,
          }),
        }
      }

      case 'memory_delete': {
        if (args.ids !== undefined) {
          const ids = getStringArrayArg(args, 'ids')
          if (ids.length === 0) {
            throw new Error('ids cannot be empty.')
          }

          const results: Array<
            | {
                ok: true
                id: string
                scope: MemoryScope
                filePath: string
              }
            | {
                ok: false
                id: string
                error: string
                scope: MemoryScope
              }
          > = []

          for (const id of ids) {
            try {
              const result = await memoryDelete({
                app,
                settings,
                id,
                scope: args.scope,
                assistantId: settings?.currentAssistantId,
              })
              results.push({
                ok: true,
                id: result.id,
                scope: result.scope,
                filePath: result.filePath,
              })
            } catch (error) {
              results.push({
                ok: false,
                id,
                error: asErrorMessage(error),
                scope:
                  typeof args.scope === 'string' &&
                  args.scope.trim().toLowerCase() === 'global'
                    ? 'global'
                    : 'assistant',
              })
            }
          }

          return {
            status: ToolCallResponseStatus.Success,
            text: formatJsonResult({
              tool: 'memory_delete',
              mode: 'batch',
              results,
              okCount: results.filter((result) => result.ok).length,
              failCount: results.filter((result) => !result.ok).length,
            }),
          }
        }

        if (args.id === undefined) {
          throw new Error('id or ids is required.')
        }

        const result = await memoryDelete({
          app,
          settings,
          id: args.id,
          scope: args.scope,
          assistantId: settings?.currentAssistantId,
        })

        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'memory_delete',
            id: result.id,
            scope: result.scope,
            filePath: result.filePath,
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
