export type MarkdownEntryType = 'kp' | 'card' | 'ex'

export type MarkdownEntry = {
  type: MarkdownEntryType
  uuid: string
  kpUuid?: string
  title: string
  body: string
}

const HEADING_RE = /^##\s+(.+)$/gm
const COMMENT_RE =
  /<!--\s*(kp|card|ex):([0-9a-fA-F]{8})(?:\s+kp:([0-9a-fA-F]{8}))?\s*-->/

export function scanMarkdownEntries(content: string): MarkdownEntry[] {
  const headings = [...content.matchAll(HEADING_RE)]
  const entries: MarkdownEntry[] = []

  for (let i = 0; i < headings.length; i += 1) {
    const match = headings[i]
    const start = match.index ?? 0
    const nextStart = headings[i + 1]?.index ?? content.length
    const block = content.slice(start, nextStart).trim()
    const titleLine = match[1]?.trim() ?? ''
    const comment = titleLine.match(COMMENT_RE)
    const type = comment?.[1] ?? 'kp'
    const uuid = comment?.[2]?.toLowerCase() ?? ''
    const kpUuid = comment?.[3]?.toLowerCase()
    const title = titleLine.replace(COMMENT_RE, '').trim()
    const bodyStart = block.indexOf('\n')
    const body = bodyStart === -1 ? '' : block.slice(bodyStart + 1).trim()

    entries.push({
      type: type as MarkdownEntryType,
      uuid,
      ...(kpUuid ? { kpUuid } : {}),
      title,
      body,
    })
  }

  return entries
}
