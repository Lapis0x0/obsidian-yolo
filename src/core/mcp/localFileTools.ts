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
import type { YoloSettings } from '../../settings/schema/setting.types'
import type {
  ApplyViewResult,
  ApplyViewState,
} from '../../types/apply-view.types'
import type {
  AssistantToolApprovalMode,
  AssistantWorkspaceScope,
} from '../../types/assistant.types'
import type { ChatMessage } from '../../types/chat'
import type { ChatModelModality } from '../../types/chat-model.types'
import type { ContentPart } from '../../types/llm/request'
import { McpTool } from '../../types/mcp.types'
import {
  ToolCallResponseStatus,
  type ToolEditSummary,
  type ToolFsReadOperationSummary,
} from '../../types/tool-call.types'
import {
  createToolEditSummary,
  deriveToolEditUndoStatus,
} from '../../utils/chat/editSummary'
import { editUndoSnapshotStore } from '../../utils/chat/editUndoSnapshotStore'
import { isContextPrunableToolName } from '../../utils/chat/tool-context-pruning'
import {
  type DangerousBashOperationKind,
  cancelDangerousBashApproval,
  requestDangerousBashApproval,
} from '../agent/bash/dangerousOperationGate'
import { createVaultBashFileSystem } from '../agent/bash/vaultBashFileSystem'
import type { PromptSourceWatcher } from '../agent/promptSourceWatcher'
import { resolveSubagentModelConfig } from '../agent/subagent/model-config'
import type { SubagentParentContext } from '../agent/subagent/parent-context'
import type { TodoItem } from '../agent/todos-from-messages'
import type { AgentRunContext } from '../agent/types'
import {
  BROWSER_READ_PATH_PREFIX,
  buildAllowedSkillPathSet,
  findPathOutsideScope,
} from '../agent/workspaceScope'
import {
  BROWSER_PAGE_ID_PATTERN,
  findWebviewHandleByPageId,
} from '../browser/activeWebviewProbe'
import {
  BrowserReadFailure,
  readActiveWebviewHtml,
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
  acquireRuntimeComponent,
  isRuntimeComponentEnabled,
} from '../runtime-components/runtimeComponentAccess'
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
  JS_SANDBOX_BROWSER_READ_DEFAULT_MAX_KB,
  JS_SANDBOX_BROWSER_READ_HARD_MAX_KB,
  JS_SANDBOX_BROWSER_READ_MIN_KB,
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
  type JsSandboxBrowserReadHtmlResult,
  type JsSandboxProxyHandlers,
  type JsSandboxVaultListEntry,
  callJsSandboxTool,
  getJsSandboxTool,
} from './jsSandboxTool'
import { LOCAL_FILE_TOOL_SERVER } from './localFileToolNames'
import { parseToolName } from './tool-name-utils'
import { ensureParentFolderExists, validateVaultPath } from './vaultFileOps'

export { getLocalFileToolServerName } from './localFileToolNames'

export { recoverLikelyEscapedBackslashSequences }

export const TERMINAL_COMMAND_TOOL_NAME = 'terminal_command'
export const BASH_TOOL_NAME = 'bash'
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024
// fs_edit 读全文做替换的绝对内存防御上限。MAX_FILE_SIZE_BYTES 是"快照阈值"
// （超过则跳过 undo/review 快照），本常量是"绝对拒绝上限"（超过才真正拒绝编辑）。
const MAX_EDIT_FILE_SIZE_BYTES = 16 * 1024 * 1024
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
  BASH_TOOL_NAME,
  'context_prune_tool_results',
  'context_compact',
  'fs_edit',
  'fs_write',
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
type ContextPruneMode = 'selected' | 'all'
// 'delete' | 'create_dir' | 'move' retired with fs_delete/fs_create_dir/fs_move
// (see the bash tool, which now covers path operations via vaultFileOps.ts).
type FsFileOpAction = 'write'

type LocalToolCallResultMetadata = {
  editSummary?: ToolEditSummary
  fsReadOperation?: ToolFsReadOperationSummary
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
      reason?: string
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
}

type FsEditReviewResult =
  | {
      status: ToolCallResponseStatus.Success
      finalContent: string
      review: NonNullable<ApplyViewResult['review']>
    }
  | {
      status: ToolCallResponseStatus.Rejected
      review: NonNullable<ApplyViewResult['review']>
    }
  | {
      status: ToolCallResponseStatus.Aborted
    }

const LOCAL_FS_SPLIT_ACTION_TOOL_TO_ACTION = {
  fs_write: 'write',
} as const

export const LOCAL_FS_SPLIT_ACTION_TOOL_NAMES = Object.keys(
  LOCAL_FS_SPLIT_ACTION_TOOL_TO_ACTION,
) as Array<keyof typeof LOCAL_FS_SPLIT_ACTION_TOOL_TO_ACTION>

export const LOCAL_FS_EDIT_TOOL_NAMES = ['fs_edit', 'fs_write'] as const

/**
 * Retired with fs_delete/fs_create_dir/fs_move — the bash tool now covers
 * path operations and isn't arg-shaped for this grouping mechanism (see
 * `src/core/agent/workspaceScope.ts`, which enforces scope on the bash
 * adapter directly instead). Kept as an empty array, not deleted, because
 * `LOCAL_FS_PATH_OPERATION_TOOL_NAME_SET` and `FILE_OPS_GROUP_TOOL_NAME`
 * checks elsewhere key off its (now empty) membership rather than needing
 * their own removal.
 */
export const LOCAL_FS_PATH_OPERATION_TOOL_NAMES: readonly string[] = []

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
  reviewEdits,
  selectionRange,
  signal,
}: {
  openApplyReview: (state: ApplyViewState) => Promise<boolean>
  file: TFile
  originalContent: string
  newContent: string
  reviewEdits: ApplyViewState['reviewEdits']
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
      reviewEdits,
      reviewMode: selectionRange ? 'selection-focus' : 'full',
      selectionRange,
      abortSignal: signal,
      callbacks: {
        onComplete: ({ finalContent, review }) => {
          const resolvedReview = review ?? {
            totalChanges: 1,
            rejectedChanges: [],
          }
          settle(
            finalContent === originalContent
              ? {
                  status: ToolCallResponseStatus.Rejected,
                  review: resolvedReview,
                }
              : {
                  status: ToolCallResponseStatus.Success,
                  finalContent,
                  review: resolvedReview,
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

const FS_EDIT_REVIEW_PREVIEW_LENGTH = 40

const buildFsEditReviewPreview = ({
  originalText,
  proposedText,
}: {
  originalText: string
  proposedText: string
}): string => {
  const normalized = (proposedText || originalText).replace(/\s+/g, ' ').trim()
  if (!normalized) return '(empty change)'
  const characters = Array.from(normalized)
  if (characters.length <= FS_EDIT_REVIEW_PREVIEW_LENGTH) return normalized
  return `${characters.slice(0, FS_EDIT_REVIEW_PREVIEW_LENGTH - 1).join('')}…`
}

const buildFsEditReviewPayload = (
  review: NonNullable<ApplyViewResult['review']>,
) => {
  const rejected = review.rejectedChanges.map((change) => ({
    index: change.index,
    preview: buildFsEditReviewPreview(change),
  }))
  return rejected.length === 0
    ? { outcome: 'accepted' as const }
    : { outcome: 'partially_rejected' as const, rejected }
}

const buildFsEditRejectedReason = (): string =>
  'Explicit user decision: this change was rejected in the review UI. This is not an edit or matching failure. Do not retry it with another locator or tool this turn; acknowledge the decision and wait for the user.'

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

const normalizeBrowserReadPageId = (value: string): string => {
  const trimmed = value.trim()
  if (trimmed.startsWith(BROWSER_READ_PATH_PREFIX)) {
    return parseBrowserReadPageId(trimmed)
  }
  if (!BROWSER_PAGE_ID_PATTERN.test(trimmed)) {
    throw new Error(BROWSER_READ_PATH_USAGE)
  }
  return trimmed
}

export const LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME = 'load_tool_schemas'

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

export function getLocalFileTools(_options?: {
  vaultBasePath?: string
  chatModelModalities?: ChatModelModality[]
}): McpTool[] {
  return [
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
        'Apply one targeted text edit to an existing file. You must provide path, newText, and exactly one locator: oldText for exact-text replacement, or startLine+endLine for line-range replacement. Do not call fs_edit with only path and newText. Do not provide both oldText and startLine/endLine. Use fs_write to create a new file, fill an empty file, or overwrite full file content. To make several edits in the same file, emit multiple fs_edit calls — the system automatically merges edits targeting the same file into one atomic review and write, so earlier edits cannot invalidate later ones.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Vault-relative file path.',
          },
          newText: {
            type: 'string',
            description:
              'Replacement text. This is not a standalone write request; it is only valid together with oldText or startLine+endLine.',
          },
          oldText: {
            type: 'string',
            description:
              'Exact-text mode: the existing text to find and replace. Must match the file exactly once. Do not combine with startLine/endLine.',
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
    ...(isRuntimeComponentEnabled('bash-engine')
      ? [
          {
            name: BASH_TOOL_NAME,
            description:
              'A virtual, sandboxed shell for read-only search/inspection plus mkdir/mv/rm over the vault. The filesystem is mounted at /vault (cwd defaults there); nothing outside /vault exists. Read-heavy retrieval (ls, find, grep/rg, cat, head/tail, sed, awk, sort, uniq, wc, diff, and pipes/xargs/loops) is unlimited. rm moves targets to the trash (recoverable via the system/Obsidian trash); mv renames/moves and updates every backlink across the vault, same as the vault UI. mkdir creates folders. Content mutation (redirects, sed -i, tee, cp, touch on a new file) is not available here — it fails with guidance; use fs_edit for a targeted change or fs_write to create/overwrite full file content. Depending on the configured approval level, rm/mv may pause mid-command for user confirmation; a denial returns a nonzero exit code and continues the rest of the script per normal shell semantics (&&, ||, ;).',
            inputSchema: {
              type: 'object',
              properties: {
                command: {
                  type: 'string',
                  description: 'The shell command line to run.',
                },
              },
              required: ['command'],
            },
          } satisfies McpTool,
        ]
      : []),
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
        'Use for terminal-style inspection or local CLI commands on the user’s machine. ' +
        'For vault content search/read/inspection, prefer the bash tool instead — it is sandboxed to the vault and works on every platform. ' +
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
  // Unused in this file now that fs_read (modality resolution) and fs_search
  // (citation annotation) — the only two consumers — are gone. Kept in the
  // accepted options shape because callers still pass them uniformly
  // regardless of which tool is being invoked.
  chatModelId: _chatModelId,
  workspaceScope,
  allowedSkillPaths,
  runContext: _runContext,
  subagentParentContext,
  promptSourceWatcher,
  bashApprovalMode,
  bashReadOnly,
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
  /** Effective approval tier for the bash tool (see tool-gateway.ts). */
  bashApprovalMode?: AssistantToolApprovalMode
  /**
   * Forces the bash tool call into its structurally read-only variant for
   * this entire run (see tool-gateway.ts). When true, mkdir/mv/rm/rmdir are
   * unavailable regardless of `bashApprovalMode`.
   */
  bashReadOnly?: boolean
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
        let reviewResultSummary: NonNullable<ApplyViewResult['review']> | null =
          null

        if (requireReview) {
          if (!openApplyReview) {
            throw new Error('Apply review is unavailable for fs_edit.')
          }

          const reviewResult = await waitForFsEditReview({
            openApplyReview,
            file,
            originalContent: content,
            newContent: nextContent,
            reviewEdits: materialized.reviewEdits,
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
            return {
              status: ToolCallResponseStatus.Rejected,
              reason: buildFsEditRejectedReason(),
            }
          }

          appliedContent = reviewResult.finalContent
          reviewResultSummary = reviewResult.review
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

        const resultPayload = reviewResultSummary
          ? {
              tool: 'fs_edit',
              path,
              changed: content !== appliedContent,
              review: buildFsEditReviewPayload(reviewResultSummary),
              message:
                reviewResultSummary.rejectedChanges.length > 0
                  ? 'Explicit user decision: the listed change was rejected in the review UI. This is not an edit or matching failure. Do not retry it with another locator or tool this turn; acknowledge the decision and wait for the user.'
                  : 'Applied reviewed edit.',
            }
          : {
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
                : 'Applied edit.',
            }

        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult(resultPayload),
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

      case BASH_TOOL_NAME: {
        const command = getTextArg(args, 'command')
        const lease = await acquireRuntimeComponent('bash-engine')
        try {
          const fs = createVaultBashFileSystem(app, workspaceScope)
          const confirmDangerousOperation = async (
            kind: DangerousBashOperationKind,
            targets: readonly string[],
          ): Promise<boolean> => {
            // 'full_access': nothing to gate. 'require_approval': the whole
            // call was already approved before execution started (see
            // tool-gateway.ts's pre-call gate) — asking again mid-script
            // would be redundant. Only the default 'dangerous_only' tier (and
            // any unrecognized value, failing toward the safer behavior)
            // pauses here.
            if (
              bashApprovalMode === 'full_access' ||
              bashApprovalMode === 'require_approval'
            ) {
              return true
            }
            // No addressable tool call to attach an approval card to (should
            // not happen in practice — every real dispatch has a toolCallId).
            // Fail closed rather than silently allowing a destructive op.
            if (!toolCallId) return false
            return requestDangerousBashApproval(toolCallId, kind, targets)
          }
          const session = lease.api.createSession({
            fs,
            confirmDangerousOperation,
            signal,
            readOnly: bashReadOnly ?? false,
          })
          const onAbort = (): void => {
            if (toolCallId) cancelDangerousBashApproval(toolCallId)
          }
          signal?.addEventListener('abort', onAbort)
          try {
            const result = await session.exec(command)
            return {
              status: ToolCallResponseStatus.Success,
              text: formatJsonResult({
                tool: BASH_TOOL_NAME,
                exit_code: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
              }),
            }
          } finally {
            signal?.removeEventListener('abort', onAbort)
            session.dispose()
          }
        } finally {
          lease.release()
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

  if (config.allowBrowserRead) {
    const configuredBrowserKb =
      typeof config.browserReadMaxKb === 'number' &&
      Number.isFinite(config.browserReadMaxKb)
        ? Math.floor(config.browserReadMaxKb)
        : JS_SANDBOX_BROWSER_READ_DEFAULT_MAX_KB
    const browserReadMaxKb = Math.min(
      JS_SANDBOX_BROWSER_READ_HARD_MAX_KB,
      Math.max(JS_SANDBOX_BROWSER_READ_MIN_KB, configuredBrowserKb),
    )
    const browserReadMaxBytes = browserReadMaxKb * 1024
    handlers.browserReadHtml = async (
      rawPageId: string,
    ): Promise<JsSandboxBrowserReadHtmlResult | null> => {
      if (Platform.isMobile) {
        throw new Error('browser.readHtml is desktop-only.')
      }
      const pageId = normalizeBrowserReadPageId(rawPageId)
      const handle = findWebviewHandleByPageId(app, pageId)
      if (!handle) {
        return null
      }
      try {
        return await readActiveWebviewHtml(handle, {
          maxBytes: browserReadMaxBytes,
        })
      } catch (error) {
        if (error instanceof BrowserReadFailure) {
          throw new Error(`browser.readHtml: ${error.message}`)
        }
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`browser.readHtml: ${reason}`)
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
