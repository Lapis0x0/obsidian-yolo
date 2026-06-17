import {
  App,
  FileSystemAdapter,
  Platform,
  type TAbstractFile,
  TFile,
  TFolder,
  normalizePath,
  requestUrl,
} from 'obsidian'

import { upsertEditReviewSnapshot } from '../../database/json/chat/editReviewSnapshotStore'
import { buildPdfPageImageCacheKey } from '../../database/json/chat/imageCacheStore'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type { ApplyViewState } from '../../types/apply-view.types'
import type { AssistantWorkspaceScope } from '../../types/assistant.types'
import type { ChatMessage } from '../../types/chat'
import type { ChatModelModality } from '../../types/chat-model.types'
import type { ContentPart } from '../../types/llm/request'
import { McpTool } from '../../types/mcp.types'
import {
  ToolCallResponseStatus,
  type ToolEditSummary,
} from '../../types/tool-call.types'
import { uint8ArrayToBase64 } from '../../utils/base64'
import {
  createToolEditSummary,
  deriveToolEditUndoStatus,
} from '../../utils/chat/editSummary'
import { editUndoSnapshotStore } from '../../utils/chat/editUndoSnapshotStore'
import { isContextPrunableToolName } from '../../utils/chat/tool-context-pruning'
import { collectWikilinkPaths } from '../../utils/llm/annotate-wikilinks'
import { extractMarkdownImages } from '../../utils/llm/extract-markdown-images'
import {
  chatModelSupportsPdf,
  chatModelSupportsVision,
} from '../../utils/llm/model-modalities'
import {
  PDF_INDEX_MAX_BYTES,
  PDF_INDEX_MAX_PAGES,
  extractPdfText,
} from '../../utils/pdf/extractPdfText'
import { renderPdfPagesToImages } from '../../utils/pdf/renderPdfPagesToImages'
import { PdfSliceError, slicePdfPages } from '../../utils/pdf/slicePdfPages'
import type { PromptSourceWatcher } from '../agent/promptSourceWatcher'
import { resolveSubagentModelConfig } from '../agent/subagent/model-config'
import type { SubagentParentContext } from '../agent/subagent/parent-context'
import type { TodoItem } from '../agent/todos-from-messages'
import type { AgentRunContext } from '../agent/types'
import {
  BROWSER_READ_PATH_PREFIX,
  BUILTIN_SKILL_PATH_PREFIX,
  buildAllowedSkillPathSet,
  findPathOutsideScope,
  isPathAllowedByScope,
  normalizeSkillPathForExemption,
} from '../agent/workspaceScope'
import {
  BROWSER_PAGE_ID_PATTERN,
  findWebviewHandleByPageId,
} from '../browser/activeWebviewProbe'
import {
  BrowserReadFailure,
  type BrowserReadFormat,
  readActiveWebviewPage,
} from '../browser/activeWebviewReader'
import {
  type TextEditOperation,
  type TextEditPlan,
  buildReplaceMatchErrorHint,
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
import {
  type SuperSearchResult,
  fuseRrfHybrid,
  superSearchDedupKey,
} from '../search/hybridSearch'
import {
  type AggregatedSearchResult,
  aggregateSearchResults,
} from '../search/searchResultAggregation'
import { getLiteSkillDocumentByPath } from '../skills/liteSkills'
import {
  WEB_SCRAPE_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  runWebScrape,
  runWebSearch,
} from '../web-search'

import {
  type JsSandboxSettings,
  getJsSandboxSettings,
} from './jsSandboxSettings'
import {
  JS_SANDBOX_DB_QUERY_DEFAULT_MAX_LIMIT,
  JS_SANDBOX_DB_QUERY_DEFAULT_REQUEST_LIMIT,
  JS_SANDBOX_DB_QUERY_HARD_MAX_LIMIT,
  JS_SANDBOX_FETCH_DEFAULT_MAX_CONCURRENT,
  JS_SANDBOX_FETCH_DEFAULT_MAX_RESPONSE_KB,
  JS_SANDBOX_FETCH_HARD_MAX_CONCURRENT,
  JS_SANDBOX_FETCH_HARD_MAX_RESPONSE_KB,
  JS_SANDBOX_FETCH_MIN_CONCURRENT,
  JS_SANDBOX_FETCH_MIN_RESPONSE_KB,
  JS_SANDBOX_TOOL_NAME,
  JS_SANDBOX_VAULT_LIST_MAX_ENTRIES,
  JS_SANDBOX_VAULT_READ_DEFAULT_MAX_KB,
  JS_SANDBOX_VAULT_READ_HARD_MAX_KB,
  JS_SANDBOX_VAULT_READ_MIN_KB,
  type JsSandboxProxyHandlers,
  type JsSandboxVaultListEntry,
  callJsSandboxTool,
  getJsSandboxTool,
} from './jsSandboxTool'
import { parseToolName } from './tool-name-utils'

export { recoverLikelyEscapedBackslashSequences }

const LOCAL_FILE_TOOL_SERVER = 'yolo_local'
export const TERMINAL_COMMAND_TOOL_NAME = 'terminal_command'
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024
// fs_edit 读全文做替换的绝对内存防御上限。MAX_FILE_SIZE_BYTES 是"快照阈值"
// （超过则跳过 undo/review 快照），本常量是"绝对拒绝上限"（超过才真正拒绝编辑）。
const MAX_EDIT_FILE_SIZE_BYTES = 16 * 1024 * 1024
const MAX_BATCH_READ_FILES = 20
const DEFAULT_READ_START_LINE = 1
const DEFAULT_READ_MAX_LINES = 50
const MAX_READ_MAX_LINES = 2000
const MAX_READ_LINE_INDEX = 1_000_000
const MAX_RAG_SNIPPET_CHARS = 500
const RAG_FETCH_LIMIT_MAX = 300
const BROWSER_READ_PATH_USAGE =
  'browser:// paths only read open Obsidian web pages by page_id copied exactly from <browser_context> (browser://page_<8 lowercase base36>_<8 lowercase base36>). Do not append URL paths to a page_id and do not use browser:// to open or fetch internet URLs. For internet access, use web_search or web_scrape when available; if those tools are unavailable, tell the user.'

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

export const LOCAL_FILE_TOOL_SHORT_NAMES = [
  'fs_list',
  'fs_search',
  'fs_read',
  'context_prune_tool_results',
  'context_compact',
  'fs_edit',
  'fs_write',
  'fs_delete',
  'fs_create_dir',
  'fs_move',
  'memory_add',
  'memory_update',
  'memory_delete',
  'web_search',
  'web_scrape',
  JS_SANDBOX_TOOL_NAME,
  TERMINAL_COMMAND_TOOL_NAME,
  'delegate_subagent',
  'load_tool_schemas',
  'todo_write',
  'ask_user_question',
] as const

/**
 * Subset of {@link LOCAL_FILE_TOOL_SHORT_NAMES} that the user actually
 * configures via the Agent settings panel. `load_tool_schemas` is a protocol
 * tool — it exists for the on-demand disclosure mechanism, not as a user-
 * facing capability — so it is excluded here. The runtime still dispatches and
 * normalizes it through `LOCAL_FILE_TOOL_SHORT_NAMES`; it just isn't part of
 * the per-agent tool preference surface.
 */
export const USER_FACING_LOCAL_TOOL_SHORT_NAMES: readonly string[] =
  LOCAL_FILE_TOOL_SHORT_NAMES.filter((name) => name !== 'load_tool_schemas')
type LocalFileToolName = (typeof LOCAL_FILE_TOOL_SHORT_NAMES)[number]
type FsSearchScope = 'files' | 'dirs' | 'content' | 'all'
type FsSearchMode = 'keyword' | 'rag' | 'hybrid'
type LegacyFsSearchItem =
  | { kind: 'file'; path: string }
  | { kind: 'dir'; path: string }
  | { kind: 'content_match'; path: string; line: number; snippet: string }
type FsListScope = 'files' | 'dirs' | 'all'
// PDF read modality override. Omitted = default behavior (native PDF when the
// chat model supports it, otherwise text). Concrete values are presented to
// the model via a per-capability schema (see buildFsReadModalitySchema):
//   - PDF-capable models: ['text', 'pdf']
//   - vision-capable (non-PDF): ['text', 'image']
//   - text-only: field is omitted from the schema entirely
// The parser still accepts the full superset for resilience (see notes there).
type FsReadModality = 'text' | 'image' | 'pdf'
type FsReadOperation =
  | {
      type: 'full'
      modality?: FsReadModality
      format?: BrowserReadFormat
    }
  | {
      type: 'lines'
      startLine: number
      endLine?: number
      maxLines: number
      modality?: FsReadModality
      format?: BrowserReadFormat
    }
type ContextPruneMode = 'selected' | 'all'
type FsFileOpAction = 'write' | 'delete' | 'create_dir' | 'move'

type LocalToolCallResultMetadata = {
  editSummary?: ToolEditSummary
  appliedAt?: number
  truncated?: { totalBytes: number; omittedBytes: number }
}

type LocalToolCallResult =
  | {
      status: ToolCallResponseStatus.Success
      text: string
      contentParts?: ContentPart[]
      metadata?: LocalToolCallResultMetadata
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
      /** 中断时已采集的部分输出（可选） */
      data?: {
        type: 'text'
        text: string
        metadata?: {
          truncated?: { totalBytes: number; omittedBytes: number }
        }
      }
    }

type FsResultItem = {
  ok: boolean
  action: FsFileOpAction
  target: string
  message: string
  /** For fs_delete: whether the deleted target was a file or a folder. */
  targetKind?: 'file' | 'folder'
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
  fs_write: 'write',
  fs_delete: 'delete',
  fs_create_dir: 'create_dir',
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

const normalizeFsReadPath = (path: string): string => {
  const trimmed = path.trim()
  if (trimmed.length === 0) {
    throw new Error('Path is required.')
  }
  if (trimmed.startsWith(BUILTIN_SKILL_PATH_PREFIX)) {
    return trimmed
  }
  if (trimmed.startsWith(BROWSER_READ_PATH_PREFIX)) {
    parseBrowserReadPageId(trimmed)
    return trimmed
  }
  return validateVaultPath(trimmed)
}

export const isBrowserReadPath = (path: string): boolean =>
  path.trim().startsWith(BROWSER_READ_PATH_PREFIX)

export const parseBrowserReadPageId = (path: string): string => {
  const trimmed = path.trim()
  if (!trimmed.startsWith(BROWSER_READ_PATH_PREFIX)) {
    throw new Error('Not a browser read path.')
  }
  const pageId = trimmed.slice(BROWSER_READ_PATH_PREFIX.length).trim()
  if (!BROWSER_PAGE_ID_PATTERN.test(pageId)) {
    throw new Error(BROWSER_READ_PATH_USAGE)
  }
  return pageId
}

type FsReadLineSliceResult = {
  outputContent: string
  rawSelected: string
  totalLines: number
  returnedStartLine: number | null
  returnedEndLine: number | null
  hasMoreBelow: boolean
  nextStartLine: number | null
}

const sliceLinesForFsReadOperation = (
  lines: string[],
  operation: FsReadOperation,
): FsReadLineSliceResult => {
  const totalLines = lines.length
  if (operation.type === 'full') {
    const outputContent = lines
      .map((line, index) => `${index + 1}|${line}`)
      .join('\n')
    return {
      outputContent,
      rawSelected: lines.join('\n'),
      totalLines,
      returnedStartLine: totalLines > 0 ? 1 : null,
      returnedEndLine: totalLines > 0 ? totalLines : null,
      hasMoreBelow: false,
      nextStartLine: null,
    }
  }

  const startIndex = Math.min(Math.max(operation.startLine - 1, 0), totalLines)
  const endExclusive = Math.min(
    totalLines,
    operation.endLine ?? startIndex + operation.maxLines,
  )
  const selectedLines = lines.slice(startIndex, endExclusive)
  const outputContent = selectedLines
    .map((line, index) => `${startIndex + index + 1}|${line}`)
    .join('\n')
  const returnedCount = selectedLines.length
  const hasMoreBelow = endExclusive < totalLines
  return {
    outputContent,
    rawSelected: selectedLines.join('\n'),
    totalLines,
    returnedStartLine: returnedCount > 0 ? startIndex + 1 : null,
    returnedEndLine: returnedCount > 0 ? startIndex + returnedCount : null,
    hasMoreBelow,
    nextStartLine: hasMoreBelow ? endExclusive + 1 : null,
  }
}

export function getLocalFileToolServerName(): string {
  return LOCAL_FILE_TOOL_SERVER
}

export const LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME = 'load_tool_schemas'

/**
 * Build the modality enum + description fragment exposed to the current chat
 * model in fs_read's schema.
 *
 *   - PDF-capable model      → ['text', 'pdf']
 *   - vision (non-PDF) model → ['text', 'image']
 *   - text-only model        → undefined (field is omitted from schema)
 *   - no model context       → ['text', 'image', 'pdf'] (superset; used by UI
 *                              listings and permission persistence — the LLM
 *                              never sees this branch because every runtime
 *                              call site threads the active model through)
 *
 * Image and pdf are mutually exclusive by product definition: image is only a
 * workaround for models lacking native PDF input, and pdf is meaningless on
 * models that can't accept it. Tailoring the enum per model collapses the
 * "model picks a value that has to be silently corrected" failure mode into
 * "the wrong value isn't representable to begin with."
 */
const buildFsReadModalitySchema = (
  modalities: ChatModelModality[] | undefined,
): { type: 'string'; enum: string[]; description: string } | undefined => {
  const isPdfCapable = modalities?.includes('pdf')
  const isVisionCapable = modalities?.includes('vision')

  if (!modalities) {
    // Superset (UI / permission listing). Not seen by any live LLM call.
    return {
      type: 'string',
      enum: ['text', 'image', 'pdf'],
      description:
        'PDF-only modality override. Omit for the default per active model. text = plain text extraction. image = render pages as images (only available on vision-capable, non-PDF-capable models). pdf = native PDF input (only available on PDF-capable models). Ignored for non-PDF files.',
    }
  }

  if (isPdfCapable) {
    return {
      type: 'string',
      enum: ['text', 'pdf'],
      description:
        'PDF-only modality override. Omit for default (= "pdf"). "text" = plain text extraction (cheap and fast; pick this only when the user explicitly asks for text-only). "pdf" = native PDF input (highest fidelity). Ignored for non-PDF files.',
    }
  }

  if (isVisionCapable) {
    return {
      type: 'string',
      enum: ['text', 'image'],
      description:
        'PDF-only modality override. Omit for default (= "text"). "text" = plain text extraction. "image" = render the requested pages as images — opt in ONLY when text is insufficient (formulas, figures, scans, complex layout); avoid for large page ranges. Ignored for non-PDF files.',
    }
  }

  // Text-only model: no override is meaningful. Field is omitted from schema
  // entirely so the model has no decision to make.
  return undefined
}

/**
 * Standalone tool definition for `load_tool_schemas`. Used by the runtime to
 * inject the loader on demand (when `enableToolDisclosure=true` AND the
 * filtered tool set contains any `on_demand` tool). Not surfaced through
 * `getLocalFileTools()` to keep it out of the user-facing tool list.
 */
export function getLoadToolSchemasTool(): McpTool {
  return {
    name: LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME,
    description:
      'Load full schemas for all on-demand tools belonging to the given MCP servers, making them callable in the next turn. Pass MCP server names (the prefix before "__" in any stub tool name) — batch multiple servers when needed.',
    inputSchema: {
      type: 'object',
      properties: {
        servers: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description:
            'MCP server names whose on-demand tools should be loaded (e.g. "context7", "deepwiki").',
        },
      },
      required: ['servers'],
    },
  }
}

export function getLocalFileTools(options?: {
  vaultBasePath?: string
  chatModelModalities?: ChatModelModality[]
}): McpTool[] {
  const modalitySchema = buildFsReadModalitySchema(options?.chatModelModalities)
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
        'Search the vault. Prefer hybrid mode (keyword + RAG fused). Results grouped by file with snippets. For PDF hits, startLine/endLine are page numbers. Use keyword for exact terms; rag for semantic-only. ' +
        'Each returned snippet carries a `cite: N` field. When you write the answer using content from this tool, annotate each citing point with a markdown link `[N](yolo-cite:N?yolo-cite=N)` where N is the `cite` number of the snippet you relied on. The same `N` may be reused as often as needed; multiple `[1](...)[2](...)` may appear back-to-back. Do not emit `yolo-cite:` links unless they correspond to a `cite` number from this tool.',
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
        'Read vault files, skill instructions, or open Obsidian web pages. Lines are 1-based. For PDFs, output is <page N> tags; lines mode uses page numbers. Prefer lines for targeted reads. Skill paths from <available_skills> may use builtin:// prefixes. Open web pages use browser://<page_id> copied exactly from <browser_context>. browser:// does not open URLs or fetch internet content; use web_search or web_scrape when available, and tell the user if those tools are unavailable. Do not call browser:// paths when <browser_context> is absent.',
      inputSchema: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: {
              type: 'string',
            },
            description: `Vault-relative file paths, skill paths (builtin://), or browser://<page_id> copied exactly from <browser_context>. Max ${MAX_BATCH_READ_FILES} items. Do not pass browser://https://... or browser://domain/path.`,
          },
          operation: {
            type: 'object',
            description:
              'Read strategy. Omit for full. full: whole file/page. lines: targeted range (PDFs use page numbers). format applies only to browser:// paths.',
            properties: {
              type: {
                type: 'string',
                enum: ['full', 'lines'],
              },
              startLine: {
                type: 'integer',
                description: `Start line/page (1-based). Defaults to ${DEFAULT_READ_START_LINE}.`,
              },
              endLine: {
                type: 'integer',
                description:
                  'Inclusive end line/page. If set, maxLines is ignored.',
              },
              maxLines: {
                type: 'integer',
                description:
                  'Max lines/pages in the range when endLine is unset.',
              },
              format: {
                type: 'string',
                enum: ['readable', 'key_visible_info'],
                description:
                  'Browser pages only. key_visible_info (default): compact visible headings, text blocks, tables, code, and formulas — prefer for long pages. readable: fuller Markdown-like text.',
              },
              ...(modalitySchema ? { modality: modalitySchema } : {}),
            },
            required: ['type'],
          },
        },
        required: ['paths'],
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
        'Apply a single targeted text edit within an existing file. Prefer this tool when modifying content in an existing file. Two ways to locate the edit, choose exactly one: for an exact-text edit, provide oldText (the text to find, which must match the file exactly once) and newText; for a line-range edit, provide startLine and endLine (1-based inclusive) and newText. Do not provide both oldText and startLine/endLine. To make several edits in the same file, emit multiple fs_edit calls — the system automatically merges edits targeting the same file into one atomic review and write, so earlier edits cannot invalidate later ones.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Vault-relative file path.',
          },
          oldText: {
            type: 'string',
            description:
              'Exact-text mode: the existing text to find and replace. Must match the file exactly once. Do not combine with startLine/endLine.',
          },
          newText: {
            type: 'string',
            description: 'Replacement text. Required in both modes.',
          },
          startLine: {
            type: 'integer',
            description:
              'Line-range mode: 1-based inclusive start line. Provide together with endLine; do not combine with oldText.',
          },
          endLine: {
            type: 'integer',
            description:
              'Line-range mode: 1-based inclusive end line. Provide together with startLine; do not combine with oldText.',
          },
        },
        required: ['path', 'newText'],
      },
    },
    {
      name: 'fs_write',
      description:
        'Create a file, or overwrite an existing file with new full content. Missing parent folders are created automatically. Use fs_edit instead when you only need to change part of an existing file.',
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
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'fs_delete',
      description:
        'Delete a file or folder in the vault. The target kind is detected automatically. For a non-empty folder set recursive=true. Deleted items go to the trash; folder deletions cannot be undone from the chat (recover them via the system/Obsidian trash).',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Vault-relative file or folder path.',
          },
          recursive: {
            type: 'boolean',
            description:
              'Folders only. Default false; when false a non-empty folder cannot be deleted. Ignored for files.',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'fs_create_dir',
      description:
        'Create an empty folder in the vault. Missing parent folders are created automatically.',
      inputSchema: {
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
    {
      name: 'fs_move',
      description: 'Move or rename a file/folder path in the vault.',
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
        },
        required: ['oldPath', 'newPath'],
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
    getJsSandboxTool(),
    {
      name: TERMINAL_COMMAND_TOOL_NAME,
      description:
        'Run a command in the local OS shell. Desktop-only. ' +
        'Uses PowerShell on Windows and a POSIX shell on macOS/Linux. ' +
        'Use for terminal-style inspection or local CLI commands. ' +
        'By default, command runs as a one-shot process and completes when that process exits; ' +
        'it does not keep shell state between calls. ' +
        'Use background=true to create a persistent session for long-running or interactive commands; ' +
        'session_id polls or continues an existing ' +
        'session; input sends stdin to that session; kill=true terminates it. ' +
        'Results separate stdout and stderr. ' +
        'Use tail_lines or tail_bytes when polling verbose sessions to inspect recent logs only. ' +
        'Avoid heredocs and full-screen TUI programs such as vim/top. Long-running ' +
        'commands should use background=true; completion is pushed when finished. ' +
        'Avoid frequent polling to check status. ' +
        'The tool result is returned to you, but it does not automatically become a user-facing answer; to show the user the result, send a concise text summary of the relevant output.',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              'Shell command to run. Omit when polling, sending input, or killing an existing session.',
          },
          session_id: {
            type: 'integer',
            description:
              'Existing session id returned by a previous terminal_command call. Use it to poll, send input, or kill.',
          },
          input: {
            type: 'string',
            description:
              'Text to write to the session stdin. Include a trailing newline when submitting interactive input.',
          },
          background: {
            type: 'boolean',
            description:
              'Start the command in a dedicated session and return a session_id if it is still running after a short wait.',
          },
          cwd: {
            type: 'string',
            description:
              'Absolute working directory for this command. Defaults to the current vault root when available.',
          },
          timeout: {
            type: 'integer',
            description:
              'Maximum seconds to wait for foreground output before returning a live session_id. Defaults to 30.',
          },
          tail_lines: {
            type: 'integer',
            description:
              'Return only the last N lines from stdout and stderr. Useful when polling verbose long-running sessions.',
          },
          tail_bytes: {
            type: 'integer',
            description:
              'Return only the last N bytes from stdout and stderr. Cannot be combined with tail_lines.',
          },
          kill: {
            type: 'boolean',
            description: 'Terminate the given session_id.',
          },
        },
      },
    },
    {
      name: 'delegate_subagent',
      description:
        'Dispatch an isolated temporary sub-agent to work on a self-contained task asynchronously. ' +
        'The sub-agent does not see the parent conversation; the prompt must include all necessary context. ' +
        'Returns immediately with a taskId while the child runs in the background. ' +
        'When complete, a follow-up background message starting with ' +
        '[subagent_result taskId=...] will arrive for you to summarize or continue. ' +
        'The child inherits your current model and allowed tools (except recursive delegation and user-interaction tools). ' +
        'The tool result is returned to you, but it does not automatically become a user-facing answer; to show the user the result, send a concise text summary of the relevant output.',
      inputSchema: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description:
              'Short title for this dispatch (shown in the UI and tool summary).',
          },
          prompt: {
            type: 'string',
            description:
              'Complete task instructions for the temporary sub-agent.',
          },
        },
        required: ['description', 'prompt'],
      },
    },
    {
      name: 'ask_user_question',
      description:
        'Ask the user one or more structured questions when you are blocked by missing information that cannot be inferred from context or the vault. Group related questions in a single call instead of asking turn by turn. Use sparingly — never to confirm trivial actions. Prefer concrete options (single_select / multi_select) over free text for the main questions. The UI automatically appends an "Other" escape hatch to every single_select / multi_select (with a free-text input that lands in the answer as `otherText`), so you do NOT need to add your own "Other" / "其他" option. The trailing free_text catch-all is also useful when an open-ended answer is plausible (e.g. "Anything else to add? (optional)") — note that free_text answers are treated as optional and may come back empty. This call MUST be the only tool call in the turn; the agent run pauses until the user submits answers in a dedicated panel.',
      inputSchema: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            minItems: 1,
            description:
              'One or more structured questions to ask the user. Group related questions together rather than splitting them across turns.',
            items: {
              type: 'object',
              required: ['id', 'prompt', 'inputType'],
              properties: {
                id: {
                  type: 'string',
                  description:
                    'Stable id used to key the answer back. Must be unique across the questions array.',
                },
                prompt: {
                  type: 'string',
                  description: 'The question text shown to the user.',
                },
                inputType: {
                  type: 'string',
                  enum: ['free_text', 'single_select', 'multi_select'],
                  description:
                    'free_text: open answer. single_select: pick exactly one option. multi_select: pick one or more options.',
                },
                options: {
                  type: 'array',
                  minItems: 2,
                  description:
                    'Required for single_select / multi_select. Each option has a stable id and a human-readable label. Disallowed for free_text. The id "__other__" is reserved — the UI appends its own "Other" entry, so do not include one yourself.',
                  items: {
                    type: 'object',
                    required: ['id', 'label'],
                    properties: {
                      id: { type: 'string' },
                      label: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
        required: ['questions'],
      },
    },
    {
      name: 'todo_write',
      description:
        'Update the todo list for the current agent run. Use proactively for multi-step tasks (≥3 steps) or when the user has multiple requests. Each call replaces the entire list; pass `[]` to clear. Keep at most one item in_progress (and exactly one while work is ongoing). Mark items completed immediately as you finish them.',
      inputSchema: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description:
              'Complete replacement list of todo items. Pass [] to clear all todos.',
            items: {
              type: 'object',
              properties: {
                content: {
                  type: 'string',
                  description:
                    'The work to do, as an action phrase. Examples: "Run tests", "Refactor the parser".',
                },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed'],
                  description: 'Current status of the task.',
                },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
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

type CollectedVaultListEntry =
  | {
      kind: 'file'
      node: TFile
      path: string
    }
  | {
      kind: 'dir'
      node: TFolder
      path: string
    }

const getAbstractFileName = (file: TAbstractFile): string => {
  if (file.name) {
    return file.name
  }
  return file.path.split('/').pop() ?? file.path
}

// Breadth-first walk collecting child dirs and files. Output order is not
// significant here: the only caller re-sorts by path, and exceeding maxResults
// is a hard error (the partial collection is discarded), so no intermediate
// sort is needed.
const collectVaultChildEntries = ({
  folder,
  depth,
  maxResults,
}: {
  folder: TFolder
  depth: number
  maxResults: number
}): CollectedVaultListEntry[] => {
  const entries: CollectedVaultListEntry[] = []
  const queue: Array<{ folder: TFolder; level: number }> = [
    { folder, level: 1 },
  ]
  let queueIndex = 0

  while (queueIndex < queue.length && entries.length < maxResults) {
    const current = queue[queueIndex]
    queueIndex++
    const { folder: currentFolder, level } = current

    for (const child of currentFolder.children) {
      if (entries.length >= maxResults) break

      if (child instanceof TFolder) {
        entries.push({ kind: 'dir', node: child, path: child.path })
        if (level < depth) {
          queue.push({ folder: child, level: level + 1 })
        }
        continue
      }

      if (child instanceof TFile) {
        entries.push({ kind: 'file', node: child, path: child.path })
      }
    }
  }

  return entries
}

const toJsSandboxVaultListEntry = (
  entry: CollectedVaultListEntry,
): JsSandboxVaultListEntry => {
  if (entry.kind === 'dir') {
    return {
      kind: 'dir',
      path: entry.path,
      name: getAbstractFileName(entry.node),
    }
  }

  const stat = entry.node.stat as
    | {
        size?: number
        mtime?: number
      }
    | undefined
  return {
    kind: 'file',
    path: entry.path,
    name: getAbstractFileName(entry.node),
    size: typeof stat?.size === 'number' ? stat.size : 0,
    mtime: typeof stat?.mtime === 'number' ? stat.mtime : 0,
  }
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
  settings?: YoloSettings
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

// Single source of truth for translating the flat model-facing fs_edit
// arguments into an internal typed TextEditOperation. The edit mode is
// inferred implicitly from which fields are present:
//   - oldText present (and no startLine/endLine) -> exact replace
//   - startLine + endLine present (and no oldText) -> line-range replace
// Providing both groups, neither group, or malformed fields is rejected.
const parseFlatFsEditArgs = (
  args: Record<string, unknown>,
): TextEditOperation => {
  const hasOldText = args.oldText !== undefined && args.oldText !== null
  const hasStartLine = args.startLine !== undefined && args.startLine !== null
  const hasEndLine = args.endLine !== undefined && args.endLine !== null
  const hasLineRange = hasStartLine || hasEndLine

  if (hasOldText && hasLineRange) {
    throw new Error(
      'Provide either oldText (exact replace) or startLine+endLine (line range), not both.',
    )
  }
  if (!hasOldText && !hasLineRange) {
    throw new Error(
      'Provide either oldText (exact replace) or startLine+endLine (line range).',
    )
  }

  if (hasOldText) {
    const oldText = getTextArg(args, 'oldText')
    if (oldText.length === 0) {
      throw new Error('oldText must not be empty.')
    }
    return {
      type: 'replace',
      oldText,
      newText: getTextArg(args, 'newText'),
    }
  }

  const startLine = asPositiveInteger(args.startLine)
  if (!startLine) {
    throw new Error('startLine must be a positive integer.')
  }
  const endLine = asPositiveInteger(args.endLine)
  if (!endLine) {
    throw new Error('endLine must be a positive integer.')
  }

  return {
    type: 'replace_lines',
    startLine,
    endLine,
    newText: getTextArg(args, 'newText'),
  }
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
  // Gateway-merged path: each element is one entry's flat args object.
  const operationsValue = args.operations
  if (Array.isArray(operationsValue)) {
    if (operationsValue.length === 0) {
      throw new Error('operations array must contain at least one operation.')
    }
    const operations = operationsValue.map((entry) =>
      parseFlatFsEditArgs(coerceOperationObject(entry)),
    )
    return { operations }
  }

  // Model-facing path: the flat args themselves describe a single edit.
  return {
    operations: [parseFlatFsEditArgs(args)],
  }
}

const getFsReadOperation = (args: Record<string, unknown>): FsReadOperation => {
  const topLevelOperationKeys = [
    'type',
    'startLine',
    'endLine',
    'maxLines',
    'format',
    'modality',
  ]
  const hasTopLevelOperationKey = topLevelOperationKeys.some(
    (key) => args[key] !== undefined,
  )

  if (
    (args.operation === undefined || args.operation === null) &&
    !hasTopLevelOperationKey
  ) {
    return { type: 'full' }
  }

  const parsedOperation = coerceOperationObject(args.operation)
  const type = asOptionalString(parsedOperation.type).trim().toLowerCase()

  // Strict modality parsing: accept undefined / null / empty string (→ unset,
  // use default per active model) or one of 'text' / 'image' / 'pdf'. Numbers,
  // booleans, objects, arrays, and any other strings (including legacy 'auto')
  // all reject.
  //
  // The schema presented to the model is tailored per model capability
  // (see buildFsReadModalitySchema), so e.g. PDF-capable models only see
  // ['text','pdf']. The parser accepts the full superset because (a) it
  // doesn't have model context here, and (b) resolveModality below maps any
  // request to a sensible effective modality given the active model — a
  // model that somehow sends 'image' to a PDF-capable model gets upgraded to
  // native PDF rather than rejected, which is the more conservative path.
  const rawModalityValue = parsedOperation.modality
  let modality: FsReadModality | undefined
  if (rawModalityValue !== undefined && rawModalityValue !== null) {
    if (typeof rawModalityValue !== 'string') {
      throw new Error(
        "operation.modality must be 'text', 'image', or 'pdf' (or omitted for default behavior).",
      )
    }
    const normalized = rawModalityValue.trim().toLowerCase()
    if (normalized === '') {
      // Empty string is treated as "not provided" → default behavior.
    } else if (
      normalized === 'text' ||
      normalized === 'image' ||
      normalized === 'pdf'
    ) {
      modality = normalized
    } else {
      throw new Error(
        "operation.modality must be 'text', 'image', or 'pdf' (or omitted for default behavior).",
      )
    }
  }

  let format: BrowserReadFormat | undefined
  const rawFormatValue = parsedOperation.format
  if (rawFormatValue !== undefined && rawFormatValue !== null) {
    if (typeof rawFormatValue !== 'string') {
      throw new Error(
        "operation.format must be 'readable' or 'key_visible_info' (or omitted).",
      )
    }
    const normalizedFormat = rawFormatValue.trim().toLowerCase()
    if (normalizedFormat === '') {
      // Empty string is treated as "not provided".
    } else if (
      normalizedFormat === 'readable' ||
      normalizedFormat === 'key_visible_info'
    ) {
      format = normalizedFormat
    } else {
      throw new Error(
        "operation.format must be 'readable' or 'key_visible_info' (or omitted).",
      )
    }
  }

  if (type === 'full') {
    return { type: 'full', modality, format }
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
      format,
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

const annotateAggregatedSearchWithCitations = (
  results: AggregatedSearchResult[],
  runContext: AgentRunContext | undefined,
): AggregatedSearchResult[] => {
  const registry = runContext?.citationRegistry
  if (!registry) {
    return results
  }
  return results.map((group) => {
    if (group.kind !== 'content_group') {
      return group
    }
    const decoratedSnippets = group.snippets.map((snippet) => {
      const start = snippet.startLine ?? snippet.line ?? 0
      const end = snippet.endLine ?? snippet.line ?? start
      const dedupKey = superSearchDedupKey({
        kind: 'content',
        path: group.path,
        line: snippet.line,
        startLine: snippet.startLine,
        endLine: snippet.endLine,
        page: snippet.page,
        snippet: snippet.snippet,
        source: snippet.source,
        similarity: snippet.similarity,
        rrfScore: snippet.rrfScore,
      })
      const ordinal = registry.assign(dedupKey, {
        path: group.path,
        startLine: start,
        endLine: end,
        page: snippet.page,
        snippet: snippet.snippet ?? '',
        similarity: snippet.similarity,
        source: snippet.source,
      })
      return { ...snippet, cite: ordinal }
    })
    return { ...group, snippets: decoratedSnippets }
  })
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

export const ASK_USER_QUESTION_TOOL_NAME = 'ask_user_question'

export type AskUserQuestionInputType =
  | 'free_text'
  | 'single_select'
  | 'multi_select'

export type AskUserQuestionOption = {
  id: string
  label: string
}

/**
 * Reserved option id used by the UI to inject an "Other" escape hatch into
 * every single_select / multi_select. The model is forbidden from emitting an
 * option with this id (the validator rejects it) so the UI can rely on the id
 * being free.
 */
export const ASK_USER_QUESTION_OTHER_ID = '__other__'

export type AskUserQuestionItem = {
  id: string
  prompt: string
  inputType: AskUserQuestionInputType
  options?: AskUserQuestionOption[]
}

export type AskUserQuestionArgs = {
  questions: AskUserQuestionItem[]
}

export type AskUserQuestionValidationResult =
  | { ok: true; value: AskUserQuestionArgs }
  | { ok: false; error: string }

/**
 * Validate the model-provided arguments for the `ask_user_question` tool.
 * The tool has no execution path — the gateway calls this and converts a
 * failed result into a Tool Error response. A successful result is what the
 * UI panel renders.
 */
export function validateAskUserQuestionArgs(
  rawArgs: unknown,
): AskUserQuestionValidationResult {
  if (
    rawArgs === null ||
    typeof rawArgs !== 'object' ||
    Array.isArray(rawArgs)
  ) {
    return { ok: false, error: 'arguments must be an object.' }
  }
  const args = rawArgs as Record<string, unknown>
  const rawQuestions = args.questions
  if (!Array.isArray(rawQuestions)) {
    return { ok: false, error: 'questions must be an array.' }
  }
  if (rawQuestions.length < 1) {
    return {
      ok: false,
      error: 'questions must contain at least 1 item.',
    }
  }

  const seenIds = new Set<string>()
  const validated: AskUserQuestionItem[] = []
  for (let i = 0; i < rawQuestions.length; i++) {
    const raw = rawQuestions[i]
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: `questions[${i}] must be an object.` }
    }
    const q = raw as Record<string, unknown>

    const id = q.id
    if (typeof id !== 'string' || id.trim() === '') {
      return {
        ok: false,
        error: `questions[${i}].id must be a non-empty string.`,
      }
    }
    if (seenIds.has(id)) {
      return {
        ok: false,
        error: `questions[${i}].id "${id}" is duplicated; ids must be unique.`,
      }
    }
    seenIds.add(id)

    const prompt = q.prompt
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      return {
        ok: false,
        error: `questions[${i}].prompt must be a non-empty string.`,
      }
    }

    const inputType = q.inputType
    if (
      inputType !== 'free_text' &&
      inputType !== 'single_select' &&
      inputType !== 'multi_select'
    ) {
      return {
        ok: false,
        error: `questions[${i}].inputType must be "free_text", "single_select", or "multi_select".`,
      }
    }

    let options: AskUserQuestionOption[] | undefined

    if (inputType === 'single_select' || inputType === 'multi_select') {
      if (!Array.isArray(q.options)) {
        return {
          ok: false,
          error: `questions[${i}].options must be an array for ${inputType}.`,
        }
      }
      if (q.options.length < 2) {
        return {
          ok: false,
          error: `questions[${i}].options must contain at least 2 items.`,
        }
      }
      const seenOptionIds = new Set<string>()
      const opts: AskUserQuestionOption[] = []
      for (let j = 0; j < q.options.length; j++) {
        const rawOpt = q.options[j]
        if (
          rawOpt === null ||
          typeof rawOpt !== 'object' ||
          Array.isArray(rawOpt)
        ) {
          return {
            ok: false,
            error: `questions[${i}].options[${j}] must be an object.`,
          }
        }
        const opt = rawOpt as Record<string, unknown>
        if (typeof opt.id !== 'string' || opt.id.trim() === '') {
          return {
            ok: false,
            error: `questions[${i}].options[${j}].id must be a non-empty string.`,
          }
        }
        if (opt.id === ASK_USER_QUESTION_OTHER_ID) {
          return {
            ok: false,
            error: `questions[${i}].options[${j}].id "${ASK_USER_QUESTION_OTHER_ID}" is reserved by the UI; remove this option and rely on the auto-appended "Other" entry.`,
          }
        }
        if (typeof opt.label !== 'string' || opt.label.trim() === '') {
          return {
            ok: false,
            error: `questions[${i}].options[${j}].label must be a non-empty string.`,
          }
        }
        if (seenOptionIds.has(opt.id)) {
          return {
            ok: false,
            error: `questions[${i}].options[${j}].id "${opt.id}" is duplicated within the question.`,
          }
        }
        seenOptionIds.add(opt.id)
        opts.push({ id: opt.id, label: opt.label })
      }
      options = opts
    } else {
      // free_text
      if (q.options !== undefined) {
        return {
          ok: false,
          error: `questions[${i}].options is not allowed for free_text inputType.`,
        }
      }
    }

    validated.push({
      id,
      prompt,
      inputType,
      ...(options ? { options } : {}),
    })
  }

  return { ok: true, value: { questions: validated } }
}

export function isAskUserQuestionToolName(toolName: string): boolean {
  try {
    const parsed = parseToolName(toolName)
    return (
      parsed.serverName === LOCAL_FILE_TOOL_SERVER &&
      parsed.toolName === ASK_USER_QUESTION_TOOL_NAME
    )
  } catch {
    return false
  }
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

/**
 * Build an editSummary (+ chat-undo snapshot + review snapshot) for a
 * file content change (create/overwrite/delete) and accumulate it into a
 * single-file result. Returns the metadata for the tool response.
 */
const buildFileChangeSummary = async ({
  app,
  settings,
  path,
  beforeContent,
  afterContent,
  beforeExists,
  afterExists,
  conversationId,
  roundId,
  toolCallId,
  appliedAt,
}: {
  app: App
  settings?: YoloSettings
  path: string
  beforeContent: string
  afterContent: string
  beforeExists: boolean
  afterExists: boolean
  conversationId?: string
  roundId?: string
  toolCallId?: string
  appliedAt: number
}): Promise<LocalToolCallResultMetadata | undefined> => {
  let editSummary = createToolEditSummary({
    path,
    beforeContent,
    afterContent,
    beforeExists,
    afterExists,
    reviewRoundId: roundId,
  })

  if (toolCallId && editSummary) {
    editUndoSnapshotStore.set({
      toolCallId,
      path,
      beforeContent,
      afterContent,
      beforeExists,
      afterExists,
      appliedAt,
    })
  }

  if (conversationId && roundId && editSummary) {
    const snapshot = await upsertEditReviewSnapshot({
      app,
      conversationId,
      roundId,
      filePath: path,
      beforeContent,
      afterContent,
      beforeExists,
      afterExists,
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

  if (!editSummary) {
    return undefined
  }

  return {
    editSummary: {
      files: editSummary.files,
      totalFiles: editSummary.files.length,
      totalAddedLines: editSummary.totalAddedLines,
      totalRemovedLines: editSummary.totalRemovedLines,
      undoStatus: deriveToolEditUndoStatus(editSummary.files),
    },
    appliedAt,
  }
}

const executeFsFileOps = async ({
  app,
  settings,
  action,
  item,
  signal,
  tool,
  conversationId,
  roundId,
  toolCallId,
}: {
  app: App
  settings?: YoloSettings
  action: FsFileOpAction
  item: Record<string, unknown>
  signal?: AbortSignal
  tool: string
  conversationId?: string
  roundId?: string
  toolCallId?: string
}): Promise<LocalToolCallResult> => {
  if (signal?.aborted) {
    return { status: ToolCallResponseStatus.Aborted }
  }

  const appliedAt = Date.now()

  try {
    if (action === 'write') {
      const path = validateVaultPath(getTextArg(item, 'path'))
      const content = getTextArg(item, 'content')
      assertContentSize(content)

      const existing = app.vault.getAbstractFileByPath(path)

      if (existing instanceof TFolder) {
        throw new Error(`Path is a folder, cannot overwrite as a file: ${path}`)
      }

      let result: FsResultItem
      let metadata: LocalToolCallResultMetadata | undefined

      if (existing instanceof TFile) {
        // Overwrite. Guard against pulling an oversized old file into the
        // diff/undo snapshot: when the existing content exceeds the size
        // limit we still overwrite, but skip the snapshot/editSummary so we
        // don't blow up memory with a giant before-content.
        const overSized = existing.stat.size > MAX_FILE_SIZE_BYTES
        const beforeContent = overSized ? '' : await app.vault.read(existing)
        await app.vault.modify(existing, content)
        if (!overSized) {
          metadata = await buildFileChangeSummary({
            app,
            settings,
            path,
            beforeContent,
            afterContent: content,
            beforeExists: true,
            afterExists: true,
            conversationId,
            roundId,
            toolCallId,
            appliedAt,
          })
        }
        result = {
          ok: true,
          action,
          target: path,
          message: overSized
            ? 'Overwrote file (existing content too large for undo snapshot).'
            : 'Overwrote file.',
        }
      } else {
        await ensureParentFolderExists(app, path)
        await app.vault.create(path, content)
        metadata = await buildFileChangeSummary({
          app,
          settings,
          path,
          beforeContent: '',
          afterContent: content,
          beforeExists: false,
          afterExists: true,
          conversationId,
          roundId,
          toolCallId,
          appliedAt,
        })
        result = {
          ok: true,
          action,
          target: path,
          message: 'Created file.',
        }
      }

      return {
        status: ToolCallResponseStatus.Success,
        text: formatJsonResult({ tool, action, results: [result] }),
        metadata,
      }
    }

    if (action === 'delete') {
      const path = validateVaultPath(getTextArg(item, 'path'))
      const recursive = getOptionalBooleanArg(item, 'recursive') ?? false
      const existing = app.vault.getAbstractFileByPath(path)
      if (!existing) {
        throw new Error(`Path not found: ${path}`)
      }

      if (existing instanceof TFile) {
        const content = await app.vault.read(existing)
        await app.fileManager.trashFile(existing)
        const metadata = await buildFileChangeSummary({
          app,
          settings,
          path,
          beforeContent: content,
          afterContent: '',
          beforeExists: true,
          afterExists: false,
          conversationId,
          roundId,
          toolCallId,
          appliedAt,
        })
        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool,
            action,
            results: [
              {
                ok: true,
                action,
                target: path,
                message: 'Deleted file.',
                targetKind: 'file',
              } satisfies FsResultItem,
            ],
          }),
          metadata,
        }
      }

      if (existing instanceof TFolder) {
        if (!recursive && existing.children.length > 0) {
          throw new Error(
            `Folder is not empty: ${path}. Set recursive=true to delete non-empty folders.`,
          )
        }
        // Folder deletions only move to trash — no editSummary / chat-undo
        // snapshot. Recovery relies on the system/Obsidian trash.
        await app.fileManager.trashFile(existing)
        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool,
            action,
            results: [
              {
                ok: true,
                action,
                target: path,
                message: 'Deleted folder.',
                targetKind: 'folder',
              } satisfies FsResultItem,
            ],
          }),
        }
      }

      throw new Error(`Unsupported delete target: ${path}`)
    }

    if (action === 'create_dir') {
      const path = validateVaultPath(getTextArg(item, 'path'))
      const existing = app.vault.getAbstractFileByPath(path)
      if (existing) {
        throw new Error(`Path already exists: ${path}`)
      }
      await ensureParentFolderExists(app, path)
      await app.vault.createFolder(path)

      return {
        status: ToolCallResponseStatus.Success,
        text: formatJsonResult({
          tool,
          action,
          results: [
            {
              ok: true,
              action,
              target: path,
              message: 'Created folder.',
            } satisfies FsResultItem,
          ],
        }),
      }
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

      await app.fileManager.renameFile(source, newPath)

      return {
        status: ToolCallResponseStatus.Success,
        text: formatJsonResult({
          tool,
          action,
          results: [
            {
              ok: true,
              action,
              target: `${oldPath} -> ${newPath}`,
              message: 'Moved path.',
            } satisfies FsResultItem,
          ],
        }),
      }
    }

    throw new Error(`Unsupported fs action: ${action}`)
  } catch (error) {
    return {
      status: ToolCallResponseStatus.Error,
      error: asErrorMessage(error),
    }
  }
}

async function invokeMemoryTool<T extends { filePath: string }>(
  promptSourceWatcher: PromptSourceWatcher | undefined,
  fn: (hooks: { onInternalWrite?: (path: string) => void }) => Promise<T>,
): Promise<T> {
  if (!promptSourceWatcher) {
    return fn({})
  }
  let writePath: string | undefined
  try {
    return await fn({
      onInternalWrite: (path) => {
        writePath = path
        promptSourceWatcher.markInternalWriteStart(path)
      },
    })
  } finally {
    if (writePath) {
      await Promise.resolve()
      promptSourceWatcher.markInternalWriteEnd(writePath)
    }
  }
}

async function maybeWithInternalWrite<T>(
  promptSourceWatcher: PromptSourceWatcher | undefined,
  path: string,
  task: () => Promise<T>,
): Promise<T> {
  if (promptSourceWatcher?.isWatchedPath(path)) {
    return promptSourceWatcher.withInternalWrite(path, task)
  }
  return task()
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
  allowedSkillPaths,
  runContext,
  subagentParentContext,
  promptSourceWatcher,
}: {
  app: App
  settings?: YoloSettings
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
  allowedSkillPaths?: readonly string[]
  runContext?: AgentRunContext
  subagentParentContext?: SubagentParentContext
  promptSourceWatcher?: PromptSourceWatcher
}): Promise<LocalToolCallResult> {
  if (signal?.aborted) {
    return { status: ToolCallResponseStatus.Aborted }
  }

  try {
    // Final defense: reject any fs_* call whose path args fall outside the
    // agent's workspace scope. The gateway performs the same check up front
    // for UI Rejected status, but we re-validate here so manual-approval /
    // direct-call code paths cannot bypass the constraint.
    if (workspaceScope?.enabled) {
      const exemptPaths = allowedSkillPaths
        ? buildAllowedSkillPathSet(allowedSkillPaths)
        : undefined
      const offendingPath = findPathOutsideScope(
        toolName,
        args,
        workspaceScope,
        {
          exemptPaths,
        },
      )
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
          .map((path) => normalizeFsReadPath(path))
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
        const allowedSkillPathSet = allowedSkillPaths
          ? buildAllowedSkillPathSet(allowedSkillPaths)
          : undefined

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
              effectiveModality?: 'text' | 'image' | 'pdf'
              warning?: string
              url?: string
              title?: string
              loading?: boolean
              redactions?: Array<{ kind: string; count: number }>
              partial?: { reason: string; message: string }
            }
          | {
              path: string
              ok: false
              error: string
            }
        > = []

        // Tool result attachments hoisted to a follow-up user message after
        // the tool block. Mostly image_url for rendered PDFs/images, but also
        // `document` for native PDF slices.
        const perFileAttachmentParts: Array<{
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
        // Conservative: when no active model is known, don't assume PDF support.
        const chatModelAcceptsPdf = activeChatModel
          ? chatModelSupportsPdf(activeChatModel)
          : false

        for (const path of paths) {
          if (signal?.aborted) {
            return { status: ToolCallResponseStatus.Aborted }
          }

          if (allowedSkillPathSet?.has(normalizeSkillPathForExemption(path))) {
            const skillDocument = await getLiteSkillDocumentByPath({
              app,
              path,
              settings,
            })
            if (!skillDocument) {
              results.push({ path, ok: false, error: 'Skill not found.' })
              continue
            }

            const content = skillDocument.content
            const lines = content.length === 0 ? [] : content.split('\n')
            const sliced = sliceLinesForFsReadOperation(lines, operation)

            results.push({
              path,
              ok: true,
              totalLines: sliced.totalLines,
              returnedRange:
                operation.type === 'lines'
                  ? {
                      startLine: sliced.returnedStartLine,
                      endLine: sliced.returnedEndLine,
                    }
                  : undefined,
              hasMoreBelow: sliced.hasMoreBelow,
              nextStartLine: sliced.nextStartLine,
              content: sliced.outputContent,
            })
            continue
          }

          if (isBrowserReadPath(path)) {
            if (Platform.isMobile) {
              results.push({
                path,
                ok: false,
                error: 'Reading open web pages via fs_read is desktop-only.',
              })
              continue
            }

            const pageId = parseBrowserReadPageId(path)
            const handle = findWebviewHandleByPageId(app, pageId)
            if (!handle) {
              results.push({
                path,
                ok: false,
                error: `No open web page with page_id "${pageId}" was found. The tab may have been closed or replaced.`,
              })
              continue
            }

            const format = operation.format ?? 'key_visible_info'
            try {
              const browserResult = await readActiveWebviewPage(handle, {
                format,
                signal,
              })
              if (!browserResult) {
                results.push({
                  path,
                  ok: false,
                  error:
                    'Webview is present but has no loaded page (URL empty or about:blank). Navigate to a URL first.',
                })
                continue
              }

              const text = browserResult.text ?? ''
              const lines = text.length === 0 ? [] : text.split('\n')
              const sliced = sliceLinesForFsReadOperation(lines, operation)
              results.push({
                path,
                ok: true,
                totalLines: sliced.totalLines,
                returnedRange:
                  operation.type === 'lines'
                    ? {
                        startLine: sliced.returnedStartLine,
                        endLine: sliced.returnedEndLine,
                      }
                    : undefined,
                hasMoreBelow: sliced.hasMoreBelow,
                nextStartLine: sliced.nextStartLine,
                content: sliced.outputContent,
                url: browserResult.url,
                title: browserResult.title,
                loading: browserResult.loading,
                redactions: browserResult.redactions,
                ...(browserResult.partial
                  ? { partial: browserResult.partial }
                  : {}),
              })
            } catch (error) {
              if (error instanceof BrowserReadFailure) {
                results.push({
                  path,
                  ok: false,
                  error: `${error.code}: ${error.message}`,
                })
                continue
              }
              throw error
            }
            continue
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

            // Resolve the effective modality for this PDF read. The schema
            // exposed to the model is tailored per capability (see
            // buildFsReadModalitySchema), so normally the requested modality
            // is already aligned with what the model can use. The branches
            // below also handle the "out-of-schema" cases (model somehow
            // sends image to a PDF-capable model, or pdf to a vision-only
            // model) — those resolve to the strictly-better alternative
            // rather than failing.
            //
            // Decision table:
            //   ── PDF-capable model ──
            //     undefined → pdf
            //     'pdf'     → pdf
            //     'text'    → text  (cheap path; respected verbatim)
            //     'image'   → pdf   (image is redundant when native PDF is
            //                       available — native PDF is strictly more
            //                       informative; this branch is a safety net,
            //                       schema doesn't expose image to these
            //                       models)
            //   ── vision-capable (non-PDF) ──
            //     undefined → text
            //     'pdf'     → text  (pdf not supported; safety-net downgrade)
            //     'text'    → text
            //     'image'   → image if image-read setting enabled, else text
            //   ── text-only ──
            //     all paths → text (no other modality is supported)
            const imageReadingEnabled =
              settings?.chatOptions?.imageReadingEnabled ?? true
            const canUseImage = chatModelAcceptsImages && imageReadingEnabled
            const resolvedModality: 'pdf' | 'image' | 'text' = (() => {
              if (chatModelAcceptsPdf) {
                switch (operation.modality) {
                  case undefined:
                  case 'pdf':
                  case 'image':
                    return 'pdf'
                  case 'text':
                    return 'text'
                }
              }
              switch (operation.modality) {
                case undefined:
                case 'pdf':
                case 'text':
                  return 'text'
                case 'image':
                  return canUseImage ? 'image' : 'text'
              }
            })()

            // ── Native PDF slice branch ────────────────────────────────────
            if (resolvedModality === 'pdf') {
              const reqStart =
                operation.type === 'lines' ? operation.startLine : 1
              // lines 模式无 endLine 时语义与 image/text 分支一致：只读单页。
              // full 模式的 endPage 留空，由 slicePdfPages 自动取到文档末页。
              const reqEnd =
                operation.type === 'lines'
                  ? (operation.endLine ?? operation.startLine)
                  : undefined

              // Attempt to slice the PDF. slicePdfPages loads the source once
              // and reports total page count + clamped range; on failure it
              // throws a tagged PdfSliceError. Caller-side reaction depends on
              // the kind:
              //   • 'invalid-range' (e.g. startPage > totalPages) is a hard
              //     model-facing error — degrading to text would silently hide
              //     a bad page request.
              //   • all other kinds (load-failed / too-large / too-many-pages)
              //     fall through to text extraction with a warning prefix.
              let sliceResult:
                | Awaited<ReturnType<typeof slicePdfPages>>
                | undefined
              let sliceFallbackWarning: string | undefined

              try {
                const rawBuf = await app.vault.readBinary(file)
                const rawBytes = new Uint8Array(rawBuf)
                sliceResult = await slicePdfPages(rawBytes, {
                  startPage: reqStart,
                  endPage: reqEnd,
                })
              } catch (err) {
                if (
                  err instanceof PdfSliceError &&
                  err.kind === 'invalid-range'
                ) {
                  results.push({
                    path,
                    ok: false,
                    error: err.message,
                  })
                  continue
                }
                sliceFallbackWarning =
                  err instanceof Error ? err.message : String(err)
              }

              if (sliceResult !== undefined) {
                // Slice succeeded — emit the document part.
                const {
                  bytes: slicedBytes,
                  totalSourcePages,
                  actualStart,
                  actualEnd,
                } = sliceResult
                const slicePageCount = actualEnd - actualStart + 1

                const base64Data = uint8ArrayToBase64(slicedBytes)
                const documentPart: ContentPart = {
                  type: 'document',
                  mediaType: 'application/pdf',
                  name: `${file.name} (pages ${actualStart}–${actualEnd})`,
                  data: base64Data,
                  pageCount: slicePageCount,
                }

                const hasMoreBelow =
                  operation.type === 'lines' && actualEnd < totalSourcePages
                const nextStartLine = hasMoreBelow ? actualEnd + 1 : null

                results.push({
                  path,
                  ok: true,
                  totalLines: totalSourcePages,
                  returnedRange:
                    operation.type === 'lines'
                      ? { startLine: actualStart, endLine: actualEnd }
                      : undefined,
                  hasMoreBelow,
                  nextStartLine,
                  // Explain page-number renumbering so the model cites original
                  // page numbers (actualStart–actualEnd) rather than the
                  // slice-internal numbers (1–slicePageCount).
                  content: `Read pages ${actualStart}–${actualEnd} of "${file.name}" (original document has ${totalSourcePages} pages).\nThe attached PDF slice contains those pages renumbered as 1–${slicePageCount} internally, but you should refer to them by their ORIGINAL page numbers (${actualStart}–${actualEnd}) when citing.`,
                  effectiveModality: 'pdf' as const,
                })
                perFileAttachmentParts.push({ path, parts: [documentPart] })
                continue
              }

              // Slice failed — fall through to text extraction with a warning prefix.
              let pdfSliceFallbackPages: { page: number; text: string }[] = []
              try {
                const extracted = await extractPdfText(app, file, {
                  signal,
                  maxBinaryBytes: PDF_INDEX_MAX_BYTES,
                  maxPages: PDF_INDEX_MAX_PAGES,
                  settings,
                })
                pdfSliceFallbackPages = extracted.pages
              } catch (extractErr) {
                if (
                  extractErr instanceof DOMException &&
                  extractErr.name === 'AbortError'
                ) {
                  return { status: ToolCallResponseStatus.Aborted }
                }
                results.push({
                  path,
                  ok: false,
                  error:
                    extractErr instanceof Error
                      ? extractErr.message
                      : 'Failed to extract PDF text.',
                })
                continue
              }

              const fbTotalPageCount = pdfSliceFallbackPages.length
              const fbRangeStart = operation.type === 'lines' ? reqStart : 1
              const fbRangeEnd =
                operation.type === 'full'
                  ? fbTotalPageCount
                  : Math.min(reqEnd ?? fbRangeStart, fbTotalPageCount)
              const fbSelectedPages = pdfSliceFallbackPages.filter(
                (p) => p.page >= fbRangeStart && p.page <= fbRangeEnd,
              )
              const fbTaggedBody = fbSelectedPages
                .map((p) => `<page ${p.page}>\n${p.text}\n</page ${p.page}>`)
                .join('\n')
              const fbWarningPrefix = `[PDF native slice failed for pages ${fbRangeStart}–${fbRangeEnd}, falling back to text extraction. Reason: ${sliceFallbackWarning ?? 'unknown error'}]\n\n`

              results.push({
                path,
                ok: true,
                totalLines: fbTotalPageCount,
                returnedRange:
                  operation.type === 'lines'
                    ? {
                        startLine:
                          fbSelectedPages.length > 0 ? fbRangeStart : null,
                        endLine: fbSelectedPages.length > 0 ? fbRangeEnd : null,
                      }
                    : undefined,
                hasMoreBelow:
                  operation.type === 'lines' && fbRangeEnd < fbTotalPageCount,
                nextStartLine:
                  operation.type === 'lines' && fbRangeEnd < fbTotalPageCount
                    ? fbRangeEnd + 1
                    : null,
                content: fbWarningPrefix + fbTaggedBody,
                effectiveModality: 'text' as const,
                warning: fbWarningPrefix.trim(),
              })
              continue
            }

            // ── Image render branch ────────────────────────────────────────
            // resolvedModality has already taken vision capability and the
            // image-reading setting into account; checking it here is enough.
            if (resolvedModality === 'image') {
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
                perFileAttachmentParts.push({
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

            // When an explicit modality request was silently re-mapped to
            // text by the resolver, mark `effectiveModality` so callers /
            // log readers can observe the divergence between requested and
            // executed mode. Default (undefined) lands here too — but we
            // only emit the marker when there's an actual divergence.
            //
            // Two visible divergences trigger metadata:
            //   - 'image' on text-only model → text (caller asked for image
            //     but the model can't do vision). Carries a model-visible
            //     warning so the model knows its visual request was lost.
            //   - 'pdf' on non-PDF model → text (caller asked for native
            //     PDF, model doesn't support it). No warning text — the
            //     downgrade is the system's choice, not something the model
            //     should try to "correct" by asking again.
            const visionDowngraded =
              operation.modality === 'image' && !chatModelAcceptsImages
            const pdfDowngraded =
              operation.modality === 'pdf' && !chatModelAcceptsPdf

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
                : pdfDowngraded
                  ? { effectiveModality: 'text' as const }
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
          const sliced = sliceLinesForFsReadOperation(lines, operation)
          const outputContent = sliced.outputContent
          const rawSelected = sliced.rawSelected

          const wikilinks =
            path.endsWith('.md') && rawSelected.length > 0
              ? collectWikilinkPaths(app, rawSelected, path)
              : []

          results.push({
            path,
            ok: true,
            totalLines: sliced.totalLines,
            returnedRange:
              operation.type === 'lines'
                ? {
                    startLine: sliced.returnedStartLine,
                    endLine: sliced.returnedEndLine,
                  }
                : undefined,
            hasMoreBelow: sliced.hasMoreBelow,
            nextStartLine: sliced.nextStartLine,
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
              perFileAttachmentParts.push({
                path,
                parts: imageResult.contentParts,
              })
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
          perFileAttachmentParts.length > 0
            ? perFileAttachmentParts.flatMap((p) => p.parts)
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
        if (file.stat.size > MAX_EDIT_FILE_SIZE_BYTES) {
          throw new Error(`File too large (${file.stat.size} bytes).`)
        }

        const content = await app.vault.read(file)
        const materialized = materializeTextEditPlan({
          content,
          plan,
        })

        if (materialized.errors.length > 0) {
          const replaceFailure = materialized.failures?.find(
            (failure) =>
              failure.operation.type === 'replace' &&
              failure.kind === 'no_match',
          )
          if (replaceFailure && replaceFailure.operation.type === 'replace') {
            throw new Error(
              `${path}: ${buildReplaceMatchErrorHint({
                content,
                oldText: replaceFailure.operation.oldText,
              })}`,
            )
          }
          throw new Error(`${path}: ${materialized.errors[0]}`)
        }

        const nextContent = materialized.newContent

        if (nextContent.length > MAX_EDIT_FILE_SIZE_BYTES) {
          throw new Error(
            `Content too large (${nextContent.length} chars). Max allowed is ${MAX_EDIT_FILE_SIZE_BYTES}.`,
          )
        }

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
          await maybeWithInternalWrite(promptSourceWatcher, path, () =>
            app.vault.modify(file, nextContent),
          )
        }

        const appliedAt = Date.now()
        // MAX_FILE_SIZE_BYTES 作为"快照阈值"：当编辑前或编辑后的内容超过阈值时，
        // 跳过 undo/review 快照与 diff（避免把超大内容读进快照存储），与 fs_write
        // 覆盖超大文件时的行为对齐。必须同时看 before(content) 与 after(appliedContent)，
        // 因为小文件也可能被编辑后膨胀到阈值以上。
        const overSized =
          content.length > MAX_FILE_SIZE_BYTES ||
          appliedContent.length > MAX_FILE_SIZE_BYTES
        const metadata = overSized
          ? undefined
          : await buildFileChangeSummary({
              app,
              settings,
              path,
              beforeContent: content,
              afterContent: appliedContent,
              beforeExists: true,
              afterExists: true,
              conversationId,
              roundId,
              toolCallId,
              appliedAt,
            })

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
              matchMode: result.matchMode,
            })),
            changed: content !== appliedContent,
            message: overSized
              ? 'Applied edit (content too large for undo snapshot).'
              : requireReview
                ? 'Applied reviewed edit.'
                : 'Applied edit.',
          }),
          metadata,
        }
      }

      case 'fs_write': {
        const path = normalizePath(getTextArg(args, 'path'))
        return maybeWithInternalWrite(promptSourceWatcher, path, () =>
          executeFsFileOps({
            app,
            settings,
            action: 'write',
            item: {
              path,
              content: getTextArg(args, 'content'),
            },
            signal,
            tool: 'fs_write',
            conversationId,
            roundId,
            toolCallId,
          }),
        )
      }

      case 'fs_delete': {
        const path = normalizePath(getTextArg(args, 'path'))
        const recursive = getOptionalBooleanArg(args, 'recursive')
        return maybeWithInternalWrite(promptSourceWatcher, path, () =>
          executeFsFileOps({
            app,
            settings,
            action: 'delete',
            item: {
              path,
              ...(recursive === undefined ? {} : { recursive }),
            },
            signal,
            tool: 'fs_delete',
            conversationId,
            roundId,
            toolCallId,
          }),
        )
      }

      case 'fs_create_dir': {
        return executeFsFileOps({
          app,
          action: 'create_dir',
          item: { path: getTextArg(args, 'path') },
          signal,
          tool: 'fs_create_dir',
        })
      }

      case 'fs_move': {
        const oldPath = normalizePath(getTextArg(args, 'oldPath'))
        const newPath = normalizePath(getTextArg(args, 'newPath'))
        const runMove = () =>
          executeFsFileOps({
            app,
            action: 'move',
            item: {
              oldPath,
              newPath,
            },
            signal,
            tool: 'fs_move',
          })
        if (
          promptSourceWatcher?.isWatchedPath(oldPath) &&
          promptSourceWatcher.isWatchedPath(newPath) &&
          oldPath !== newPath
        ) {
          return promptSourceWatcher.withInternalWrite(oldPath, () =>
            promptSourceWatcher.withInternalWrite(newPath, runMove),
          )
        }
        if (promptSourceWatcher?.isWatchedPath(oldPath)) {
          return promptSourceWatcher.withInternalWrite(oldPath, runMove)
        }
        if (promptSourceWatcher?.isWatchedPath(newPath)) {
          return promptSourceWatcher.withInternalWrite(newPath, runMove)
        }
        return runMove()
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
              results: annotateAggregatedSearchWithCitations(
                aggregateSearchResults({ results, maxResults }),
                runContext,
              ),
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
              results: annotateAggregatedSearchWithCitations(
                aggregateSearchResults({ results, maxResults }),
                runContext,
              ),
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
            results: annotateAggregatedSearchWithCitations(
              aggregateSearchResults({ results: fused, maxResults }),
              runContext,
            ),
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

      case JS_SANDBOX_TOOL_NAME: {
        const jsSandboxSettings = getJsSandboxSettings(settings)
        const proxyHandlers = buildJsSandboxProxyHandlers(
          app,
          jsSandboxSettings,
          getRagEngine,
        )
        return callJsSandboxTool({
          app,
          args,
          signal,
          jsSandboxSettings,
          proxyHandlers,
        })
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
              const result = await invokeMemoryTool(
                promptSourceWatcher,
                (hooks) =>
                  memoryAdd({
                    app,
                    settings,
                    content: item.content,
                    category: item.category,
                    scope: item.scope ?? args.scope,
                    assistantId: settings?.currentAssistantId,
                    ...hooks,
                  }),
              )
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

        const result = await invokeMemoryTool(promptSourceWatcher, (hooks) =>
          memoryAdd({
            app,
            settings,
            content: args.content,
            category: args.category,
            scope: args.scope,
            assistantId: settings?.currentAssistantId,
            ...hooks,
          }),
        )

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
        const result = await invokeMemoryTool(promptSourceWatcher, (hooks) =>
          memoryUpdate({
            app,
            settings,
            id: args.id,
            newContent: args.new_content,
            scope: args.scope,
            assistantId: settings?.currentAssistantId,
            ...hooks,
          }),
        )

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
              const result = await invokeMemoryTool(
                promptSourceWatcher,
                (hooks) =>
                  memoryDelete({
                    app,
                    settings,
                    id,
                    scope: args.scope,
                    assistantId: settings?.currentAssistantId,
                    ...hooks,
                  }),
              )
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

        const result = await invokeMemoryTool(promptSourceWatcher, (hooks) =>
          memoryDelete({
            app,
            settings,
            id: args.id,
            scope: args.scope,
            assistantId: settings?.currentAssistantId,
            ...hooks,
          }),
        )

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

      case 'delegate_subagent': {
        if (!subagentParentContext) {
          throw new Error(
            'delegate_subagent is only available during an active parent agent run.',
          )
        }
        if (!conversationId) {
          throw new Error('conversationId is required for delegate_subagent.')
        }

        const description = getTextArg(args, 'description').trim()
        const taskPrompt = getTextArg(args, 'prompt').trim()
        if (!settings) {
          throw new Error('settings are required for delegate_subagent.')
        }
        const requestedModelId =
          getOptionalTextArg(args, 'modelId')?.trim() ?? ''
        const subagentModelConfig = resolveSubagentModelConfig(settings)
        if (subagentModelConfig.allowedModelIds.length === 0) {
          throw new Error(
            'No registered chat models are configured for delegate_subagent.',
          )
        }
        if (
          requestedModelId &&
          !subagentModelConfig.allowedModelIds.includes(requestedModelId)
        ) {
          throw new Error(
            `Model "${requestedModelId}" is not allowed for delegate_subagent.`,
          )
        }
        const selectedModelId =
          requestedModelId || subagentModelConfig.preferredModelId
        if (!selectedModelId) {
          throw new Error(
            'No preferred chat model is configured for delegate_subagent.',
          )
        }
        const { getChatModelClient } = await import('../llm/manager')
        const selectedModelClient = getChatModelClient({
          settings,
          modelId: selectedModelId,
        })
        const selectedProvider = settings.providers.find(
          (provider) => provider.id === selectedModelClient.model.providerId,
        )

        let assistantMessageId = ''
        if (conversationMessages) {
          for (let i = conversationMessages.length - 1; i >= 0; i--) {
            const m = conversationMessages[i]
            if (m.role === 'assistant') {
              assistantMessageId = m.id
              break
            }
          }
        }

        const { runSubagent } = await import('../agent/subagent/runner')
        const accepted = await runSubagent({
          description,
          prompt: taskPrompt,
          conversationId,
          source: {
            type: 'llm_tool_call',
            toolCallId: toolCallId ?? '',
            assistantMessageId,
          },
          parent: subagentParentContext,
          childModel: {
            providerClient: selectedModelClient.providerClient,
            model: selectedModelClient.model,
            apiType: selectedProvider?.apiType ?? null,
          },
          signal,
        })

        return {
          status: ToolCallResponseStatus.Success,
          text: JSON.stringify(accepted),
        }
      }

      case TERMINAL_COMMAND_TOOL_NAME: {
        const { runBash } = await import('../agent/bash/index')

        let assistantMessageId = ''
        if (conversationMessages) {
          for (let i = conversationMessages.length - 1; i >= 0; i--) {
            const m = conversationMessages[i]
            if (m.role === 'assistant') {
              assistantMessageId = m.id
              break
            }
          }
        }

        let cwd = getOptionalTextArg(args, 'cwd')?.trim() ?? ''
        if (!cwd) {
          const adapter = app.vault.adapter
          if (adapter instanceof FileSystemAdapter) {
            cwd = adapter.getBasePath()
          }
        }

        const result = await runBash({
          command: getOptionalTextArg(args, 'command'),
          sessionId: getOptionalBoundedIntegerArg({
            args,
            key: 'session_id',
            min: 1,
            max: Number.MAX_SAFE_INTEGER,
          }),
          input: getOptionalTextArg(args, 'input'),
          background: getOptionalBooleanArg(args, 'background') ?? false,
          cwd: cwd || undefined,
          timeoutSeconds: getOptionalBoundedIntegerArg({
            args,
            key: 'timeout',
            min: 1,
            max: 600,
          }),
          tailLines: getOptionalBoundedIntegerArg({
            args,
            key: 'tail_lines',
            min: 1,
            max: 10_000,
          }),
          tailBytes: getOptionalBoundedIntegerArg({
            args,
            key: 'tail_bytes',
            min: 1,
            max: 1_048_576,
          }),
          kill: getOptionalBooleanArg(args, 'kill') ?? false,
          signal,
          conversationId,
          source:
            conversationId && toolCallId && assistantMessageId
              ? {
                  type: 'llm_tool_call',
                  toolCallId,
                  assistantMessageId,
                }
              : undefined,
        })

        const exitOk =
          result.exit_code === undefined ||
          result.exit_code === null ||
          result.exit_code === 0
        const text = JSON.stringify(
          {
            session_id: result.session_id,
            state: result.state,
            exit_code: result.exit_code,
            stdout: result.stdout,
            stderr: result.stderr,
          },
          null,
          2,
        )

        if (!exitOk) {
          return {
            status: ToolCallResponseStatus.Error,
            error: `Exit code ${result.exit_code}. Output:\n${text}`,
          }
        }

        return {
          status: ToolCallResponseStatus.Success,
          text,
          metadata: result.truncated
            ? { truncated: result.truncated }
            : undefined,
        }
      }

      case LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME: {
        throw new Error(
          'load_tool_schemas is only available through the Agent runtime.',
        )
      }

      case 'todo_write': {
        return executeTodoWrite({ args })
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

function executeTodoWrite({
  args,
}: {
  args: Record<string, unknown>
}): LocalToolCallResult {
  const rawTodos = args.todos
  if (!Array.isArray(rawTodos)) {
    return {
      status: ToolCallResponseStatus.Error,
      error: 'todos must be an array.',
    }
  }

  const todos: TodoItem[] = []
  for (let i = 0; i < rawTodos.length; i++) {
    const item = rawTodos[i]
    if (typeof item !== 'object' || item === null) {
      return {
        status: ToolCallResponseStatus.Error,
        error: `todos[${i}] must be an object.`,
      }
    }
    const { content, status } = item as Record<string, unknown>
    if (typeof content !== 'string' || content.trim() === '') {
      return {
        status: ToolCallResponseStatus.Error,
        error: `todos[${i}].content must be a non-empty string.`,
      }
    }
    if (
      status !== 'pending' &&
      status !== 'in_progress' &&
      status !== 'completed'
    ) {
      return {
        status: ToolCallResponseStatus.Error,
        error: `todos[${i}].status must be "pending", "in_progress", or "completed".`,
      }
    }
    todos.push({ content, status })
  }

  const inProgressCount = todos.filter((t) => t.status === 'in_progress').length
  if (inProgressCount > 1) {
    return {
      status: ToolCallResponseStatus.Error,
      error: `At most one todo may be in_progress at a time, but ${inProgressCount} were provided.`,
    }
  }

  return {
    status: ToolCallResponseStatus.Success,
    text: 'Todos updated. Continue tracking your progress with the todo list.',
  }
}

const MIME_TYPES_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  zip: 'application/zip',
  json: 'application/json',
  csv: 'text/csv',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
}

function inferMimeType(path: string): string {
  const name = path.split('/').pop() ?? path
  const dotIndex = name.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === name.length - 1) {
    return 'application/octet-stream'
  }
  return (
    MIME_TYPES_BY_EXT[name.slice(dotIndex + 1).toLowerCase()] ??
    'application/octet-stream'
  )
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readHeaderRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const headers: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') {
      headers[key] = item
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

function readRequestBody(value: unknown): string | ArrayBuffer | undefined {
  if (typeof value === 'string' || value instanceof ArrayBuffer) {
    return value
  }
  return undefined
}

function normalizeFetchDomain(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) {
    return null
  }
  try {
    return new URL(
      trimmed.includes('://') ? trimmed : `https://${trimmed}`,
    ).hostname.replace(/^\.+|\.+$/g, '')
  } catch {
    return trimmed.split('/')[0]?.replace(/^\.+|\.+$/g, '') || null
  }
}

function isDomainMatch(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}

function assertJsSandboxFetchAllowed(
  url: string,
  mode: 'whitelist' | 'blacklist',
  domains: string[],
): void {
  let hostname: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('$fetch only supports http(s) URLs')
    }
    hostname = parsed.hostname.toLowerCase()
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('$fetch')) {
      throw error
    }
    throw new Error(`invalid $fetch URL: ${url}`)
  }

  if (domains.length === 0) {
    if (mode === 'whitelist') {
      throw new Error('$fetch whitelist is empty')
    }
    return
  }

  const matched = domains.some((domain) => isDomainMatch(hostname, domain))
  if (mode === 'whitelist' && !matched) {
    throw new Error(`$fetch blocked by whitelist: ${hostname}`)
  }
  if (mode === 'blacklist' && matched) {
    throw new Error(`$fetch blocked by blacklist: ${hostname}`)
  }
}

export function buildJsSandboxProxyHandlers(
  app: App,
  config: JsSandboxSettings,
  getRagEngine?: () => Promise<RAGEngine>,
): JsSandboxProxyHandlers {
  const handlers: JsSandboxProxyHandlers = {}

  if (config.allowVaultRead || config.allowDbQuery) {
    const configuredVaultKb =
      typeof config.vaultReadMaxKb === 'number' &&
      Number.isFinite(config.vaultReadMaxKb)
        ? Math.floor(config.vaultReadMaxKb)
        : JS_SANDBOX_VAULT_READ_DEFAULT_MAX_KB
    const vaultReadMaxKb = Math.min(
      JS_SANDBOX_VAULT_READ_HARD_MAX_KB,
      Math.max(JS_SANDBOX_VAULT_READ_MIN_KB, configuredVaultKb),
    )
    const vaultReadMaxBytes = vaultReadMaxKb * 1024
    handlers.vaultReadConfig = { maxKb: vaultReadMaxKb }

    if (config.allowVaultRead) {
      handlers.vaultList = async (
        path?: string,
        options?: Record<string, unknown>,
      ) => {
        const { folder, normalizedPath } = resolveFolderByPath(app, path)
        const recursive = options?.recursive === true
        // The list crosses the sandbox/host boundary as one array. Keep a hard
        // fuse for pathological vaults while leaving normal large-vault stats
        // practical inside the JS execution.
        const entries = collectVaultChildEntries({
          folder,
          depth: recursive ? Number.POSITIVE_INFINITY : 1,
          maxResults: JS_SANDBOX_VAULT_LIST_MAX_ENTRIES + 1,
        })
        if (entries.length > JS_SANDBOX_VAULT_LIST_MAX_ENTRIES) {
          throw new Error(
            `vault.list refused: more than ${JS_SANDBOX_VAULT_LIST_MAX_ENTRIES} entries under "${normalizedPath || '/'}"; pass a narrower path.`,
          )
        }
        return entries
          .map(toJsSandboxVaultListEntry)
          .sort((a, b) => a.path.localeCompare(b.path))
      }
    }

    handlers.vaultReadText = async (path: string) => {
      const normalized = normalizePath(path)
      const file = app.vault.getAbstractFileByPath(normalized)
      // Contract: return null ONLY when the file truly does not exist
      // (a legitimate "missing" signal the model can branch on). Folder
      // paths and read failures throw with a reason so the script doesn't
      // collapse two distinct cases into the same null.
      if (file === null) {
        return null
      }
      if (!(file instanceof TFile)) {
        throw new Error(`vault.readText: "${path}" is a folder, not a file`)
      }
      try {
        const vault = app.vault as {
          cachedRead?: (f: TFile) => Promise<string>
          read: (f: TFile) => Promise<string>
        }
        const text = vault.cachedRead
          ? await vault.cachedRead(file)
          : await vault.read(file)
        if (text.length > vaultReadMaxBytes) {
          return (
            text.slice(0, vaultReadMaxBytes) +
            `\n\n... [truncated by host: file is ${text.length} bytes, vaultReadMaxKb cap is ${vaultReadMaxKb} KB. Slice or stream in chunks if you need more.]`
          )
        }
        return text
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`vault.readText: ${reason}`)
      }
    }

    if (config.allowVaultRead) {
      handlers.vaultReadBinary = async (path: string) => {
        const normalized = normalizePath(path)
        const file = app.vault.getAbstractFileByPath(normalized)
        // Same contract as readText: null only for "file does not exist".
        if (file === null) {
          return null
        }
        if (!(file instanceof TFile)) {
          throw new Error(`vault.readBinary: "${path}" is a folder, not a file`)
        }
        const buffer = await app.vault.readBinary(file).catch((error) => {
          const reason = error instanceof Error ? error.message : String(error)
          throw new Error(`vault.readBinary: ${reason}`)
        })
        const bytes = new Uint8Array(buffer)
        if (bytes.length > vaultReadMaxBytes) {
          // Binary truncation would yield an invalid file; refuse instead so
          // the model gets a clear signal rather than corrupted base64.
          throw new Error(
            `vault.readBinary refused: file is ${bytes.length} bytes, vaultReadMaxKb cap is ${vaultReadMaxKb} KB`,
          )
        }
        // Convert in 32KB chunks to avoid `String.fromCharCode(...arr)` blowing the call-stack on large files.
        let binary = ''
        const chunkSize = 0x8000
        for (let i = 0; i < bytes.length; i += chunkSize) {
          const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
          binary += String.fromCharCode.apply(null, Array.from(chunk))
        }
        const base64 = btoa(binary)
        return {
          base64,
          mimeType: inferMimeType(path),
          byteLength: bytes.length,
        }
      }
    }
  }

  if (config.allowFetch || config.allowExternalScripts) {
    const configuredMaxConcurrent =
      typeof config.fetchMaxConcurrent === 'number' &&
      Number.isFinite(config.fetchMaxConcurrent) &&
      config.fetchMaxConcurrent > 0
        ? Math.floor(config.fetchMaxConcurrent)
        : JS_SANDBOX_FETCH_DEFAULT_MAX_CONCURRENT
    const configuredMaxResponseKb =
      typeof config.fetchMaxResponseKb === 'number' &&
      Number.isFinite(config.fetchMaxResponseKb) &&
      config.fetchMaxResponseKb > 0
        ? Math.floor(config.fetchMaxResponseKb)
        : JS_SANDBOX_FETCH_DEFAULT_MAX_RESPONSE_KB
    const maxConcurrent = Math.min(
      JS_SANDBOX_FETCH_HARD_MAX_CONCURRENT,
      Math.max(JS_SANDBOX_FETCH_MIN_CONCURRENT, configuredMaxConcurrent),
    )
    const maxResponseKb = Math.min(
      JS_SANDBOX_FETCH_HARD_MAX_RESPONSE_KB,
      Math.max(JS_SANDBOX_FETCH_MIN_RESPONSE_KB, configuredMaxResponseKb),
    )
    const fetchMode = config.fetchMode ?? 'blacklist'
    const fetchDomains = (config.fetchDomains ?? [])
      .map(normalizeFetchDomain)
      .filter((domain): domain is string => Boolean(domain))

    handlers.fetchConfig = {
      fetchMode,
      fetchDomains,
      maxConcurrent,
      maxResponseKb,
    }
    handlers.hostFetch = async (
      url: string,
      init?: Record<string, unknown>,
    ) => {
      assertJsSandboxFetchAllowed(url, fetchMode, fetchDomains)
      const response = await requestUrl({
        url,
        method: readString(init?.method) ?? 'GET',
        headers: readHeaderRecord(init?.headers),
        body: readRequestBody(init?.body),
        contentType: readString(init?.contentType),
        throw: false,
      })
      const bytes = new Uint8Array(response.arrayBuffer)
      if (bytes.byteLength > maxResponseKb * 1024) {
        throw new Error(
          `$fetch response exceeded ${maxResponseKb} KB (${bytes.byteLength} bytes)`,
        )
      }
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        statusText: '',
        headers: response.headers,
        body: response.arrayBuffer,
        byteLength: bytes.byteLength,
      }
    }
  }

  if (config.allowDbQuery && getRagEngine) {
    const configuredLimit =
      typeof config.dbQueryMaxLimit === 'number' &&
      Number.isFinite(config.dbQueryMaxLimit) &&
      config.dbQueryMaxLimit > 0
        ? Math.min(
            JS_SANDBOX_DB_QUERY_HARD_MAX_LIMIT,
            Math.floor(config.dbQueryMaxLimit),
          )
        : JS_SANDBOX_DB_QUERY_DEFAULT_MAX_LIMIT

    const clampLimit = (raw: unknown): number => {
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
        return Math.min(
          JS_SANDBOX_DB_QUERY_DEFAULT_REQUEST_LIMIT,
          configuredLimit,
        )
      }
      return Math.min(configuredLimit, Math.floor(raw))
    }

    handlers.dbQuery = async (
      method: 'search',
      params: Record<string, unknown>,
    ) => {
      if (method === 'search') {
        const engine = await getRagEngine()
        const query = typeof params.query === 'string' ? params.query : ''
        const limit = clampLimit(params.limit)
        const results = await engine.processQuery({ query, limit })
        return results
      }

      throw new Error(`unknown db method: ${method}`)
    }
  }

  return handlers
}
