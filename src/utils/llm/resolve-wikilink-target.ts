import { App, type HeadingCache, TFile, resolveSubpath } from 'obsidian'

// Resolves an Obsidian wikilink-style fs_read target (bare "Note", "[[Note]]",
// "![[Note]]", optionally carrying "|alias" and a "#heading" / "#^block"
// subpath) to a vault file and, when a subpath is present and resolvable, a
// 1-based inclusive line range within that file.
//
// This is the read-side counterpart to collectWikilinkPaths (which annotates
// links found *inside* already-read content): this module resolves a link
// that *is* the read target itself, i.e. the entry the caller wants read.

export type WikilinkReadSubpath =
  | { type: 'heading'; startLine: number; endLine: number }
  | { type: 'block'; startLine: number; endLine: number }

export type WikilinkReadTarget = {
  file: TFile
  subpath?: WikilinkReadSubpath
  // Set when a subpath was present in the raw target but could not be
  // resolved (unknown heading/block, or the file has no subpath-addressable
  // metadata cache e.g. it isn't markdown). The file itself still resolved,
  // so callers should fall back to a full-file read with a warning rather
  // than failing the entry outright.
  subpathError?: string
}

const WIKILINK_WRAPPER_RE = /^!?\[\[([\s\S]+)\]\]$/

function stripWikilinkWrapper(raw: string): string {
  const trimmed = raw.trim()
  const match = trimmed.match(WIKILINK_WRAPPER_RE)
  return match ? match[1] : trimmed
}

/**
 * Finds the first heading at or above `current`'s level that starts after
 * `current`, and returns its 0-based start line — i.e. the line (converted
 * to 1-based below) immediately before which the current heading's section
 * ends. Deeper sub-headings are skipped, so the section naturally includes
 * all of its nested sub-sections. Returns null when no such heading exists
 * (current heading's section runs to end of file).
 *
 * Computed independently from `cache.headings` rather than trusting
 * resolveSubpath's `next`/`end` fields verbatim: obsidian.d.ts types `next`
 * as non-nullable `HeadingCache` (clearly inaccurate for the last heading in
 * a file) and doesn't document whether `end` already skips nested
 * sub-headings, so recomputing here is the only way to guarantee the exact
 * "next same-or-shallower heading" semantic this feature needs.
 */
function findHeadingSectionEndLine(
  headings: HeadingCache[],
  current: HeadingCache,
): number | null {
  const currentIndex = headings.findIndex(
    (h) => h.position.start.line === current.position.start.line,
  )
  if (currentIndex === -1) return null
  for (let i = currentIndex + 1; i < headings.length; i++) {
    if (headings[i].level <= current.level) {
      return headings[i].position.start.line
    }
  }
  return null
}

function resolveSubpathToLineRange(
  app: App,
  file: TFile,
  subpathText: string,
): WikilinkReadSubpath | null {
  if (file.extension !== 'md') return null
  const cache = app.metadataCache.getFileCache(file)
  if (!cache) return null
  const result = resolveSubpath(cache, subpathText)
  if (!result) return null

  if (result.type === 'heading') {
    const startLine = result.current.position.start.line + 1
    const headings = cache.headings ?? []
    const nextStartLine0Based = findHeadingSectionEndLine(
      headings,
      result.current,
    )
    // A next-heading 0-based start line numerically equals the 1-based line
    // number immediately before it, so no extra +/-1 is needed here.
    const endLine = nextStartLine0Based ?? Number.MAX_SAFE_INTEGER
    return { type: 'heading', startLine, endLine }
  }

  if (result.type === 'block') {
    return {
      type: 'block',
      startLine: result.block.position.start.line + 1,
      endLine: result.block.position.end.line + 1,
    }
  }

  // Footnote subpaths aren't part of this feature's scope — treat as
  // unresolved so the caller falls back to a full-file read.
  return null
}

/**
 * Resolves a raw fs_read `paths[]` entry as an Obsidian wikilink target.
 *
 * `sourcePath` mirrors the link-resolution context Obsidian uses for real
 * wikilinks: passing the linking note's path enables relative/shortest-path
 * resolution consistent with `app.metadataCache.getFirstLinkpathDest`.
 * Omitting it (or passing '') resolves against the vault-wide best match.
 *
 * Returns null when the base link path does not resolve to any vault file.
 */
export function resolveWikilinkReadTarget(
  app: App,
  raw: string,
  sourcePath?: string,
): WikilinkReadTarget | null {
  const stripped = stripWikilinkWrapper(raw)
  const withoutAlias = stripped.split('|')[0]
  const hashIndex = withoutAlias.indexOf('#')
  const baseLinkPath =
    hashIndex === -1 ? withoutAlias : withoutAlias.slice(0, hashIndex)
  const subpathText = hashIndex === -1 ? '' : withoutAlias.slice(hashIndex)

  const trimmedBase = baseLinkPath.trim()
  if (trimmedBase.length === 0) return null

  const file = app.metadataCache.getFirstLinkpathDest(
    trimmedBase,
    sourcePath ?? '',
  )
  if (!file) return null

  if (subpathText.length === 0) {
    return { file }
  }

  const subpath = resolveSubpathToLineRange(app, file, subpathText)
  if (!subpath) {
    return {
      file,
      subpathError: `Subpath "${subpathText}" was not found in "${file.path}".`,
    }
  }
  return { file, subpath }
}
