// src/core/claude-md/claudeMdDiscovery.ts
import { App, TFile } from 'obsidian'

import {
  CLAUDE_MD_FILENAME,
  CLAUDE_RULES_DIR,
  DiscoveredFile,
} from './claudeMdTypes'

export function discoverProjectContextFiles(app: App): DiscoveredFile[] {
  const results: DiscoveredFile[] = []

  // Level 1: vault root CLAUDE.md
  const claudeMdFile = app.vault.getAbstractFileByPath(CLAUDE_MD_FILENAME)
  if (claudeMdFile instanceof TFile) {
    results.push({ path: CLAUDE_MD_FILENAME, type: 'project' })
  }

  // Level 2: .claude/rules/*.md
  const rulesPrefix = CLAUDE_RULES_DIR + '/'
  const ruleFiles = app.vault
    .getMarkdownFiles()
    .filter(
      (file) =>
        file.path.startsWith(rulesPrefix) &&
        file.path.slice(rulesPrefix.length).length > 0,
    )
    .map((file): DiscoveredFile => ({ path: file.path, type: 'rule' }))
    .sort((a, b) => a.path.localeCompare(b.path))

  results.push(...ruleFiles)

  return results
}
