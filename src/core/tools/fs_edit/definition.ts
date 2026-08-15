import { TFile } from 'obsidian'

import type { ApplyViewResult } from '../../../types/apply-view.types'
import type { McpTool } from '../../../types/mcp.types'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import {
  buildReplaceMatchErrorHint,
  materializeTextEditPlan,
} from '../../edits/textEditEngine'
import { validateVaultPath } from '../../mcp/vaultFileOps'
import { defineTool } from '../define'
import {
  buildFileChangeSummary,
  maybeWithInternalWrite,
} from '../file-editing-support'
import { MAX_FILE_SIZE_BYTES, formatJsonResult, getTextArg } from '../tool-args'
import type { LocalToolCallResultMetadata } from '../types'

import {
  MAX_EDIT_FILE_SIZE_BYTES,
  buildFsEditRejectedReason,
  buildFsEditReviewPayload,
  getFsEditPlan,
  getFsEditSelectionRange,
  waitForFsEditReview,
} from './schema-helpers'

export const fsEditDefinition = defineTool({
  name: 'fs_edit',
  // Schema copied verbatim from the `fs_edit` entry in `getLocalFileTools()`
  // (`src/core/mcp/localFileTools.ts`). Static (no modality/platform
  // dependence), so `getMcpTool` ignores its `ctx` argument — matching
  // `defineTool`'s doc comment ("static tools just return a constant").
  getMcpTool: () =>
    ({
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
    }) satisfies Omit<McpTool, 'name'>,
  chatLabel: {
    key: 'settings.agent.builtinFsEditLabel',
    fallback: 'Text Editing',
  },
  // Not in `isContextPrunableToolName`'s exclusion list (that list only
  // excludes `context_prune_tool_results` / `context_compact` /
  // `load_tool_schemas`), so this tool's results are prunable today.
  contextPrunable: true,
  // Ported verbatim from the `case 'fs_edit'` branch of `callLocalFileTool`
  // (`src/core/mcp/localFileTools.ts`, pre-migration), minus the abort check
  // / workspace-scope / YOLO-data-root guards on the *top-level path
  // parameter* and the outer try/catch — those are dispatcher
  // responsibilities (master.md §3.4). `fs_edit` has no per-resolved-path
  // checks of its own (unlike `fs_read`'s wikilink case) — `path` is a
  // literal argument throughout, so the dispatcher's raw-argument scan is
  // sufficient and nothing extra needs to happen here (master.md §5).
  //
  // `openApplyReview` / `requireReview` now come from `ToolContext` rather
  // than being destructured `callLocalFileTool` parameters — the only
  // change from the pre-migration body. `waitForFsEditReview`'s own timing
  // and semantics (imported from `./schema-helpers`) are untouched
  // (phase2-migration.md D6 批 4).
  execute: async (args, ctx) => {
    const {
      app,
      settings,
      openApplyReview,
      requireReview = false,
      signal,
      conversationId,
      roundId,
      toolCallId,
      promptSourceWatcher,
    } = ctx

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
          failure.operation.type === 'replace' && failure.kind === 'no_match',
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
    // `MAX_FILE_SIZE_BYTES`（`../tool-args.ts`）作为"快照阈值"：当编辑前或编辑后的
    // 内容超过阈值时，跳过 undo/review 快照与 diff（避免把超大内容读进快照存储），
    // 与 fs_write 覆盖超大文件时的行为对齐。必须同时看 before(content) 与
    // after(appliedContent)，因为小文件也可能被编辑后膨胀到阈值以上。
    const overSized =
      content.length > MAX_FILE_SIZE_BYTES ||
      appliedContent.length > MAX_FILE_SIZE_BYTES
    const metadata: LocalToolCallResultMetadata | undefined = overSized
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
  },
})
