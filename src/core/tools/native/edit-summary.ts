import { buildFileChangeSummary } from '../file-editing-support'
import type { LocalToolCallResultMetadata, ToolContext } from '../types'

import { getVaultBasePath, toEditSummaryPath } from './paths'
import { isDecodableAsText } from './text'

/**
 * The diff card for a native write. Same `editSummary` the vault-backed
 * `fs_write` / `fs_edit` produce — the chat surface has exactly one edit-card,
 * undo and review path, and a native edit joins it rather than growing a
 * second one.
 *
 * The only thing that differs is the recorded path: {@link toEditSummaryPath}
 * hands back the vault-relative form for a file inside the vault, so undo and
 * review reach it through the ordinary `TFile` route.
 */
export const buildNativeFileChangeSummary = async ({
  ctx,
  absolutePath,
  beforeContent,
  afterContent,
  beforeExists,
  afterExists,
  appliedAt,
}: {
  ctx: ToolContext
  absolutePath: string
  beforeContent: string
  afterContent: string
  beforeExists: boolean
  afterExists: boolean
  appliedAt: number
}): Promise<LocalToolCallResultMetadata | undefined> =>
  buildFileChangeSummary({
    app: ctx.app,
    path: nativeEditSummaryPath(ctx, absolutePath),
    beforeContent,
    afterContent,
    beforeExists,
    afterExists,
    conversationId: ctx.conversationId,
    roundId: ctx.roundId,
    toolCallId: ctx.toolCallId,
    appliedAt,
  })

/** The path the snapshot, the card, and `promptSourceWatcher` all key on. */
export const nativeEditSummaryPath = (
  ctx: ToolContext,
  absolutePath: string,
): string => toEditSummaryPath(absolutePath, getVaultBasePath(ctx.app))

/**
 * 为了产出摘要而愿意把改前文件整份读进内存的上限。
 *
 * 摘要本身只需要 2MB 以内的内容（评审快照的 `MAX_SNAPSHOT_CONTENT_CHARS`，
 * 超过就只记行数不存正文），但「读多少」和「存多少」是两件事：读到 2MB 就停，就永远
 * 产不出「有行数、评审不可用」的卡片，覆盖一个 5MB 文件会变成完全没有卡片。取
 * 16MB 与 `fs_edit` 的 `MAX_EDIT_FILE_SIZE_BYTES` 同值同理由——那是这个仓库
 * 认可的「整份读进内存」绝对上限。
 */
const MAX_SNAPSHOT_SOURCE_BYTES = 16 * 1024 * 1024

/**
 * 改前内容，`null` 表示这次编辑没法做快照：文件大到不该整份读进内存，或者它
 * 根本不是文本（把二进制按 UTF-8 解出来再让「撤销」写回去，写回的就不是原来
 * 那些字节了）。调用方据此跳过摘要，而不是拿一份错内容去建快照。
 */
export const readNativeSnapshotSource = async (
  fs: typeof import('node:fs/promises'),
  absolutePath: string,
  byteSize: number,
): Promise<string | null> => {
  if (byteSize > MAX_SNAPSHOT_SOURCE_BYTES) {
    return null
  }
  const bytes = new Uint8Array(await fs.readFile(absolutePath))
  if (!isDecodableAsText(bytes)) {
    return null
  }
  return new TextDecoder().decode(bytes)
}
