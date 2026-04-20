import { App } from 'obsidian'

export type WikilinkResolution = {
  link: string
  path: string
}

// Collects Obsidian wikilinks that appear in the given content and resolves
// each to its vault path. Image embeds (`![[...]]`) are skipped — those are
// handled by extractMarkdownImages. Unresolved links are omitted so the agent
// can distinguish "resolved → has path" vs "unresolved → missing from index".
//
// Returns at most one entry per distinct base link path (alias and anchor are
// stripped, since resolution only depends on the base path).
export function collectWikilinkPaths(
  app: App,
  content: string,
  sourcePath: string,
): WikilinkResolution[] {
  const results: WikilinkResolution[] = []
  const seen = new Set<string>()
  const regex = /(?<!!)\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    const baseLinkPath = match[1].split('#')[0].trim()
    if (!baseLinkPath || seen.has(baseLinkPath)) continue
    const resolved = app.metadataCache.getFirstLinkpathDest(
      baseLinkPath,
      sourcePath,
    )
    if (!resolved) continue
    seen.add(baseLinkPath)
    results.push({ link: baseLinkPath, path: resolved.path })
  }
  return results
}
