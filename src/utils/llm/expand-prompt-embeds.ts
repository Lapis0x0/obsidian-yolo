import { App } from 'obsidian'

import {
  type WikilinkReadTarget,
  resolveWikilinkReadTarget,
} from './resolve-wikilink-target'

// Expands Obsidian embed syntax (`![[Note]]`) inside user-authored prompt
// configuration into the linked note's full text, in place.
//
// Scope is deliberately narrow: this runs on the two configuration fields the
// user writes by hand and the model only ever reads — the global system prompt
// and an agent's system prompt. Memory (`MEMORY.md`) is out of scope on
// purpose: the model authors those files itself, so silently splicing another
// file's body into them would invite it to edit content it doesn't own.
//
// The `[[Note]]` reference form is untouched. That split mirrors Obsidian's own
// semantics (embed pulls content in, link only names it) and the convention
// this codebase already follows: `collectWikilinkPaths` annotates `[[...]]` and
// explicitly skips `![[...]]`, and `<memory_rules>` tells the model to relate
// facts with `[[name]]`.

// Obsidian links never span lines and cannot nest brackets.
const EMBED_RE = /!\[\[([^[\]\n]+)\]\]/g

function subpathKeyOf(linkText: string): string {
  const withoutAlias = linkText.split('|')[0]
  const hashIndex = withoutAlias.indexOf('#')
  return hashIndex === -1 ? '' : withoutAlias.slice(hashIndex).trim()
}

function sliceLines(content: string, startLine: number, endLine: number) {
  // Line numbers from resolveWikilinkReadTarget are 1-based inclusive, and
  // `endLine` is MAX_SAFE_INTEGER when the section runs to end of file.
  const lines = content.split('\n')
  return lines.slice(startLine - 1, Math.min(endLine, lines.length)).join('\n')
}

async function readEmbedBody(
  app: App,
  target: WikilinkReadTarget,
): Promise<string | null> {
  // Only markdown is expanded. `![[image.png]]` / `![[paper.pdf]]` stay as
  // written: turning the system prompt into a multimodal payload would mean
  // reshaping the provider-side cache prefix for a case `@` mentions already
  // cover.
  if (target.file.extension !== 'md') return null
  // A subpath that was written but doesn't resolve is left unexpanded rather
  // than falling back to the whole file — the user asked for one section, and
  // guessing that they'd accept the entire note instead is not our call.
  if (target.subpathError) return null

  const content = await app.vault.cachedRead(target.file)
  if (!target.subpath) return content
  return sliceLines(content, target.subpath.startLine, target.subpath.endLine)
}

async function expand(
  app: App,
  content: string,
  sourcePath: string,
  visited: Set<string>,
): Promise<string> {
  const matches = [...content.matchAll(EMBED_RE)]
  if (matches.length === 0) return content

  let out = ''
  let cursor = 0
  for (const match of matches) {
    const matchIndex = match.index ?? 0
    out += content.slice(cursor, matchIndex)
    cursor = matchIndex + match[0].length
    out += (await expandOne(app, match[1], sourcePath, visited)) ?? match[0]
  }
  return out + content.slice(cursor)
}

async function expandOne(
  app: App,
  linkText: string,
  sourcePath: string,
  visited: Set<string>,
): Promise<string | null> {
  const target = resolveWikilinkReadTarget(app, linkText, sourcePath)
  if (!target) return null

  // Keyed by file *and* subpath, so two different sections of the same note
  // both expand, while any cycle — which must revisit the identical target —
  // still terminates on its second visit. Depth itself is unbounded: nesting
  // one context file inside another is a legitimate way to organize them.
  const key = `${target.file.path}::${subpathKeyOf(linkText)}`
  if (visited.has(key)) return null
  visited.add(key)

  let body: string | null
  try {
    body = await readEmbedBody(app, target)
  } catch {
    // An unreadable file leaves the link text in place, which is what the
    // model (and therefore the user) will see.
    return null
  }
  if (body === null) return null

  return expand(app, body, target.file.path, visited)
}

/**
 * Replaces every resolvable `![[Note]]` / `![[Note#Section]]` in `content`
 * with that note's text, recursively.
 *
 * Anything that does not resolve to a markdown file — a missing note, a
 * non-markdown target, an unresolved `#section`, an already-expanded target —
 * is left exactly as written. There is no fallback and no error reporting:
 * the unexpanded link reaches the model, which reports the gap in the one
 * place the user is already looking.
 *
 * Each call gets its own `visited` set, so the global system prompt and an
 * agent's system prompt are expanded independently — the same note embedded in
 * both appears in both, matching what the user wrote in each field.
 */
export function expandPromptEmbeds(app: App, content: string): Promise<string> {
  return expand(app, content, '', new Set<string>())
}
