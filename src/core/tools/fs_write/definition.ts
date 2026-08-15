import { TFile, TFolder } from 'obsidian'

import type { McpTool } from '../../../types/mcp.types'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import {
  ensureParentFolderExists,
  validateVaultPath,
} from '../../mcp/vaultFileOps'
import { defineTool } from '../define'
import {
  buildFileChangeSummary,
  maybeWithInternalWrite,
} from '../file-editing-support'
import { MAX_FILE_SIZE_BYTES, formatJsonResult, getTextArg } from '../tool-args'
import type { LocalToolCallResultMetadata } from '../types'

export const fsWriteDefinition = defineTool({
  name: 'fs_write',
  // Schema copied verbatim from the `fs_write` entry in `getLocalFileTools()`
  // (`src/core/mcp/localFileTools.ts`). Static, like `fs_edit`'s.
  getMcpTool: () =>
    ({
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
    }) satisfies Omit<McpTool, 'name'>,
  // `fs_write` has no entry in the legacy `BUILTIN_TOOL_UI_META` table —
  // its only existing display label lives in `ToolMessage.tsx`'s
  // `chat.toolCall.writeAction.write` i18n key (master.md D6 批 4 item 5 /
  // survey-current-state.md §五.1: "两个同类工具的标签来自两套来源"). This
  // reuses that same key as `chatLabel`'s unified source rather than
  // inventing a new one, closing that asymmetry with `fs_edit`.
  chatLabel: {
    key: 'chat.toolCall.writeAction.write',
    fallback: 'Write file',
  },
  // Not in `isContextPrunableToolName`'s exclusion list, so prunable today
  // — same reasoning as `fs_edit`.
  contextPrunable: true,
  // Ported from the `action === 'write'` branch of `executeFsFileOps`
  // (`src/core/mcp/localFileTools.ts`, pre-migration), reached via the
  // `case 'fs_write'` branch of `callLocalFileTool`. `executeFsFileOps`
  // took a generic `action: FsFileOpAction` parameter and a `results`
  // array back when several split fs-action tools (fs_create_dir,
  // fs_delete, fs_move, ...) shared it; today `FsFileOpAction` has exactly
  // one member (`'write'`, see `LOCAL_FS_SPLIT_ACTION_TOOL_TO_ACTION` in
  // `localFileTools.ts`) and that indirection has no other consumer left,
  // so it is deliberately not reproduced here (master.md D6 批 4 item 4 /
  // phase2-migration.md D6 "注意" on `LOCAL_FS_SPLIT_ACTION_TOOL_NAMES`:
  // "不要原样搬过去") — this writes the single remaining action directly.
  // `localFileTools.ts`'s own `executeFsFileOps` / `LOCAL_FS_SPLIT_ACTION_*`
  // machinery is untouched: it still backs the old switch's `case
  // 'fs_write'`, which stays in place as the equivalence baseline.
  //
  // Output JSON shape (`{ tool: 'fs_write', action: 'write', results: [...] }`)
  // is preserved exactly for equivalence with that old branch. Path
  // validation / abort / workspace-scope / YOLO-data-root guards are
  // dispatcher responsibilities (master.md §3.4) and are not repeated here.
  execute: async (args, ctx) => {
    const {
      app,
      settings,
      conversationId,
      roundId,
      toolCallId,
      promptSourceWatcher,
    } = ctx

    const path = validateVaultPath(getTextArg(args, 'path'))
    const content = getTextArg(args, 'content')
    if (content.length > MAX_FILE_SIZE_BYTES) {
      throw new Error(
        `Content too large (${content.length} chars). Max allowed is ${MAX_FILE_SIZE_BYTES}.`,
      )
    }

    return maybeWithInternalWrite(promptSourceWatcher, path, async () => {
      const appliedAt = Date.now()
      const existing = app.vault.getAbstractFileByPath(path)

      if (existing instanceof TFolder) {
        throw new Error(`Path is a folder, cannot overwrite as a file: ${path}`)
      }

      let result: {
        ok: true
        action: 'write'
        target: string
        message: string
      }
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
          action: 'write',
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
          action: 'write',
          target: path,
          message: 'Created file.',
        }
      }

      return {
        status: ToolCallResponseStatus.Success,
        text: formatJsonResult({
          tool: 'fs_write',
          action: 'write',
          results: [result],
        }),
        metadata,
      }
    })
  },
})
