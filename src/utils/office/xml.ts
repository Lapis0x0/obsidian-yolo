export function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g,
    (_, entity) => {
      if (entity === 'amp') return '&'
      if (entity === 'lt') return '<'
      if (entity === 'gt') return '>'
      if (entity === 'quot') return '"'
      if (entity === 'apos') return "'"
      if (entity.startsWith('#x')) {
        return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
      }
      if (entity.startsWith('#')) {
        return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
      }
      return `&${entity};`
    },
  )
}

export function getTagContents(xml: string, tagName: string): string[] {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`,
    'g',
  )
  const results: string[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml)) !== null) {
    results.push(match[1] ?? '')
  }
  return results
}

export function getFirstTagContent(
  xml: string,
  tagName: string,
): string | null {
  return getTagContents(xml, tagName)[0] ?? null
}

export function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const pattern = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw)) !== null) {
    const key = match[1]
    const value = match[3] ?? match[4] ?? ''
    if (key) {
      attrs[key] = decodeXmlEntities(value)
    }
  }
  return attrs
}

export function stripXmlTags(xml: string): string {
  return xml.replace(/<[^>]+>/g, '')
}
