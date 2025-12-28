/**
 * Escapes special Markdown/HTML characters in generated text to prevent formatting issues.
 * This is particularly important for inline suggestions where angle brackets might be
 * interpreted as HTML tags.
 *
 * @param text - The text to escape
 * @param options - Escape options
 * @returns The escaped text
 */
export function escapeMarkdownSpecialChars(
  text: string,
  options?: {
    escapeAngleBrackets?: boolean
    escapeBackslashes?: boolean
    preserveCodeBlocks?: boolean
  }
): string {
  const {
    escapeAngleBrackets = true,
    escapeBackslashes = false,
    preserveCodeBlocks = true,
  } = options ?? {}

  if (!text) return text

  // If we want to preserve code blocks, we need to extract them first,
  // escape the rest, then put them back
  if (preserveCodeBlocks) {
    const codeBlockRegex = /(`{1,3})[\s\S]*?\1/g
    const codeBlocks: string[] = []
    let index = 0

    // Extract code blocks and replace with placeholders
    const textWithPlaceholders = text.replace(codeBlockRegex, (match) => {
      const placeholder = `__CODE_BLOCK_${index}__`
      codeBlocks[index] = match
      index++
      return placeholder
    })

    // Escape the text (excluding code blocks)
    let escaped = escapeText(textWithPlaceholders, {
      escapeAngleBrackets,
      escapeBackslashes,
    })

    // Restore code blocks
    codeBlocks.forEach((block, i) => {
      escaped = escaped.replace(`__CODE_BLOCK_${i}__`, block)
    })

    return escaped
  }

  return escapeText(text, { escapeAngleBrackets, escapeBackslashes })
}

function escapeText(
  text: string,
  options: {
    escapeAngleBrackets: boolean
    escapeBackslashes: boolean
  }
): string {
  let result = text

  // Escape backslashes first (if enabled) to avoid double-escaping
  if (options.escapeBackslashes) {
    result = result.replace(/\\/g, '\\\\')
  }

  // Escape angle brackets to prevent HTML interpretation
  if (options.escapeAngleBrackets) {
    // Only escape standalone angle brackets that look like they could be HTML tags
    // Pattern: < followed by word characters (potential tag name)
    result = result.replace(/<(\w+)>/g, '\\<$1\\>')

    // Also handle cases like <keyword or value> without closing bracket
    result = result.replace(/(\s|^)<(\w+)/g, '$1\\<$2')
    result = result.replace(/(\w+)>(\s|$)/g, '$1\\>$2')
  }

  return result
}

/**
 * Removes escape characters that were added by escapeMarkdownSpecialChars.
 * Useful for reverting escaped text back to original form.
 *
 * @param text - The escaped text
 * @returns The unescaped text
 */
export function unescapeMarkdownSpecialChars(text: string): string {
  if (!text) return text

  let result = text

  // Unescape angle brackets
  result = result.replace(/\\</g, '<')
  result = result.replace(/\\>/g, '>')

  // Unescape backslashes (do this last to avoid issues)
  result = result.replace(/\\\\/g, '\\')

  return result
}
