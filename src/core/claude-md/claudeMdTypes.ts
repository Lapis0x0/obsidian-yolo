export type DiscoveredFile = {
  path: string
  type: 'project' | 'rule'
}

export type ParsedFrontmatter = {
  content: string
  paths?: string[]
}

export type ParsedMemoryFile = {
  filePath: string
  content: string
  paths?: string[]
}

export type CacheEntry = {
  rawContent: string
  mtime: number
  parsed: ParsedMemoryFile
}

export const CLAUDE_MD_FILENAME = 'CLAUDE.md'
export const CLAUDE_RULES_DIR = '.claude/rules'
export const MAX_INCLUDE_DEPTH = 5
export const MAX_RULE_FILE_LINES = 500
export const MAX_CACHE_SIZE = 100
