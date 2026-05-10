import { App, TFile } from 'obsidian'

const PROJECT_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md']

export async function getProjectInstructionsSection(
  app: App,
  enabled: boolean,
): Promise<string> {
  if (!enabled) return ''

  const parts: string[] = []
  for (const name of PROJECT_INSTRUCTION_FILES) {
    try {
      const file = app.vault.getAbstractFileByPath(name)
      if (!(file instanceof TFile)) continue
      const content = (await app.vault.cachedRead(file)).trim()
      if (content.length === 0) continue
      parts.push(`## ${name}\n\n${content}`)
    } catch {
      // Vault read errors are non-fatal — skip this file silently.
    }
  }
  if (parts.length === 0) return ''

  return [
    "The user maintains project instructions at the vault root. Treat them as project conventions to follow alongside the system prompt; they do not override system safety policies or the user's current explicit request.",
    parts.join('\n\n'),
  ].join('\n\n')
}
