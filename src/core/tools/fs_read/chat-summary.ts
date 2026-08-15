import { asStringArray } from '../chat-summary-support'

/**
 * Chat-surface summary for `fs_read` — ported verbatim from the
 * `toolName === 'fs_read'` branch of `ToolMessage.tsx`'s private
 * `getLocalToolSummaryText` (pre-D8). Wired into `TOOL_RENDERERS` as this
 * tool's `summary` field (phase2-migration.md D8).
 *
 * Note this is only the base "which paths" summary — `getHeadlineDisplayInfo`
 * (`ToolMessage.tsx`) layers response-dependent enrichment on top (read-mode
 * suffix, or the skill-name override) that a pure `args -> string` function
 * structurally cannot express, since it needs the tool *response*, not just
 * its arguments. That enrichment stays in `ToolMessage.tsx`, untouched by
 * D8 — see phase2-migration.md D8's scope note.
 */
const FS_READ_VISIBLE_PATH_LIMIT_BEFORE_OMISSION = 4

const summarizeFsReadPaths = (paths: string[]): string => {
  if (paths.length <= FS_READ_VISIBLE_PATH_LIMIT_BEFORE_OMISSION) {
    return paths.join(', ')
  }

  const visiblePaths = paths.slice(
    0,
    FS_READ_VISIBLE_PATH_LIMIT_BEFORE_OMISSION,
  )
  const hiddenCount = paths.length - visiblePaths.length
  return `${visiblePaths.join(', ')} +${hiddenCount}`
}

export const getFsReadChatSummary = ({
  argumentsObject,
}: {
  argumentsObject: Record<string, unknown> | null
}): string | undefined => {
  const paths = asStringArray(argumentsObject?.paths)
  if (!paths || paths.length === 0) {
    return undefined
  }
  return summarizeFsReadPaths(paths)
}
