/**
 * Edit block parser and applier for edit mode.
 *
 * Supports three formats:
 *
 * 1. CONTINUE - Append to end of document:
 * <<<<<<< CONTINUE
 * =======
 * [content to append]
 * >>>>>>> CONTINUE
 *
 * 2. REPLACE - Replace existing text:
 * <<<<<<< SEARCH
 * [exact text to find]
 * =======
 * [replacement text]
 * >>>>>>> REPLACE
 *
 * 3. INSERT AFTER - Insert after specific text:
 * <<<<<<< INSERT AFTER
 * [exact text to find]
 * =======
 * [content to insert]
 * >>>>>>> INSERT
 */

export type EditBlockType = 'continue' | 'replace' | 'insert'

export type SearchReplaceBlock = {
  type: EditBlockType
  search: string // empty for 'continue'
  replace: string
}

export type ApplyResult = {
  newContent: string
  errors: string[]
  appliedCount: number
}

/**
 * Parse edit blocks from model output.
 *
 * Supports CONTINUE, REPLACE (SEARCH), and INSERT AFTER formats.
 *
 * @param content - The raw model output containing edit blocks
 * @returns Array of parsed blocks
 */
export function parseSearchReplaceBlocks(
  content: string,
): SearchReplaceBlock[] {
  const blocks: SearchReplaceBlock[] = []

  // Match CONTINUE blocks
  // Pattern: <<<<<<< CONTINUE\n=======\n...\n>>>>>>> CONTINUE
  const continuePattern =
    /<<<<<<< CONTINUE\n=======\n([\s\S]*?)\n>>>>>>> CONTINUE/g
  let match: RegExpExecArray | null
  while ((match = continuePattern.exec(content)) !== null) {
    blocks.push({
      type: 'continue',
      search: '',
      replace: match[1],
    })
  }

  // Match INSERT AFTER blocks
  // Pattern: <<<<<<< INSERT AFTER\n...\n=======\n...\n>>>>>>> INSERT
  const insertPattern =
    /<<<<<<< INSERT AFTER\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> INSERT/g
  while ((match = insertPattern.exec(content)) !== null) {
    blocks.push({
      type: 'insert',
      search: match[1],
      replace: match[2],
    })
  }

  // Match SEARCH/REPLACE blocks
  // Pattern: <<<<<<< SEARCH\n...\n=======\n...\n>>>>>>> REPLACE
  const replacePattern =
    /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g
  while ((match = replacePattern.exec(content)) !== null) {
    blocks.push({
      type: 'replace',
      search: match[1],
      replace: match[2],
    })
  }

  return blocks
}

/**
 * Apply edit blocks to original content.
 *
 * Blocks are applied sequentially. Each subsequent block operates on
 * the result of the previous operation.
 *
 * Supports three types:
 * - 'continue': Append content to the end
 * - 'insert': Insert content after specified text
 * - 'replace': Replace specified text
 *
 * @param originalContent - The original document content
 * @param blocks - Array of edit blocks to apply
 * @returns Object containing new content, errors, and count of applied blocks
 */
export function applySearchReplaceBlocks(
  originalContent: string,
  blocks: SearchReplaceBlock[],
): ApplyResult {
  let content = originalContent
  const errors: string[] = []
  let appliedCount = 0

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]

    // Handle CONTINUE: append to end of document
    if (block.type === 'continue') {
      // Add newlines if content doesn't end with one
      const separator = content.endsWith('\n') ? '\n' : '\n\n'
      content = content + separator + block.replace
      appliedCount++
      continue
    }

    const searchText = block.search

    // Handle INSERT: insert after specified text
    if (block.type === 'insert') {
      if (content.includes(searchText)) {
        // Insert after the found text
        content = content.replace(
          searchText,
          searchText + '\n\n' + block.replace,
        )
        appliedCount++
      } else {
        // Try fuzzy matching by trimming whitespace
        const trimmedSearch = searchText.trim()
        const lines = content.split('\n')
        let found = false

        for (let j = 0; j < lines.length; j++) {
          if (lines[j].trim() === trimmedSearch) {
            // Found a trimmed match - insert after this line
            lines.splice(j + 1, 0, '', block.replace.trim())
            content = lines.join('\n')
            appliedCount++
            found = true
            break
          }
        }

        if (!found) {
          const preview =
            searchText.length > 50
              ? searchText.substring(0, 50) + '...'
              : searchText
          errors.push(
            `Block ${i + 1} (INSERT): Could not find text to insert after: "${preview}"`,
          )
        }
      }
      continue
    }

    // Handle REPLACE: replace existing text
    if (block.type === 'replace') {
      if (content.includes(searchText)) {
        // Replace only the first occurrence
        content = content.replace(searchText, block.replace)
        appliedCount++
      } else {
        // Try fuzzy matching by trimming whitespace
        const trimmedSearch = searchText.trim()
        const lines = content.split('\n')
        let found = false

        // Try to find a line-by-line match with trimmed content
        for (let j = 0; j < lines.length; j++) {
          if (lines[j].trim() === trimmedSearch) {
            // Found a trimmed match - use original whitespace
            const originalLine = lines[j]
            const leadingWhitespace = originalLine.match(/^(\s*)/)?.[1] ?? ''
            lines[j] = leadingWhitespace + block.replace.trim()
            content = lines.join('\n')
            appliedCount++
            found = true
            break
          }
        }

        if (!found) {
          // Record error with preview of search text
          const preview =
            searchText.length > 50
              ? searchText.substring(0, 50) + '...'
              : searchText
          errors.push(
            `Block ${i + 1} (REPLACE): Could not find text to replace: "${preview}"`,
          )
        }
      }
    }
  }

  return {
    newContent: content,
    errors,
    appliedCount,
  }
}

/**
 * Validate that the model output contains valid edit blocks.
 *
 * @param content - The raw model output
 * @returns true if at least one valid block is found
 */
export function hasValidSearchReplaceBlocks(content: string): boolean {
  return parseSearchReplaceBlocks(content).length > 0
}
