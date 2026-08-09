/**
 * Context budget for the virtual (vault) bash tool's final output.
 *
 * Truncation applies to the stdout/stderr a finished command returns to the
 * model — never to intermediate pipeline data. `ls | wc -l` internally sees
 * every line and returns one; only what would actually enter the model's
 * context is bounded. Head-only: the head plus an accurate total in the
 * notice carries more signal than a head+tail sandwich, and cannot be
 * misread as contiguous output.
 */

export type BashOutputBudget = Readonly<{
  maxLines: number
  maxChars: number
  /** Stream label used in the truncation notice, e.g. 'output' or 'stderr'. */
  label: string
  /** Steering appended to the notice on the primary stream. */
  guidance?: string
}>

export const VAULT_BASH_STDOUT_BUDGET: BashOutputBudget = {
  maxLines: 300,
  maxChars: 16_000,
  label: 'output',
  // Deliberately steers to glob/head/search/wc and not grep: the vault bash
  // advertises `search` (hybrid RAG + keyword) as its lookup path, and this
  // notice is the highest-salience steering surface the tool has.
  guidance:
    'Narrow with a glob (e.g. ls *.png) or head, use `search` to find files or content, or wc -l for counts.',
}

export const VAULT_BASH_STDERR_BUDGET: BashOutputBudget = {
  maxLines: 100,
  maxChars: 4_000,
  label: 'stderr',
}

export function truncateBashOutputForContext(
  output: string,
  budget: BashOutputBudget,
): string {
  const lines = output.split('\n')
  const totalLines = output.endsWith('\n') ? lines.length - 1 : lines.length
  if (totalLines <= budget.maxLines && output.length <= budget.maxChars) {
    return output
  }

  let head = lines.slice(0, budget.maxLines).join('\n')
  if (head.length > budget.maxChars) {
    head = head.slice(0, budget.maxChars)
  }
  const shownLines = head.length === 0 ? 0 : head.split('\n').length
  const guidanceSuffix = budget.guidance ? ` ${budget.guidance}` : ''
  const notice = `[${budget.label} truncated: showing first ${shownLines} of ${totalLines} lines (${output.length} chars total).${guidanceSuffix}]`
  return head.length === 0 ? notice : `${head}\n${notice}`
}
