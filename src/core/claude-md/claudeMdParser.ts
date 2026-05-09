// src/core/claude-md/claudeMdParser.ts
import { type Token, marked } from 'marked'
import { normalizePath } from 'obsidian'
import { dirname, isAbsolute, join } from 'path-browserify'

import { MAX_INCLUDE_DEPTH } from './claudeMdTypes'

export function stripHtmlComments(content: string): {
  content: string
  stripped: boolean
} {
  if (!content.includes('<!--')) {
    return { content, stripped: false }
  }

  const tokens = marked.lexer(content, { gfm: false })
  const segments: string[] = []
  let stripped = false

  for (const token of tokens) {
    if (token.type === 'html') {
      const htmlText = token.text
      if (htmlText.includes('<!--')) {
        const closedMatch = htmlText.match(/^<!--[\s\S]*?-->/)
        if (closedMatch) {
          stripped = true
          const residual = htmlText.slice(closedMatch[0].length)
          if (residual.trim()) {
            segments.push(residual)
          }
          continue
        }
        // Unclosed comment — preserve as-is
      }
    }
    if (token.type === 'code' || token.type === 'codespan') {
      segments.push(token.raw)
      continue
    }
    if ('tokens' in token && Array.isArray(token.tokens)) {
      let hasHtmlComment = false
      for (const sub of token.tokens) {
        if (sub.type === 'html') {
          const htmlText = sub.text
          if (htmlText.includes('<!--')) {
            const closedMatch = htmlText.match(/^<!--[\s\S]*?-->/)
            if (closedMatch) {
              hasHtmlComment = true
              stripped = true
              const residual = htmlText.slice(closedMatch[0].length)
              if (residual.trim()) {
                segments.push(residual)
              }
              continue
            }
          }
        }
        if (sub.raw) {
          segments.push(sub.raw)
        }
      }
      if (hasHtmlComment) {
        continue
      }
    }
    if (token.raw) {
      segments.push(token.raw)
    }
  }

  if (!stripped) {
    return { content, stripped: false }
  }

  // Reconstruct from raw token segments; relies on marked token.raw preserving original text.
  return { content: segments.join(''), stripped: true }
}

export function parseFrontmatterPaths(rawContent: string): {
  content: string
  paths?: string[]
} {
  if (!rawContent.startsWith('---\n')) {
    return { content: rawContent }
  }

  const closingIndex = rawContent.indexOf('\n---\n', 4)
  if (closingIndex === -1) {
    return { content: rawContent }
  }

  const frontmatterText = rawContent.slice(4, closingIndex)
  const bodyContent = rawContent.slice(closingIndex + 5)

  let frontmatter: Record<string, unknown>
  try {
    frontmatter = parseYamlFrontmatter(frontmatterText)
  } catch {
    try {
      const quoted = quoteProblematicValues(frontmatterText)
      frontmatter = parseYamlFrontmatter(quoted)
    } catch {
      return { content: bodyContent }
    }
  }

  if (!frontmatter.paths) {
    return { content: bodyContent }
  }

  // Convert paths to array and expand braces FIRST (before splitting on commas)
  let expanded: string[]
  if (Array.isArray(frontmatter.paths)) {
    expanded = frontmatter.paths.flatMap((p) =>
      typeof p === 'string' ? expandBraces(p) : [],
    )
  } else if (typeof frontmatter.paths === 'string') {
    expanded = expandBraces(frontmatter.paths)
  } else {
    expanded = []
  }

  // Split on commas (for comma-separated paths)
  const rawPaths = expanded.flatMap((p) => p.split(',').map((s) => s.trim()))

  const cleaned = rawPaths
    .map((p) => {
      // Only strip /** if there's at least one slash before it (e.g., src/core/** → src/core)
      // Don't strip for simple patterns like a/** or b/**
      if (!p.endsWith('/**')) return p
      const withoutSuffix = p.slice(0, -3)
      return withoutSuffix.includes('/') ? withoutSuffix : p
    })
    .filter((p) => p.length > 0)

  if (cleaned.length === 0 || cleaned.every((p) => p === '**')) {
    return { content: bodyContent }
  }

  return { content: bodyContent, paths: cleaned }
}

function parseYamlFrontmatter(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = text.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const kvMatch = lines[i].match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!kvMatch) continue
    const key = kvMatch[1]
    const rawValue = kvMatch[2].trim()

    if (rawValue === '') {
      const items: string[] = []
      for (let j = i + 1; j < lines.length; j++) {
        const itemMatch = lines[j].match(/^\s+-\s+(.+)$/)
        if (!itemMatch) break
        items.push(itemMatch[1].trim())
      }
      if (items.length > 0) {
        result[key] = items
      }
    } else {
      result[key] = stripWrappingQuotes(rawValue)
    }
  }
  return result
}

function quoteProblematicValues(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const kvMatch = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/)
      if (!kvMatch) return line
      const key = kvMatch[1]
      const value = kvMatch[2]
      if (/^["']/.test(value)) return line
      if (/[{}[\]*,&#!|>%@`]/.test(value)) {
        return `${key}: "${value}"`
      }
      return line
    })
    .join('\n')
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function expandBraces(pattern: string): string[] {
  const openIdx = pattern.indexOf('{')
  if (openIdx === -1) return [pattern]

  const closeIdx = pattern.lastIndexOf('}')
  if (closeIdx === -1 || closeIdx <= openIdx) return [pattern]

  const before = pattern.slice(0, openIdx)
  const after = pattern.slice(closeIdx + 1)
  const inner = pattern.slice(openIdx + 1, closeIdx)
  const alternatives = inner.split(',').map((s) => s.trim())

  return alternatives.flatMap((alt) => expandBraces(before + alt + after))
}

export function extractIncludePaths(content: string): string[] {
  const tokens = marked.lexer(content, { gfm: false })
  const paths: string[] = []

  function walkTokens(tokenList: Token[]): void {
    for (const token of tokenList) {
      if (token.type === 'code' || token.type === 'codespan') {
        continue
      }
      if (token.type === 'html') {
        continue
      }
      if ('text' in token && typeof token.text === 'string') {
        const regex = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g
        let match: RegExpExecArray | null
        while ((match = regex.exec(token.text)) !== null) {
          let path = match[1]
          const hashIdx = path.indexOf('#')
          if (hashIdx !== -1) {
            path = path.slice(0, hashIdx)
          }
          if (path.length > 0) {
            paths.push(path)
          }
        }
      }
      if ('tokens' in token && Array.isArray(token.tokens)) {
        walkTokens(token.tokens)
      }
      if ('items' in token && Array.isArray(token.items)) {
        walkTokens(token.items as Token[])
      }
    }
  }

  walkTokens(tokens)
  return paths
}

export function resolveIncludePath({
  includePath,
  currentFilePath,
  vaultRoot,
}: {
  includePath: string
  currentFilePath: string
  vaultRoot: string
}): string | null {
  let resolved: string

  if (includePath.startsWith('~/')) {
    resolved = includePath.slice(2)
  } else if (includePath.startsWith('./') || !includePath.startsWith('/')) {
    const dir = dirname(currentFilePath)
    resolved = join(dir, includePath)
  } else {
    if (vaultRoot) {
      if (!includePath.startsWith(vaultRoot)) {
        return null
      }
      resolved = includePath.slice(vaultRoot.length)
    } else {
      return null
    }
  }

  const normalized = normalizePath(resolved)
  if (normalized.startsWith('..') || isAbsolute(normalized)) {
    return null
  }

  return normalized
}

export async function processIncludes({
  content,
  currentFilePath,
  fileReader,
  processedPaths,
  depth,
  vaultRoot,
}: {
  content: string
  currentFilePath: string
  fileReader: (path: string) => Promise<string | null>
  processedPaths: Set<string>
  depth: number
  vaultRoot: string
}): Promise<string> {
  if (depth >= MAX_INCLUDE_DEPTH) {
    return content
  }

  processedPaths.add(normalizePath(currentFilePath))

  const includePaths = extractIncludePaths(content)
  if (includePaths.length === 0) {
    return content
  }

  let result = content

  for (const rawPath of includePaths) {
    const resolvedPath = resolveIncludePath({
      includePath: rawPath,
      currentFilePath,
      vaultRoot,
    })
    if (!resolvedPath) continue

    const normalized = normalizePath(resolvedPath)
    if (processedPaths.has(normalized)) continue

    const includedContent = await fileReader(resolvedPath)
    if (includedContent === null) {
      // Remove the include reference for non-existent files (including surrounding newlines)
      const escapedPath = rawPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const regex = new RegExp(`(?:\\n?|^)@${escapedPath}(?:\\n?|$)`, 'g')
      result = result.replace(regex, '\n').replace(/\n+/g, '\n')
      continue
    }

    processedPaths.add(normalized)

    const expandedContent = await processIncludes({
      content: includedContent,
      currentFilePath: resolvedPath,
      fileReader,
      processedPaths,
      depth: depth + 1,
      vaultRoot,
    })

    const escapedPath = rawPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`@${escapedPath}`, 'g')
    result = result.replace(regex, expandedContent)
  }

  return result
}
