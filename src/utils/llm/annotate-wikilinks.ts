import { App } from 'obsidian'

// Annotate Obsidian wikilinks with their resolved vault paths so the LLM
// knows where each linked note actually lives. Image embeds (`![[...]]`) are
// skipped — those are handled by extractMarkdownImages. Unresolved links are
// left untouched.
export function annotateWikilinksWithPaths(
  app: App,
  content: string,
  sourcePath: string,
): string {
  return content.replace(
    /(?<!!)\[\[([^\]|]+?)(\|[^\]]*)?\]\]/g,
    (match, linkText: string) => {
      const baseLinkPath = linkText.split('#')[0].trim()
      if (!baseLinkPath) return match
      const resolved = app.metadataCache.getFirstLinkpathDest(
        baseLinkPath,
        sourcePath,
      )
      if (!resolved) return match
      return `${match}(${resolved.path})`
    },
  )
}
