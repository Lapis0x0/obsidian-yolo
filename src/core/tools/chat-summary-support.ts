/**
 * Small pure helpers shared by more than one tool's chat-surface summary
 * function (see each `<tool>/chat-summary.ts`). Neither of these depends on
 * React or anything under `src/components/` — per
 * docs/plans/2026-08-15-tool-registry/phase2-migration.md D8, a tool's
 * summary function is a plain `args -> string | undefined` function, so its
 * shared building blocks stay just as plain.
 *
 * Ported verbatim from the private helpers of the same name in
 * `ToolMessage.tsx` (pre-D8), which is where the equivalent logic lived
 * before the by-name `if` chain there (`getLocalToolSummaryText`) was
 * replaced by a lookup into `TOOL_RENDERERS`.
 */

/** Used by every tool whose summary truncates a single string value
 * (web_search's query, web_scrape's url, js_eval's code preview, ...). */
export const truncateText = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, maxLength - 1)}...`
}

/** Used by `fs_read` (its `paths` argument) and `load_tool_schemas` (its
 * `servers` argument) — both take a string-array argument for their
 * summary. */
export const asStringArray = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) {
    return null
  }
  if (value.some((item) => typeof item !== 'string')) {
    return null
  }
  return value
}
