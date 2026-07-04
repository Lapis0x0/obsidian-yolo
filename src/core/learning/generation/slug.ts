export function createUniqueSlug(
  title: string,
  existingSlugs: Iterable<string>,
): string {
  const base = createSlug(title)
  const used = new Set(existingSlugs)
  if (!used.has(base)) return base

  let index = 2
  while (used.has(`${base}-${index}`)) {
    index += 1
  }
  return `${base}-${index}`
}

export function createSlug(title: string): string {
  const trimmed = title.trim()
  if (!trimmed) return 'untitled'

  const sanitized = trimmed.replace(/[/\\:*?"<>|]+/g, '-').trim()
  if (!sanitized) return 'untitled'
  return sanitized
}
