/**
 * Formats a string of integer digits with locale-style grouping (e.g. 50000 → 50,000).
 * Empty string stays empty. Used for large token counts in settings inputs.
 */
export function formatIntegerWithGrouping(value: string): string {
  if (value.length === 0) {
    return ''
  }

  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0,
    useGrouping: true,
  }).format(Number(value))
}
