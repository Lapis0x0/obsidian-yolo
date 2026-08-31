import type { TFile } from 'obsidian'

import type {
  ApplyViewResult,
  ApplyViewState,
} from '../../../types/apply-view.types'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import {
  type TextEditOperation,
  type TextEditPlan,
  materializeTextEditPlan,
} from '../../edits/textEditEngine'
import { getTextArg } from '../tool-args'

/**
 * `fs_edit`-exclusive helpers (single tool consumer, so — per
 * phase2-migration.md D6 "注意": "谁用它谁收留" — they live in this tool's
 * own directory rather than a shared module). Ported verbatim from
 * `core/mcp/localFileTools.ts` (pre-migration). `localFileTools.ts`'s
 * still-live `case 'fs_edit'` switch branch imports these back from here
 * rather than the reverse — see that file's import block and
 * docs/plans/2026-08-15-tool-registry/master.md D6a.
 */

// fs_edit 读全文做替换的绝对内存防御上限。`MAX_FILE_SIZE_BYTES`（`../tool-args.ts`）
// 是"快照阈值"（超过则跳过 undo/review 快照），本常量是"绝对拒绝上限"（超过才真正拒绝编辑）。
export const MAX_EDIT_FILE_SIZE_BYTES = 16 * 1024 * 1024

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

export const getFsEditPlan = (args: Record<string, unknown>): TextEditPlan => {
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

const offsetToSelectionPosition = (content: string, offset: number) => {
  const clampedOffset = Math.max(0, Math.min(offset, content.length))
  const before = content.slice(0, clampedOffset)
  const lines = before.split('\n')

  return {
    line: Math.max(0, lines.length - 1),
    ch: lines.at(-1)?.length ?? 0,
  }
}

export const getFsEditSelectionRange = (
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

export type FsEditReviewResult =
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

export const waitForFsEditReview = async ({
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

export const buildFsEditReviewPayload = (
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

export const buildFsEditRejectedReason = (): string =>
  'Explicit user decision: this change was rejected in the review UI. This is not an edit or matching failure. Do not retry it with another locator or tool this turn; acknowledge the decision and wait for the user.'
