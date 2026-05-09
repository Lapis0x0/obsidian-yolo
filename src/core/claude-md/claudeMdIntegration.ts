// src/core/claude-md/claudeMdIntegration.ts
import { minimatch } from 'minimatch'
import { App, normalizePath } from 'obsidian'

import { ClaudeMdCache } from './claudeMdCache'
import { discoverProjectContextFiles } from './claudeMdDiscovery'
import {
  parseFrontmatterPaths,
  processIncludes,
  stripHtmlComments,
} from './claudeMdParser'
import { MAX_RULE_FILE_LINES, type ParsedMemoryFile } from './claudeMdTypes'

const cache = new ClaudeMdCache()

const OVERRIDE_HEADER =
  'Codebase and user instructions are shown below. Be sure to adhere to these instructions. ' +
  'These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.'

const FILE_TOOLS = new Set([
  'fs_read',
  'fs_edit',
  'fs_create_file',
  'fs_delete_file',
  'fs_move',
])

export function clearClaudeMdCache(): void {
  cache.clear()
}

async function loadAndParseFileWithIncludes(
  app: App,
  filePath: string,
  processedPaths: Set<string>,
): Promise<ParsedMemoryFile | null> {
  try {
    const stat = await app.vault.adapter.stat(filePath)
    if (!stat) return null

    // Check cache first
    const cached = await cache.getOrLoad(app, filePath, (rawContent) => ({
      filePath,
      content: rawContent,
    }))
    if (!cached) return null

    // Process @includes (async)
    const fileReader = async (path: string): Promise<string | null> => {
      try {
        return await app.vault.adapter.read(path)
      } catch {
        return null
      }
    }

    const expandedContent = await processIncludes({
      content: cached.content,
      currentFilePath: filePath,
      fileReader,
      processedPaths,
      depth: 0,
      vaultRoot: '',
    })

    // Strip HTML comments
    const commentResult = stripHtmlComments(expandedContent)
    const contentAfterComments = commentResult.content

    // Parse frontmatter
    const parsed = parseFrontmatterPaths(contentAfterComments)
    let finalContent = parsed.content.trim()

    // Truncate
    const lines = finalContent.split('\n')
    if (lines.length > MAX_RULE_FILE_LINES) {
      finalContent =
        lines.slice(0, MAX_RULE_FILE_LINES).join('\n') + '\n[truncated]'
    }

    return {
      filePath,
      content: finalContent,
      paths: parsed.paths,
    }
  } catch {
    console.warn('[claude-md] Failed to parse:', filePath)
    return null
  }
}

function formatFileSection(
  filePath: string,
  content: string,
  vaultName?: string,
): string {
  const prefix = vaultName ? `${vaultName}/` : ''
  return `Contents of ${prefix}${filePath}\n${content}`
}

export async function getProjectContext(
  app: App,
  enabled = true,
): Promise<string> {
  if (!enabled) return ''
  const discovered = discoverProjectContextFiles(app)
  if (discovered.length === 0) return ''

  const vaultName = app.vault.getName()
  const processedPaths = new Set<string>()
  const unconditionalParts: string[] = []

  for (const file of discovered) {
    const parsed = await loadAndParseFileWithIncludes(
      app,
      file.path,
      processedPaths,
    )
    if (!parsed || !parsed.content) continue

    // Only include unconditional files (no paths frontmatter)
    if (parsed.paths) continue

    unconditionalParts.push(
      formatFileSection(file.path, parsed.content, vaultName),
    )
  }

  if (unconditionalParts.length === 0) return ''

  return `${OVERRIDE_HEADER}\n\n${unconditionalParts.join('\n\n')}`
}

export async function getConditionalRules(
  app: App,
  targetPath: string,
  injectedPaths: Set<string>,
  enabled = true,
): Promise<string> {
  if (!enabled) return ''
  const discovered = discoverProjectContextFiles(app)
  const vaultName = app.vault.getName()
  const processedPaths = new Set<string>()
  const matchedParts: string[] = []

  const normalizedTarget = normalizePath(targetPath)

  for (const file of discovered) {
    if (injectedPaths.has(file.path)) continue

    const parsed = await loadAndParseFileWithIncludes(
      app,
      file.path,
      processedPaths,
    )
    if (!parsed || !parsed.content || !parsed.paths) continue

    const matches = parsed.paths.some((pattern) =>
      minimatch(normalizedTarget, pattern),
    )
    if (!matches) continue

    injectedPaths.add(file.path)
    matchedParts.push(formatFileSection(file.path, parsed.content, vaultName))
  }

  return matchedParts.join('\n\n')
}

export { FILE_TOOLS }
