import { App, TFile, TFolder, normalizePath } from 'obsidian'

import { upsertEditReviewSnapshot } from '../../database/json/chat/editReviewSnapshotStore'
import { buildPdfPageImageCacheKey } from '../../database/json/chat/imageCacheStore'
import type { SmartComposerSettings } from '../../settings/schema/setting.types'
import type { ApplyViewState } from '../../types/apply-view.types'
import type { AssistantWorkspaceScope } from '../../types/assistant.types'
import type { ChatMessage } from '../../types/chat'
import type { ContentPart } from '../../types/llm/request'
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
import { collectWikilinkPaths } from '../../utils/llm/annotate-wikilinks'
import { extractMarkdownImages } from '../../utils/llm/extract-markdown-images'
import { chatModelSupportsVision } from '../../utils/llm/model-modalities'
import {
  PDF_INDEX_MAX_BYTES,
  PDF_INDEX_MAX_PAGES,
  extractPdfText,
} from '../../utils/pdf/extractPdfText'
import { renderPdfPagesToImages } from '../../utils/pdf/renderPdfPagesToImages'
import {
  findPathOutsideScope,
  isPathAllowedByScope,
} from '../agent/workspaceScope'
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
import { type SuperSearchResult, fuseRrfHybrid } from '../search/hybridSearch'
import { aggregateSearchResults } from '../search/searchResultAggregation'
import { getLiteSkillDocument } from '../skills/liteSkills'
import {
  WEB_SCRAPE_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  runWebScrape,
  runWebSearch,
} from '../web-search'

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
  | 'web_search'
  | 'web_scrape'
type FsSearchScope = 'files' | 'dirs' | 'content' | 'all'
type FsSearchMode = 'keyword' | 'rag' | 'hybrid'
type LegacyFsSearchItem =
  | { kind: 'file'; path: string }
  | { kind: 'dir'; path: string }
  | { kind: 'content_match'; path: string; line: number; snippet: string }
type FsListScope = 'files' | 'dirs' | 'all'
type FsReadModality = 'text' | 'image'
type FsReadOperation =
  | {
      type: 'full'
      modality: FsReadModality
    }
  | {
      type: 'lines'
      startLine: number
      endLine?: number
      maxLines: number
      modality: FsReadModality
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
      contentParts?: ContentPart[]
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
        'Search the vault. Prefer hybrid mode (keyword + RAG fused). Results grouped by file with snippets. For PDF hits, startLine/endLine are page numbers. Use keyword for exact terms; rag for semantic-only.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['keyword', 'rag', 'hybrid'],
            description:
              'Default: hybrid (keyword+RAG). keyword: exact match. rag: semantic only.',
          },
          scope: {
            type: 'string',
            enum: ['files', 'dirs', 'content', 'all'],
            description:
              'Keyword scope (default: all). rag/hybrid: content or all only.',
          },
          query: {
            type: 'string',
            description:
              'Search query. Optional for keyword files/dirs. Required for content/rag/hybrid.',
          },
          path: {
            type: 'string',
            description:
              "Optional vault-relative path to scope search. Folder (recursive) or single file. For a file, RAG is restricted to that file's chunks and keyword content scans only that file (markdown only for keyword content).",
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
        'Read vault files. Lines are 1-based. For PDFs, output is <page N> tags; lines mode uses page numbers. Prefer lines for targeted reads. PDFs default to text; switch modality to "image" only for a small page range that needs visual understanding (formulas, figures, scans, complex layout).',
      inputSchema: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: {
              type: 'string',
            },
            description: `Vault-relative file paths. Max ${MAX_BATCH_READ_FILES} items.`,
          },
          operation: {
            type: 'object',
            description:
              'Read strategy. full: whole file. lines: targeted range (PDFs use page numbers).',
            properties: {
              type: {
                type: 'string',
                enum: ['full', 'lines'],
              },
              startLine: {
                type: 'integer',
                description: `Start line/page (1-based). Defaults to ${DEFAULT_READ_START_LINE}.`,
              },
              maxLines: {
                type: 'integer',
                description: `Max lines when endLine unset. Defaults to ${DEFAULT_READ_MAX_LINES} for text files (range 1-${MAX_READ_MAX_LINES}). Ignored for PDFs — PDFs default to a single page (startLine) when endLine is unset.`,
              },
              endLine: {
                type: 'integer',
                description:
                  'Inclusive end line/page. If set, maxLines is ignored.',
              },
              modality: {
                type: 'string',
                enum: ['text', 'image'],
                description:
                  'Read modality (PDF only; ignored for non-PDF files). text (default): extract text per page, returned with <page N> tags — cheap, fast, works for full or multi-page reads. image: render the requested pages to images for the vision model — use only when text is insufficient (formulas, figures, scans, complex layout). Strongly avoid image with full or large page ranges: each page is a high-resolution image, transport may stall and token cost balloons. Recommended: image + lines + a small range (1-3 pages).',
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
            description: 'Optional short reason for pruning.',
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
            description: 'Optional short reason for compacting.',
          },
          instruction: {
            type: 'string',
            description: 'Optional focus hint for the summary.',
          },
        },
      },
    },
    {
      name: 'fs_edit',
      description:
        'Apply one or more text edit operations within a single existing file, atomically against one snapshot. Prefer this tool when modifying content in an existing file. Supports replace, replace_lines, insert_after, and append. To perform multiple edits on the same file, prefer bundling them via the "operations" array in a single fs_edit call rather than emitting multiple parallel fs_edit calls — bundled edits share one review, one write, and are applied against a single snapshot so earlier edits cannot invalidate later ones.',
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
              'Preferred for multiple edits to the same file: an array of text edit operations applied atomically against a single snapshot. Each item uses the same shape as "operation". If multiple replace_lines ops are present their line ranges must not overlap; they are automatically applied in descending order so earlier edits do not shift later line numbers.',
            minItems: 1,
            items: { type: 'object' },
          },
          operation: {
            type: 'object',
            description:
              'A single text edit operation to apply. Supports replace, replace_lines, insert_after, and append. For multiple edits to the same file, prefer the "operations" array instead.',
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
        required: ['path'],
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
    {
      name: WEB_SEARCH_TOOL_NAME,
      description:
        'Search the web for up-to-date or specific information using the configured search provider. ' +
        'Returns { answer?, items: [{ id, title, url, text }] }. ' +
        'When citing a fact taken from a result, append `[citation,domain](id)` immediately after the sentence; ' +
        'example: "The capital of France is Paris. [citation,example.com](abc123)".',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language search query.',
          },
          topic: {
            type: 'string',
            enum: ['general', 'news', 'finance'],
            description:
              'Optional topic hint. Some providers (e.g. Tavily) use this to bias results; others ignore it.',
          },
        },
        required: ['query'],
      },
    },
    {
      name: WEB_SCRAPE_TOOL_NAME,
      description:
        'Fetch the full content of a single web page (markdown when the provider supports it). ' +
        'Use this only when search snippets are insufficient. Returns { url, title?, content }.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Absolute http(s) URL to fetch.',
          },
        },
        required: ['url'],
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

/**
 * Scope for fs_search. `vault` = entire vault, `folder` = recursive subtree,
 * `file` = a single file (RAG restricts to that file's chunks; keyword content
 * scans only that file).
 */
type FsSearchScopeTarget =
  | { kind: 'vault'; normalizedPath: '' }
  | { kind: 'folder'; folder: TFolder; normalizedPath: string }
  | { kind: 'file'; file: TFile; normalizedPath: string }

const resolveSearchScopeByPath = (
  app: App,
  rawPath: string | undefined,
): FsSearchScopeTarget => {
  const trimmedPath = rawPath?.trim()
  if (!trimmedPath || trimmedPath === '/') {
    return { kind: 'vault', normalizedPath: '' }
  }

  const normalizedPath = validateVaultPath(trimmedPath)
  const abstractFile = app.vault.getAbstractFileByPath(normalizedPath)

  if (!abstractFile) {
    throw new Error(`Path not found: ${normalizedPath}`)
  }
  if (abstractFile instanceof TFolder) {
    return { kind: 'folder', folder: abstractFile, normalizedPath }
  }
  if (abstractFile instanceof TFile) {
    return { kind: 'file', file: abstractFile, normalizedPath }
  }
  throw new Error(`Unsupported path target: ${normalizedPath}`)
}

const isPathWithinFolder = (filePath: string, folderPath: string): boolean => {
  if (!folderPath) {
    return true
  }
  return filePath.startsWith(`${folderPath}/`)
}

/** Whether a vault file path falls inside the active search scope. */
const isPathInSearchScope = (
  filePath: string,
  scope: FsSearchScopeTarget,
): boolean => {
  if (scope.kind === 'vault') return true
  if (scope.kind === 'folder')
    return isPathWithinFolder(filePath, scope.normalizedPath)
  return filePath === scope.normalizedPath
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
  metadata: { startLine: number; endLine: number; page?: number }
  similarity: number
}

const mapRagRowsToSuper = (
  rows: RagEmbeddingRow[],
  source: 'rag',
): SuperSearchResult[] => {
  return rows.map((row) => {
    const page = row.metadata.page
    const locLine = page ?? row.metadata.startLine
    const locEnd = page ?? row.metadata.endLine
    return {
      kind: 'content' as const,
      path: row.path,
      line: locLine,
      startLine: locLine,
      endLine: locEnd,
      page,
      snippet: truncateRagSnippet(row.content),
      similarity: row.similarity,
      source,
    }
  })
}

const pathToRagScope = (
  scope: FsSearchScopeTarget,
): { files: string[]; folders: string[] } | undefined => {
  if (scope.kind === 'vault') return undefined
  if (scope.kind === 'folder')
    return { files: [], folders: [scope.normalizedPath] }
  return { files: [scope.normalizedPath], folders: [] }
}

const collectKeywordFsSearchResults = async ({
  app,
  scopeTarget,
  scope,
  query,
  maxResults,
  caseSensitive,
  signal,
}: {
  app: App
  scopeTarget: FsSearchScopeTarget
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
      .filter((file) => isPathInSearchScope(file.path, scopeTarget))
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
      .filter((folder) => isPathInSearchScope(folder.path, scopeTarget))
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
      .filter((file) => isPathInSearchScope(file.path, scopeTarget))
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
      .forEach(
        ({
          matchedTokenCount: _matchedTokenCount,
          firstMatchIndex: _firstMatchIndex,
          ...item
        }) => {
          void _matchedTokenCount
          void _firstMatchIndex
          results.push(item)
        },
      )
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

const coerceOperationObject = (operation: unknown): Record<string, unknown> => {
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
  const operationsValue = args.operations
  if (Array.isArray(operationsValue)) {
    if (operationsValue.length === 0) {
      throw new Error('operations array must contain at least one operation.')
    }
    const operations = operationsValue.map((entry) =>
      parseTextEditOperation(coerceOperationObject(entry)),
    )
    return { operations }
  }

  const operation = coerceOperationObject(args.operation)

  return {
    operations: [parseTextEditOperation(operation)],
  }
}

const getFsReadOperation = (args: Record<string, unknown>): FsReadOperation => {
  const parsedOperation = coerceOperationObject(args.operation)
  const type = asOptionalString(parsedOperation.type).trim().toLowerCase()

  // Strict modality parsing: only accept undefined/null (→ default text) or a
  // string that normalizes to 'text' / 'image'. Numbers, booleans, objects,
  // arrays all reject — silently coercing them would hide model bugs.
  const rawModalityValue = parsedOperation.modality
  let modality: FsReadModality = 'text'
  if (rawModalityValue !== undefined && rawModalityValue !== null) {
    if (typeof rawModalityValue !== 'string') {
      throw new Error('operation.modality must be a string: text or image.')
    }
    const normalized = rawModalityValue.trim().toLowerCase()
    if (normalized === '') {
      // Empty string is treated as "not provided" → default text.
    } else if (normalized === 'text' || normalized === 'image') {
      modality = normalized
    } else {
      throw new Error('operation.modality must be one of: text, image.')
    }
  }

  if (type === 'full') {
    return { type: 'full', modality }
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
      modality,
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
  chatModelId,
  workspaceScope,
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
  chatModelId?: string
  workspaceScope?: AssistantWorkspaceScope
}): Promise<LocalToolCallResult> {
  if (signal?.aborted) {
    return { status: ToolCallResponseStatus.Aborted }
  }

  try {
    // Final defense: reject any fs_* call whose path args (including batch
    // items[]) fall outside the agent's workspace scope. The gateway performs
    // the same check up front for UI Rejected status, but we re-validate here
    // so manual-approval / direct-call code paths cannot bypass the constraint.
    if (workspaceScope?.enabled) {
      const offendingPath = findPathOutsideScope(toolName, args, workspaceScope)
      if (offendingPath !== null) {
        throw new Error(
          `Path "${offendingPath}" is outside this agent's workspace scope.`,
        )
      }
    }

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

        const filteredEntries = workspaceScope?.enabled
          ? entries.filter((entry) =>
              isPathAllowedByScope(entry.path, workspaceScope),
            )
          : entries

        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'fs_list',
            path: scopeFolder.normalizedPath,
            scope,
            depth,
            entries: filteredEntries,
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
              returnedRange?: {
                startLine: number | null
                endLine: number | null
              }
              hasMoreBelow: boolean
              nextStartLine: number | null
              content: string
              wikilinks?: Array<{ link: string; path: string }>
            }
          | {
              path: string
              ok: false
              error: string
            }
        > = []

        const perFileImageParts: Array<{
          path: string
          parts: ContentPart[]
        }> = []

        // Skip image extraction when the active chat model does not accept
        // vision input; otherwise we'd ship base64 payloads to a text-only
        // endpoint and get a 400 back (issue #255). Migration 48→49 backfills
        // `modalities` on every ChatModel, so a missing array here means we
        // either have no active model or the lookup failed — treat as allow.
        const activeChatModel =
          chatModelId && settings?.chatModels
            ? (settings.chatModels.find((m) => m.id === chatModelId) ?? null)
            : null
        const chatModelAcceptsImages = activeChatModel
          ? chatModelSupportsVision(activeChatModel)
          : true

        for (const path of paths) {
          if (signal?.aborted) {
            return { status: ToolCallResponseStatus.Aborted }
          }

          const file = app.vault.getFileByPath(path)
          if (!file) {
            results.push({ path, ok: false, error: 'File not found.' })
            continue
          }

          const isPdf = file.extension?.toLowerCase() === 'pdf'
          if (isPdf) {
            if (file.stat.size > PDF_INDEX_MAX_BYTES) {
              results.push({
                path,
                ok: false,
                error: `PDF too large (${file.stat.size} bytes).`,
              })
              continue
            }

            // PDF-as-images branch: render pages to PNG only when the model
            // requested it (operation.modality === 'image'), the model accepts
            // vision input, and the master image-reading switch is on.
            const pdfImageMode =
              operation.modality === 'image' &&
              chatModelAcceptsImages &&
              (settings?.chatOptions?.imageReadingEnabled ?? true)

            if (pdfImageMode) {
              // Mirror text-mode semantics where it makes sense:
              //   - `full`  → render every page (matches "full = whole file").
              //   - `lines` without `endLine` → render only `startLine`. This
              //     gives the model a cheap peek that returns `totalPages`,
              //     so it can ask for a precise range on the next call
              //     instead of guessing.
              const reqStart =
                operation.type === 'lines' ? operation.startLine : 1
              const reqEnd =
                operation.type === 'lines'
                  ? (operation.endLine ?? operation.startLine)
                  : undefined

              let renderResult: Awaited<
                ReturnType<typeof renderPdfPagesToImages>
              >
              try {
                renderResult = await renderPdfPagesToImages(
                  app,
                  file,
                  reqStart,
                  reqEnd,
                  settings,
                )
              } catch (error) {
                results.push({
                  path,
                  ok: false,
                  error:
                    error instanceof Error
                      ? error.message
                      : 'Failed to render PDF pages as images.',
                })
                continue
              }

              const { totalPages, rendered } = renderResult
              const rangeStartPage = reqStart
              const rangeEndPageInclusive =
                reqEnd === undefined ? totalPages : Math.min(reqEnd, totalPages)
              const returnedCount = rendered.length
              const returnedStartLine =
                returnedCount > 0 ? rangeStartPage : null
              const returnedEndLine =
                returnedCount > 0 ? rangeEndPageInclusive : null
              const hasMoreBelow = rangeEndPageInclusive < totalPages
              const nextStartLine = hasMoreBelow
                ? rangeEndPageInclusive + 1
                : null

              results.push({
                path,
                ok: true,
                totalLines: totalPages,
                returnedRange: {
                  startLine: returnedStartLine,
                  endLine: returnedEndLine,
                },
                hasMoreBelow,
                nextStartLine,
                content: '',
              })

              if (rendered.length > 0) {
                perFileImageParts.push({
                  path,
                  parts: rendered.map((r) => ({
                    type: 'image_url' as const,
                    image_url: {
                      url: r.dataUrl,
                      cacheKey: buildPdfPageImageCacheKey(
                        file.path,
                        file.stat.mtime,
                        file.stat.size,
                        r.page,
                      ),
                    },
                  })),
                })
              }
              continue
            }

            let pages: { page: number; text: string }[] = []
            try {
              const extracted = await extractPdfText(app, file, {
                signal,
                maxBinaryBytes: PDF_INDEX_MAX_BYTES,
                maxPages: PDF_INDEX_MAX_PAGES,
                settings,
              })
              pages = extracted.pages
            } catch (error) {
              if (
                error instanceof DOMException &&
                error.name === 'AbortError'
              ) {
                return { status: ToolCallResponseStatus.Aborted }
              }
              results.push({
                path,
                ok: false,
                error:
                  error instanceof Error
                    ? error.message
                    : 'Failed to extract PDF text.',
              })
              continue
            }

            const totalPageCount = pages.length
            let rangeStartPage = 1
            let rangeEndPageInclusive = totalPageCount
            if (operation.type === 'lines') {
              rangeStartPage = operation.startLine
              // PDF defaults to a single page when endLine is omitted —
              // a PDF page carries far more content than a markdown line,
              // so the markdown-style `maxLines=50` default is too aggressive
              // here. The model can paginate explicitly when it wants more.
              rangeEndPageInclusive = Math.min(
                operation.endLine ?? rangeStartPage,
                totalPageCount,
              )
              if (rangeEndPageInclusive < rangeStartPage) {
                results.push({
                  path,
                  ok: false,
                  error:
                    'operation.endLine must be greater than or equal to operation.startLine.',
                })
                continue
              }
              if (
                rangeEndPageInclusive - rangeStartPage + 1 >
                MAX_READ_MAX_LINES
              ) {
                results.push({
                  path,
                  ok: false,
                  error: `Requested page range is too large. Maximum ${MAX_READ_MAX_LINES} pages per file.`,
                })
                continue
              }
            }

            const selectedPages = pages.filter(
              (p) =>
                p.page >= rangeStartPage && p.page <= rangeEndPageInclusive,
            )

            const taggedBody = selectedPages
              .map((p) => `<page ${p.page}>\n${p.text}\n</page ${p.page}>`)
              .join('\n')
            if (taggedBody.length > MAX_FILE_SIZE_BYTES) {
              results.push({
                path,
                ok: false,
                error: `Extracted PDF text too large (${taggedBody.length} chars). Max allowed is ${MAX_FILE_SIZE_BYTES}.`,
              })
              continue
            }

            // PDF 场景下 line 语义 = 页号。不做 `${index+1}|` 前缀，避免
            // 与 returnedRange（页号）语义错位，LLM 可直接依赖 <page N> 标签定位。
            const totalLines = totalPageCount
            const outputContent = taggedBody
            const returnedCount = selectedPages.length
            const returnedStartLine = returnedCount > 0 ? rangeStartPage : null
            const returnedEndLine =
              returnedCount > 0 ? rangeEndPageInclusive : null
            const hasMoreBelow =
              operation.type === 'lines' &&
              rangeEndPageInclusive < totalPageCount
            const nextStartLine = hasMoreBelow
              ? rangeEndPageInclusive + 1
              : null

            // When the model requested image modality but vision is not
            // supported, signal the silent fallback so the model can observe it.
            const visionDowngraded =
              operation.modality === 'image' && !chatModelAcceptsImages

            results.push({
              path,
              ok: true,
              totalLines,
              returnedRange:
                operation.type === 'lines'
                  ? {
                      startLine: returnedStartLine,
                      endLine: returnedEndLine,
                    }
                  : undefined,
              hasMoreBelow,
              nextStartLine,
              content: outputContent,
              ...(visionDowngraded
                ? {
                    effectiveModality: 'text' as const,
                    warning: '当前模型不支持图像输入，已自动降级为文本读取',
                  }
                : {}),
            })
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

          const rawContent = await app.vault.read(file)
          const content = rawContent
          const lines = content.length === 0 ? [] : content.split('\n')
          const totalLines = lines.length

          let outputContent = ''
          let rawSelected = ''
          let returnedStartLine: number | null = null
          let returnedEndLine: number | null = null
          let returnedCount = 0
          let hasMoreBelow = false
          let nextStartLine: number | null = null

          if (operation.type === 'full') {
            outputContent = lines
              .map((line, index) => `${index + 1}|${line}`)
              .join('\n')
            rawSelected = content
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
            rawSelected = selectedLines.join('\n')
            returnedCount = selectedLines.length
            returnedStartLine = returnedCount > 0 ? startIndex + 1 : null
            returnedEndLine =
              returnedCount > 0 ? startIndex + returnedCount : null
            hasMoreBelow = endExclusive < totalLines
            nextStartLine = hasMoreBelow ? endExclusive + 1 : null
          }

          const wikilinks =
            path.endsWith('.md') && rawSelected.length > 0
              ? collectWikilinkPaths(app, rawSelected, path)
              : []

          results.push({
            path,
            ok: true,
            totalLines,
            returnedRange:
              operation.type === 'lines'
                ? {
                    startLine: returnedStartLine,
                    endLine: returnedEndLine,
                  }
                : undefined,
            hasMoreBelow,
            nextStartLine,
            content: outputContent,
            ...(wikilinks.length > 0 ? { wikilinks } : {}),
          })

          // Extract images from markdown files using the outputContent
          // (which is the line-numbered text that was actually returned)
          if (
            chatModelAcceptsImages &&
            (settings?.chatOptions?.imageReadingEnabled ?? true) &&
            path.endsWith('.md') &&
            outputContent.length > 0
          ) {
            const imageResult = await extractMarkdownImages(
              app,
              outputContent,
              path,
              {
                compression: {
                  enabled:
                    settings?.chatOptions?.imageCompressionEnabled ?? true,
                  quality: settings?.chatOptions?.imageCompressionQuality ?? 85,
                },
                cache: { enabled: true, settings },
                externalUrl: {
                  enabled:
                    settings?.chatOptions?.externalImageFetchEnabled ?? false,
                },
              },
            )
            if (imageResult.contentParts) {
              perFileImageParts.push({ path, parts: imageResult.contentParts })
            }
          }
        }

        const textResult = formatJsonResult({
          toolCallId: toolCallId ?? null,
          // Echo the requested modality so the model can compare it against
          // each result's `effectiveModality` (only set when we forcibly
          // downgrade image→text because the model lacks vision capability).
          requestedOperation: {
            type: operation.type,
            modality: operation.modality,
          },
          results,
        })

        // contentParts only carries image payloads — the request builder
        // filters to image_url parts and ignores any text entries here, so we
        // skip building per-file text headers that would just be discarded.
        // The text JSON (above) is the source of truth for paths/ranges.
        const contentParts: ContentPart[] | undefined =
          perFileImageParts.length > 0
            ? perFileImageParts.flatMap((p) => p.parts)
            : undefined

        return {
          status: ToolCallResponseStatus.Success,
          text: textResult,
          contentParts,
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
        const scopeTarget = resolveSearchScopeByPath(
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

        const applyWorkspaceScopeFilter = <T extends { path: string }>(
          rows: T[],
        ): T[] =>
          workspaceScope?.enabled
            ? rows.filter((row) =>
                isPathAllowedByScope(row.path, workspaceScope),
              )
            : rows

        if (effectiveMode === 'keyword') {
          const scope = getOptionalFsSearchScope(args, 'all')
          const legacy = await collectKeywordFsSearchResults({
            app,
            scopeTarget,
            scope,
            query,
            maxResults,
            caseSensitive,
            signal,
          })
          if (signal?.aborted) {
            return { status: ToolCallResponseStatus.Aborted }
          }
          const results = applyWorkspaceScopeFilter(
            legacyFsSearchItemsToSuper(legacy, 'keyword'),
          )
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
              path: scopeTarget.normalizedPath,
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
        const ragScope = pathToRagScope(scopeTarget)

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

        const ragMapped = applyWorkspaceScopeFilter(
          mapRagRowsToSuper(ragRows as RagEmbeddingRow[], 'rag'),
        )

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
              path: scopeTarget.normalizedPath,
              results: aggregateSearchResults({ results, maxResults }),
            }),
          }
        }

        const keywordLegacy = await collectKeywordFsSearchResults({
          app,
          scopeTarget,
          scope: 'content',
          query,
          maxResults,
          caseSensitive,
          signal,
        })
        if (signal?.aborted) {
          return { status: ToolCallResponseStatus.Aborted }
        }
        const keywordSuper = applyWorkspaceScopeFilter(
          legacyFsSearchItemsToSuper(keywordLegacy, 'keyword'),
        )
        const pathLegacyFiles = await collectKeywordFsSearchResults({
          app,
          scopeTarget,
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
          scopeTarget,
          scope: 'dirs',
          query,
          maxResults,
          caseSensitive,
          signal,
        })
        if (signal?.aborted) {
          return { status: ToolCallResponseStatus.Aborted }
        }
        const pathSuper = applyWorkspaceScopeFilter(
          legacyFsSearchItemsToSuper(
            [...pathLegacyFiles, ...pathLegacyDirs],
            'keyword',
          ),
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
            path: scopeTarget.normalizedPath,
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

      case 'web_search': {
        if (!settings) {
          throw new Error('Web search is unavailable: settings not loaded.')
        }
        const query = getTextArg(args, 'query').trim()
        if (!query) {
          throw new Error('query cannot be empty.')
        }
        const topic = getOptionalTextArg(args, 'topic')?.trim() || undefined
        const result = await runWebSearch({
          settings: settings.webSearch,
          query,
          topic,
          signal,
        })
        const itemsWithIndex = result.items.map((it, idx) => ({
          id: it.id,
          index: idx + 1,
          title: it.title,
          url: it.url,
          text: it.text,
        }))
        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'web_search',
            provider: result.providerName,
            answer: result.answer,
            items: itemsWithIndex,
          }),
        }
      }

      case 'web_scrape': {
        if (!settings) {
          throw new Error('Web scrape is unavailable: settings not loaded.')
        }
        const url = getTextArg(args, 'url').trim()
        if (!url) {
          throw new Error('url cannot be empty.')
        }
        const result = await runWebScrape({
          settings: settings.webSearch,
          url,
          signal,
        })
        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'web_scrape',
            provider: result.providerName,
            url: result.url,
            title: result.title,
            content: result.content,
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
